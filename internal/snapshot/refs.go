package snapshot

import (
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"

	pg "github.com/pganalyze/pg_query_go/v6"
	pgquery "github.com/wasilibs/go-pgquery"
)

const sqlWhitespace = " \t\n\r\f\v"

// Parse a SQL name one identifier at a time so quoted dots stay in the name.
func qualifiedColumn(input string) ([]string, error) {
	var names []string
	if !utf8.ValidString(input) || strings.ContainsRune(input, 0) {
		return nil, fmt.Errorf("--column expects a SQL-qualified schema.table.column")
	}
	text := strings.Trim(input, sqlWhitespace)
	for len(text) > 0 {
		var name strings.Builder
		if text[0] == '"' {
			text = text[1:]
			closed := false
			for len(text) > 0 {
				i := strings.IndexByte(text, '"')
				if i < 0 {
					break
				}
				name.WriteString(text[:i])
				text = text[i+1:]
				if !strings.HasPrefix(text, "\"") {
					closed = true
					break
				}
				name.WriteByte('"')
				text = text[1:]
			}
			if !closed {
				break
			}
		} else if strings.HasPrefix(text, `U&"`) || strings.HasPrefix(text, `u&"`) {
			decoded, end := unicodeIdentifier(text)
			if end == 0 {
				break
			}
			name.WriteString(decoded)
			text = text[end:]
		} else {
		unquoted:
			for len(text) > 0 {
				c := text[0]
				switch {
				case c >= 'A' && c <= 'Z':
					name.WriteByte(c + ('a' - 'A'))
				case c >= 'a' && c <= 'z', c == '_', c >= utf8.RuneSelf,
					name.Len() > 0 && (c >= '0' && c <= '9' || c == '$'):
					name.WriteByte(c)
				default:
					break unquoted
				}
				text = text[1:]
			}
		}
		if name.Len() == 0 {
			break
		}
		names = append(names, name.String())
		text = strings.Trim(text, sqlWhitespace)
		if text == "" && len(names) == 3 {
			return names, nil
		}
		if !strings.HasPrefix(text, ".") {
			break
		}
		text = strings.Trim(text[1:], sqlWhitespace)
	}
	return nil, fmt.Errorf("--column expects a SQL-qualified schema.table.column")
}

func unicodeIdentifier(text string) (string, int) {
	scanned, err := pgquery.Scan(text)
	if err != nil || len(scanned.Tokens) == 0 || scanned.Tokens[0].Token != pg.Token_UIDENT {
		return "", 0
	}
	tokens := scanned.Tokens
	end := tokens[0].End
	if len(tokens) > 1 && tokens[1].Token == pg.Token_UESCAPE {
		if len(tokens) < 3 || tokens[2].Token != pg.Token_SCONST {
			return "", 0
		}
		end = tokens[2].End
	}
	// Decode the escape form with PostgreSQL, using only the identifier tokens.
	tree, err := pgquery.Parse("SELECT " + text[:end])
	if err != nil {
		return "", 0
	}
	target := tree.Stmts[0].Stmt.GetSelectStmt().TargetList[0].GetResTarget()
	return target.Val.GetColumnRef().Fields[0].GetString_().Sval, int(end)
}

type ReferenceEvidence struct {
	Evidence
	Definition string `json:"definition,omitempty"`
}
type Hop struct {
	Relationship
	SourceName string              `json:"sourceName"`
	TargetName string              `json:"targetName"`
	Evidence   []ReferenceEvidence `json:"evidence"`
}
type References struct {
	Database  string  `json:"database"`
	Column    Column  `json:"column,omitzero"`
	Object    Object  `json:"object,omitzero"`
	Paths     [][]Hop `json:"paths"`
	direction string
}

var plainReferenceIdentifier = regexp.MustCompile(`^[a-z_][a-z0-9_$]*$`)

func referenceIdentifier(name string) string {
	if plainReferenceIdentifier.MatchString(name) {
		return name
	}
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func routineReferenceName(name string) string {
	// Snapshots store the raw name followed by SQL-formatted identity arguments.
	// Walk back from the closing parenthesis because the raw name can contain any character.
	if !strings.HasSuffix(name, ")") {
		return referenceIdentifier(name)
	}
	depth := 1
	quoted := false
	for i := len(name) - 2; i >= 0; i-- {
		switch {
		case name[i] == '"':
			quoted = !quoted
		case !quoted && name[i] == ')':
			depth++
		case !quoted && name[i] == '(':
			depth--
			if depth == 0 {
				return referenceIdentifier(name[:i]) + name[i:]
			}
		}
	}
	return referenceIdentifier(name)
}

type ReferenceQuery struct {
	Column, Object string
	Depth          int
	Direction      string
}

func (s *Snapshot) References(selector string, depth int) (References, error) {
	return s.QueryReferences(ReferenceQuery{Column: selector, Depth: depth, Direction: "incoming"})
}

// ObjectReferences follows edges to the exact object named by its viewer label.
func (s *Snapshot) ObjectReferences(label string, depth int) (References, error) {
	return s.QueryReferences(ReferenceQuery{Object: label, Depth: depth, Direction: "incoming"})
}

func (s *Snapshot) QueryReferences(q ReferenceQuery) (References, error) {
	if (q.Column == "") == (q.Object == "") {
		return References{}, fmt.Errorf("refs requires exactly one of --column or --object")
	}
	if q.Direction != "incoming" && q.Direction != "outgoing" {
		return References{}, fmt.Errorf("--direction must be incoming or outgoing")
	}
	if q.Depth != 1 && q.Depth != 2 {
		return References{}, fmt.Errorf("--depth must be 1 or 2")
	}
	selector := q.Object
	var columnNames []string
	if q.Column != "" {
		selector = q.Column
		var err error
		columnNames, err = qualifiedColumn(selector)
		if err != nil {
			return References{}, err
		}
	}
	labels := map[string]string{}
	owners := map[string]Object{}
	result := References{Database: s.Database, Paths: [][]Hop{}, direction: q.Direction}
	var endpoint string
	for _, o := range s.Objects {
		owners[o.ID] = o
	}
	for _, o := range s.Objects {
		var name string
		if o.Kind == "function" || o.Kind == "procedure" {
			name = routineReferenceName(o.Name)
		} else {
			name = referenceIdentifier(o.Name)
		}
		prefix := referenceIdentifier(o.Schema)
		if o.ParentID != "" && (o.Kind == "constraint" || o.Kind == "trigger" || o.Kind == "policy") {
			parent := owners[o.ParentID]
			prefix = referenceIdentifier(parent.Schema) + "." + referenceIdentifier(parent.Name)
		}
		labels[o.ID] = prefix + "." + name
		if columnNames == nil && labels[o.ID] == selector {
			if endpoint != "" {
				return References{}, fmt.Errorf("ambiguous object label %q (%s and %s)", selector, result.Object.Kind, o.Kind)
			}
			endpoint, result.Object = o.ID, o
		}
	}
	for _, c := range s.Columns {
		owner := owners[c.ObjectID]
		labels[c.ID] = labels[c.ObjectID] + "." + referenceIdentifier(c.Name)
		if columnNames != nil && owner.Schema == columnNames[0] && owner.Name == columnNames[1] && c.Name == columnNames[2] {
			endpoint, result.Column = c.ID, c
		}
	}
	if endpoint == "" {
		if columnNames == nil {
			return References{}, fmt.Errorf("object not found: %s", selector)
		}
		return References{}, fmt.Errorf("column not found: %s", selector)
	}
	defs := map[string]string{}
	for _, d := range s.Definitions {
		defs[d.OwnerID] = d.SQL
	}
	evidence := map[string][]ReferenceEvidence{}
	for _, e := range s.Evidence {
		r := ReferenceEvidence{Evidence: e}
		if e.Snippet == "" {
			r.Definition = defs[e.OwnerID]
		}
		evidence[e.RelationshipID] = append(evidence[e.RelationshipID], r)
	}
	type step struct {
		next string
		hop  Hop
	}
	adjacent := map[string][]step{}
	for _, r := range s.Relationships {
		ev := evidence[r.ID]
		if ev == nil {
			ev = []ReferenceEvidence{}
		}
		from, to := r.Target, r.Source
		if q.Direction == "outgoing" {
			from, to = r.Source, r.Target
		}
		adjacent[from] = append(adjacent[from], step{to, Hop{r, labels[r.Source], labels[r.Target], ev}})
	}
	for _, a := range adjacent[endpoint] {
		result.Paths = append(result.Paths, []Hop{a.hop})
		if q.Depth == 2 && a.next != endpoint {
			for _, b := range adjacent[a.next] {
				if b.next != a.next && b.next != endpoint {
					result.Paths = append(result.Paths, []Hop{a.hop, b.hop})
				}
			}
		}
	}
	return result, nil
}
func (r References) Print(w io.Writer) {
	if len(r.Paths) == 0 {
		direction := r.direction
		if direction == "" {
			direction = "incoming"
		}
		fmt.Fprintf(w, "No recorded %s references.\n", direction)
		return
	}
	first := r.Paths[0][0]
	label := first.TargetName
	if r.direction == "outgoing" {
		label = first.SourceName
	}
	fmt.Fprintln(w, label)
	for _, p := range r.Paths {
		var labels []string
		for _, hop := range p {
			labels = append(labels, fmt.Sprintf("%s %s %s [%s]", hop.SourceName, hop.Kind, hop.TargetName, hop.Provenance))
		}
		fmt.Fprintln(w, strings.Join(labels, "  /  "))
		for _, hop := range p {
			for _, e := range hop.Evidence {
				sql := e.Snippet
				if sql == "" {
					sql = e.Definition
				}
				fmt.Fprintln(w, "  "+sql)
			}
		}
	}
}
