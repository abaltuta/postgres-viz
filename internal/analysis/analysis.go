package analysis

import (
	"context"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"postgres-viz/internal/snapshot"
)

// libpg_query's JSON represents some singular fields unwrapped, while repeated
// fields contain tagged nodes. Keep access to that wire format in these helpers.
type node = map[string]any

func obj(v any) node { n, _ := v.(map[string]any); return n }
func child(v any, path ...string) node {
	for _, key := range path {
		v = obj(v)[key]
	}
	return obj(v)
}
func str(n node, key string) string { s, _ := n[key].(string); return s }
func items(v any) []any             { list, _ := v.([]any); return list }
func num(n node, key string) int    { v, _ := n[key].(float64); return int(v) }
func names(v any) []string {
	var out []string
	for _, f := range items(v) {
		if child(f, "A_Star") != nil {
			out = append(out, "*")
		} else if s := str(child(f, "String"), "sval"); s != "" {
			out = append(out, s)
		}
	}
	return out
}
func last[T any](a []T) T {
	if len(a) > 0 {
		return a[len(a)-1]
	}
	var zero T
	return zero
}
func unique(ids []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, id := range ids {
		if id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

type catalog struct {
	s          *snapshot.Snapshot
	objs       map[string]snapshot.Object
	relations  map[string][]string
	functions  map[string][]string
	signatures map[string][]snapshot.CallParameter
	cols       map[string][]snapshot.Column
	parents    map[string]string
	edges      map[string]bool
	triggers   map[string][]string
}

func index(s *snapshot.Snapshot, routines []snapshot.Routine) *catalog {
	c := &catalog{
		s: s, objs: map[string]snapshot.Object{},
		relations: map[string][]string{}, functions: map[string][]string{},
		signatures: map[string][]snapshot.CallParameter{},
		cols:       map[string][]snapshot.Column{}, parents: map[string]string{},
		edges: map[string]bool{}, triggers: map[string][]string{},
	}
	for _, o := range s.Objects {
		c.objs[o.ID] = o
		switch o.Kind {
		case "table", "view", "matview", "foreign":
			c.relations[o.Name] = append(c.relations[o.Name], o.ID)
		}
	}
	for _, r := range routines {
		c.functions[r.Name] = append(c.functions[r.Name], r.ID)
		c.signatures[r.ID] = r.CallParameters
	}
	for _, col := range s.Columns {
		c.cols[col.ObjectID] = append(c.cols[col.ObjectID], col)
		c.parents[col.ID] = col.ObjectID
	}
	for _, cols := range c.cols {
		slices.SortFunc(cols, func(x, y snapshot.Column) int { return x.Position - y.Position })
	}
	for _, e := range s.Relationships {
		c.edges[e.ID] = true
		if e.Kind == "executes" {
			if p := c.objs[e.Source].ParentID; p != "" {
				c.triggers[e.Target] = append(c.triggers[e.Target], p)
			}
		}
	}
	return c
}

type analyzer struct {
	*catalog
	p             *parser
	r             snapshot.Routine
	variables     map[string]string
	conflict      string
	triggerRels   []string
	view          bool
	sql           string
	offset, delta int
	// A known column replaces a relation-wide reference of the same kind.
	whole, precise, uncertain map[string]bool
}

func (a *analyzer) matches(index map[string][]string, parts []string) []string {
	return a.schemaMatches(index[last(parts)], parts)
}
func (a *analyzer) schemaMatches(ids []string, parts []string) []string {
	if len(parts) == 0 {
		return nil
	}
	var schemas []string
	if len(parts) > 1 {
		schemas = []string{parts[len(parts)-2]}
	} else {
		schemas = []string{a.r.Schema, "public"}
	}
	for _, schema := range schemas {
		var selected []string
		for _, id := range ids {
			if a.objs[id].Schema == schema {
				selected = append(selected, id)
			}
		}
		if len(selected) > 0 {
			return selected
		}
	}
	if len(parts) > 1 {
		return nil
	}
	return ids
}
func (a *analyzer) rel(name, schema string) string {
	parts := []string{name}
	if schema != "" {
		parts = []string{schema, name}
	}
	ids := a.matches(a.relations, parts)
	if len(ids) == 1 {
		return ids[0]
	}
	return ""
}
func (a *analyzer) base(id string) binding {
	b := binding{unknownWidth: id == ""}
	for _, c := range a.cols[id] {
		b.columns = append(b.columns, output{c.Name, []string{c.ID}})
	}
	return b
}
func (a *analyzer) addEdge(kind, target, origin string) string {
	if target == "" {
		return ""
	}
	id := kind + "|" + a.r.ID + "|" + target
	if !a.edges[id] {
		a.s.Relationships = append(a.s.Relationships, snapshot.Relationship{ID: id, Kind: kind, Source: a.r.ID, Target: target, Provenance: origin})
		a.edges[id] = true
	}
	return id
}
func (a *analyzer) diagnostic(reason, identifier, snippet string, candidates []string) {
	a.s.Diagnostics.Unresolved = append(a.s.Diagnostics.Unresolved, snapshot.Diagnostic{
		OwnerID: a.r.ID, Identifier: identifier, Reason: reason,
		Snippet: snippet, CandidateIDs: unique(candidates),
	})
}
func (a *analyzer) recordCall(parts, ids []string, origin string) {
	if len(ids) > 1 {
		label := strings.Join(parts, ".")
		a.diagnostic("ambiguous", label, label+"(...)", ids)
		return
	}
	if len(ids) == 1 && ids[0] != a.r.ID && !a.view {
		a.addEdge("calls", ids[0], origin)
	}
}
func (a *analyzer) table(kind, id string) {
	if id != "" && !a.view {
		a.whole[kind+"|"+id] = true
	}
}
func (a *analyzer) finish() {
	for _, key := range slices.Sorted(maps.Keys(a.whole)) {
		kind, id, _ := strings.Cut(key, "|")
		if a.uncertain[key] {
			a.addEdge(kind, id, "fallback")
		} else if !a.precise[key] {
			a.addEdge(kind, id, "parsed")
		}
	}
}

const ident = `(?:"(?:[^"]|"")*"|[\pL_][\pL\pN_$]*)`

var columnText = regexp.MustCompile(`^(?:` + ident + `|\*)(?:\s*\.\s*(?:` + ident + `|\*))*`)
var positionalColumnText = regexp.MustCompile(`^\$[0-9]+((?:\s*\))*)\s*\.\s*(?:` + ident + `|\*)`)

func columnSpan(sql string, pos int) (int, int) {
	if sql[pos] != '$' {
		return pos, pos + len(columnText.FindString(sql[pos:]))
	}
	match := positionalColumnText.FindStringSubmatch(sql[pos:])
	if match == nil {
		return pos, pos
	}
	start := pos
	for range strings.Count(match[1], ")") {
		prefix := strings.TrimRight(sql[:start], " \t\r\n\f\v")
		if !strings.HasSuffix(prefix, "(") {
			return pos, pos
		}
		start = len(prefix) - 1
	}
	return start, pos + len(match[0])
}

func units(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}
func snippetAt(s string, location int) string {
	if location < 0 || location > len(s) {
		return ""
	}
	left := strings.LastIndexByte(s[:location], '\n') + 1
	right := strings.IndexByte(s[location:], '\n')
	if right < 0 {
		right = len(s) - location
	}
	return clip(strings.Join(strings.Fields(s[left:location+right]), " "), 240)
}
func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
func (a *analyzer) column(kind, id string, loc int, identifier string) {
	parent := a.parents[id]
	if parent == "" {
		return
	}
	if a.view {
		kind = "selects"
	}
	a.precise[kind+"|"+parent] = true
	edge := a.addEdge(kind, id, "parsed")
	if loc < 0 {
		return
	}
	pos := loc + a.delta
	snippet := snippetAt(a.sql, pos)
	if snippet == "" {
		snippet = identifier
	}
	e := snapshot.Evidence{ID: fmt.Sprintf("e%d", len(a.s.Evidence)), OwnerID: a.r.ID, RelationshipID: edge, Provenance: "parsed", Snippet: snippet}
	if a.offset >= 0 && pos >= 0 && pos < len(a.sql) && utf8.ValidString(a.sql[:pos]) {
		left, right := columnSpan(a.sql, pos)
		if right > left {
			start := units(a.r.Definition[:a.offset]) + units(a.sql[:left])
			end := start + units(a.sql[left:right])
			e.Start, e.End = &start, &end
		}
	}
	a.s.Evidence = append(a.s.Evidence, e)
}
func (a *analyzer) source(sql string, delta int, exact bool) {
	a.sql, a.delta, a.offset = sql, delta, -1
	if exact {
		i := strings.Index(a.r.Definition, sql)
		if i >= 0 && i == strings.LastIndex(a.r.Definition, sql) {
			a.offset = i
		}
	}
}

func Analyze(ctx context.Context, s *snapshot.Snapshot, routines []snapshot.Routine) error {
	c := index(s, routines)
	p := &parser{ctx: ctx}
	defer p.close()
	fallbacks := 0
	owners := slices.Clone(routines)
	for _, d := range s.Definitions {
		o := c.objs[d.OwnerID]
		if o.Kind == "view" || o.Kind == "matview" {
			owners = append(owners, snapshot.Routine{ID: o.ID, Schema: o.Schema, Name: o.Name, Language: "sql", Body: d.SQL, Definition: d.SQL})
		}
	}
	for _, r := range owners {
		p.version = r.ServerVersion
		if err := ctx.Err(); err != nil {
			return err
		}
		if r.HasSQLBody || (r.Language != "sql" && r.Language != "plpgsql") {
			continue
		}
		if r.Definition == "" {
			r.Definition = r.Body
		}
		a := &analyzer{
			catalog: c, p: p, r: r, variables: map[string]string{},
			triggerRels: c.triggers[r.ID], view: c.objs[r.ID].Kind == "view" || c.objs[r.ID].Kind == "matview",
			whole: map[string]bool{}, precise: map[string]bool{}, uncertain: map[string]bool{},
		}
		if err := a.analyze(); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if !a.view {
				a.fallback()
				fallbacks++
			}
		}
		a.finish()
	}
	if fallbacks > 0 {
		s.Diagnostics.Warnings = append(s.Diagnostics.Warnings, fmt.Sprintf("%d routines required fallback analysis", fallbacks))
	}
	if n := len(s.Diagnostics.Unresolved); n > 0 {
		s.Diagnostics.Warnings = append(s.Diagnostics.Warnings, fmt.Sprintf("%d unresolved SQL references", n))
	}
	return ctx.Err()
}
