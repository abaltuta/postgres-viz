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
	Database string  `json:"database"`
	Column   Column  `json:"column"`
	Paths    [][]Hop `json:"paths"`
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

func (s *Snapshot) References(selector string, depth int) (References, error) {
	names, err := qualifiedColumn(selector)
	if err != nil {
		return References{}, err
	}
	if depth != 1 && depth != 2 {
		return References{}, fmt.Errorf("--depth must be 1 or 2")
	}
	labels := map[string]string{}
	owners := map[string]Object{}
	var column Column
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
	}
	for _, c := range s.Columns {
		owner := owners[c.ObjectID]
		labels[c.ID] = labels[c.ObjectID] + "." + referenceIdentifier(c.Name)
		if owner.Schema == names[0] && owner.Name == names[1] && c.Name == names[2] {
			column = c
		}
	}
	if column.ID == "" {
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
	incoming := map[string][]Hop{}
	for _, r := range s.Relationships {
		ev := evidence[r.ID]
		if ev == nil {
			ev = []ReferenceEvidence{}
		}
		incoming[r.Target] = append(incoming[r.Target], Hop{r, labels[r.Source], labels[r.Target], ev})
	}
	result := References{s.Database, column, [][]Hop{}}
	for _, a := range incoming[column.ID] {
		result.Paths = append(result.Paths, []Hop{a})
		if depth == 2 && a.Source != column.ID {
			for _, b := range incoming[a.Source] {
				if b.Source != a.Source && b.Source != column.ID {
					result.Paths = append(result.Paths, []Hop{a, b})
				}
			}
		}
	}
	return result, nil
}
func (r References) Print(w io.Writer) {
	if len(r.Paths) == 0 {
		fmt.Fprintln(w, "No recorded incoming references.")
		return
	}
	fmt.Fprintln(w, r.Paths[0][0].TargetName)
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
