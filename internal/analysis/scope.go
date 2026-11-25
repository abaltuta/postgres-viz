package analysis

import (
	"maps"
	"slices"
	"strconv"
	"strings"
)

type output struct {
	name string
	ids  []string
}
type binding struct {
	columns      []output
	unknownWidth bool
}

func (b *binding) append(other binding) {
	b.columns = append(b.columns, other.columns...)
	b.unknownWidth = b.unknownWidth || other.unknownWidth
}

// VALUES rows and set operations combine corresponding output columns.
func (b *binding) mergeRow(other binding) {
	b.unknownWidth = b.unknownWidth || other.unknownWidth || len(b.columns) != len(other.columns)
	for i := range min(len(b.columns), len(other.columns)) {
		b.columns[i].ids = unique(append(b.columns[i].ids, other.columns[i].ids...))
	}
}

func (b binding) lookup(name string) ([]string, int) {
	var ids []string
	hits := 0
	for _, c := range b.columns {
		if c.name == name {
			hits++
			ids = append(ids, c.ids...)
		}
	}
	return unique(ids), hits
}
func (b binding) refs() []string {
	var ids []string
	for _, c := range b.columns {
		ids = append(ids, c.ids...)
	}
	return unique(ids)
}
func (b binding) renamed(aliases []string) binding {
	if len(aliases) == 0 {
		return b
	}
	b.columns = slices.Clone(b.columns)
	for i, name := range aliases {
		if i >= len(b.columns) {
			break
		}
		b.columns[i].name = name
	}
	return b
}

type scope struct {
	parent  *scope
	names   []rangeName
	ctes    map[string]*cteBinding
	sources []binding
}

// Recursive WITH exposes sibling names before their queries have been visited.
type cteBinding struct {
	columns binding
	resolve func() binding
}

func (c *cteBinding) get() binding {
	if resolve := c.resolve; resolve != nil {
		c.resolve = nil // Self-references see the current anchor binding.
		c.columns = resolve()
	}
	return c.columns
}

type rangeName struct {
	name, schema string
	columns      binding
}

func newScope(parent *scope) *scope {
	return &scope{parent: parent, ctes: map[string]*cteBinding{}}
}
func (s *scope) cte(name string) (binding, bool) {
	for ; s != nil; s = s.parent {
		if b, ok := s.ctes[name]; ok {
			return b.get(), true
		}
	}
	return binding{}, false
}
func (s *scope) qualified(schema, name string) []binding {
	for ; s != nil; s = s.parent {
		var matches []binding
		for _, source := range s.names {
			if source.name == name && (schema == "" || schema == source.schema) {
				matches = append(matches, source.columns)
			}
		}
		if len(matches) > 0 {
			return matches
		}
	}
	return nil
}
func (s *scope) local(name string) ([]string, int) {
	var ids []string
	total := 0
	for _, b := range s.sources {
		c, n := b.lookup(name)
		total += n
		ids = append(ids, c...)
	}
	return unique(ids), total
}
func (s *scope) unqualified(name string) ([]string, int) {
	for ; s != nil; s = s.parent {
		ids, total := s.local(name)
		if total > 0 {
			return ids, total
		}
	}
	return nil, 0
}
func (s *scope) star() binding {
	var b binding
	for _, source := range s.sources {
		b.append(source)
	}
	return b
}

func expandsStar(fields any) bool {
	return child(last(items(fields)), "A_Star") != nil
}

func (a *analyzer) columnRef(n node, s *scope) (binding, []string) {
	parts := names(n["fields"])
	if len(parts) == 0 {
		return binding{unknownWidth: true}, nil
	}
	name, label, loc := last(parts), strings.Join(parts, "."), num(n, "location")
	star := expandsStar(n["fields"])
	var source binding
	var ids, candidates []string
	var hits int
	if len(parts) == 1 {
		if star {
			source = s.star()
			hits = 1
		} else {
			ids, hits = s.unqualified(name)
			// PostgreSQL tries columns in all visible scopes before a whole-row name.
			if hits == 0 {
				matches := s.qualified("", name)
				hits = len(matches)
				for _, row := range matches {
					ids = append(ids, row.refs()...)
				}
			}
			if _, ok := a.variables[name]; ok {
				if hits == 0 || a.conflict == "use_variable" {
					return binding{unknownWidth: true}, nil
				}
				if a.conflict == "error" {
					hits++
				}
			}
		}
	} else {
		qual := parts[len(parts)-2]
		var schema string
		if len(parts) >= 3 {
			schema = parts[len(parts)-3]
		}
		positional := n["positional"] == true
		var matches []binding
		if positional {
			matches = []binding{a.base(a.variables[qual])}
		} else {
			matches = s.qualified(schema, qual)
		}
		triggerRow := false
		if len(parts) == 2 && !positional {
			var records []binding
			if (qual == "new" || qual == "old") && len(a.triggerRels) > 0 {
				for _, id := range a.triggerRels {
					records = append(records, a.base(id))
				}
			} else if row, exists := a.variables[qual]; exists {
				if row == "" {
					if len(matches) == 0 {
						return binding{unknownWidth: true}, nil
					}
				} else {
					records = append(records, a.base(row))
				}
			}
			if len(records) > 0 {
				hasField := func(b binding) bool {
					if star {
						return true
					}
					_, n := b.lookup(name)
					return n > 0
				}
				// PL/pgSQL considers a qualified column and a record field
				// independently. A range name alone doesn't resolve the column.
				useRecord := a.conflict == "use_variable" || len(matches) == 0 ||
					(a.conflict != "" && !slices.ContainsFunc(matches, hasField))
				if a.conflict == "error" && !slices.ContainsFunc(records, hasField) {
					// Looking up an absent field of a known PL record raises
					// undefined_column before the ambiguity check.
					useRecord = true
				}
				switch {
				case useRecord:
					matches = records
					triggerRow = (qual == "new" || qual == "old") && len(a.triggerRels) > 0
				case a.conflict == "error":
					matches = append(matches, records...)
				}
			}
		}
		for _, b := range matches {
			if star {
				source.append(b)
				hits++
				continue
			}
			refs, n := b.lookup(name)
			ids = append(ids, refs...)
			hits += n
			if n == 0 && !triggerRow {
				for _, id := range b.refs() {
					candidates = append(candidates, a.parents[id])
				}
			}
		}
		if triggerRow && hits > 0 {
			source.unknownWidth = source.unknownWidth || hits > 1
			hits = 1
		} else if !triggerRow && len(matches) > 1 {
			hits = len(matches)
		}
	}
	if star {
		ids = source.refs()
	}
	if !a.readReference(label, loc, ids, hits, candidates) {
		return binding{unknownWidth: true}, nil
	}
	return source, ids
}

// PostgreSQL parses (alias).field and $1.field as indirection. Resolve a
// single field through the operand's binding so sibling columns stay unread.
func (a *analyzer) directColumn(v any, s *scope) node {
	if cr := child(v, "ColumnRef"); cr != nil {
		return cr
	}
	ind := child(v, "A_Indirection")
	fields := items(ind["indirection"])
	if len(fields) != 1 || len(names(fields)) == 0 {
		return nil
	}
	if p := child(ind, "arg", "ParamRef"); p != nil {
		name := "$" + strconv.Itoa(num(p, "number"))
		if a.variables[name] == "" {
			return nil
		}
		return node{
			"fields":     []any{node{"String": node{"sval": name}}, fields[0]},
			"location":   p["location"],
			"positional": true,
		}
	}
	cr := child(ind, "arg", "ColumnRef")
	parts := names(cr["fields"])
	if len(parts) != 1 {
		return nil
	}
	name := parts[0]
	if _, hits := s.unqualified(name); hits > 0 || len(s.qualified("", name)) == 0 {
		return nil
	}
	if _, variable := a.variables[name]; variable && a.conflict != "use_column" {
		return nil
	}
	return node{"fields": []any{items(cr["fields"])[0], fields[0]}, "location": cr["location"]}
}

func (a *analyzer) readReference(label string, loc int, ids []string, hits int, candidates []string) bool {
	if hits != 1 {
		reason := "missing"
		if hits > 1 {
			reason = "ambiguous"
			candidates = ids
		}
		snippet := snippetAt(a.sql, loc+a.delta)
		if snippet == "" {
			snippet = label
		}
		a.diagnostic(reason, label, snippet, candidates)
		if !a.view {
			for _, id := range candidates {
				if p := a.parents[id]; p != "" {
					id = p
				}
				a.table("reads", id)
				a.uncertain["reads|"+id] = true
			}
		}
		return false
	}
	for _, id := range unique(ids) {
		a.column("reads", id, loc, label)
	}
	return true
}

func (a *analyzer) expr(v any, s *scope) []string {
	switch n := v.(type) {
	case []any:
		var ids []string
		for _, item := range n {
			ids = append(ids, a.expr(item, s)...)
		}
		return unique(ids)
	case map[string]any:
		if c := a.directColumn(n, s); c != nil {
			_, ids := a.columnRef(c, s)
			return ids
		}
		if q := child(n, "SelectStmt"); q != nil {
			return a.selectStmt(q, s).refs()
		}
		if f := child(n, "FuncCall"); f != nil {
			a.parsedCall(f, "function")
		}
		var ids []string
		for _, key := range slices.Sorted(maps.Keys(n)) {
			ids = append(ids, a.expr(n[key], s)...)
		}
		return unique(ids)
	}
	return nil
}

func jsonTableOutputs(columns any) binding {
	var b binding
	for _, item := range items(columns) {
		c := child(item, "JsonTableColumn")
		if str(c, "coltype") == "JTC_NESTED" {
			b.append(jsonTableOutputs(c["columns"]))
		} else {
			b.columns = append(b.columns, output{name: str(c, "name")})
		}
	}
	return b
}

func (a *analyzer) from(item node, s *scope) binding {
	var b binding
	var alias node
	var defaultName, schema string
	switch {
	case child(item, "RangeTableSample") != nil:
		sample := child(item, "RangeTableSample")
		a.expr(sample["args"], s)
		a.expr(sample["repeatable"], s)
		return a.from(child(sample, "relation"), s)
	case child(item, "RangeVar") != nil:
		r := child(item, "RangeVar")
		alias = child(r, "alias")
		defaultName = str(r, "relname")
		schema = str(r, "schemaname")
		var cte bool
		if schema == "" {
			b, cte = s.cte(defaultName)
		}
		if !cte {
			id := a.sqlRelation(r)
			a.table("reads", id)
			b = a.base(id)
			schema = a.objs[id].Schema
		}
	case child(item, "RangeSubselect") != nil:
		r := child(item, "RangeSubselect")
		alias = child(r, "alias")
		parent := s
		if r["lateral"] != true {
			// Same-level CTEs are visible, but earlier FROM items are not.
			parent = &scope{parent: s.parent, ctes: s.ctes}
		}
		b = a.statement(child(r, "subquery"), parent)
	case child(item, "RangeFunction") != nil:
		r := child(item, "RangeFunction")
		alias = child(r, "alias")
		a.expr(r["functions"], s)
		for _, name := range names(alias["colnames"]) {
			b.columns = append(b.columns, output{name, nil})
		}
		defs := items(r["coldeflist"])
		for _, c := range defs {
			b.columns = append(b.columns, output{str(child(c, "ColumnDef"), "colname"), nil})
		}
		// A list of aliases can name only a prefix of a function's outputs.
		b.unknownWidth = len(defs) == 0
	case child(item, "JsonTable") != nil:
		r := child(item, "JsonTable")
		alias = child(r, "alias")
		defaultName = "json_table"
		a.expr(r, s)
		b = jsonTableOutputs(r["columns"])
	case child(item, "JoinExpr") != nil:
		j := child(item, "JoinExpr")
		alias = child(j, "alias")
		// The operands share the current query level for lateral references.
		locals := *s
		locals.names = slices.Clip(s.names)
		locals.sources = slices.Clip(s.sources)
		l := a.from(child(j, "larg"), &locals)
		locals.sources = append(locals.sources, l)
		r := a.from(child(j, "rarg"), &locals)
		// ON sees only the joined operands and enclosing queries.
		locals.names = locals.names[len(s.names):]
		locals.sources = []binding{l, r}
		a.expr(j["quals"], &locals)
		keys := names(j["usingClause"])
		if j["isNatural"] == true {
			for _, col := range l.columns {
				if _, hits := r.lookup(col.name); hits > 0 {
					keys = append(keys, col.name)
				}
			}
		}
		var merged binding
		for _, name := range unique(keys) {
			left, _ := l.lookup(name)
			right, _ := r.lookup(name)
			ids := unique(append(left, right...))
			for _, id := range ids {
				a.column("reads", id, -1, name)
			}
			merged.columns = append(merged.columns, output{name, ids})
		}
		b.columns = slices.Clone(merged.columns)
		b.unknownWidth = l.unknownWidth || r.unknownWidth
		for _, side := range []binding{l, r} {
			for _, col := range side.columns {
				if j["isNatural"] == true && col.name == "" {
					// An inferred output name can affect NATURAL JOIN's merged columns.
					b.unknownWidth = true
				}
				if !slices.Contains(keys, col.name) {
					b.columns = append(b.columns, col)
				}
			}
		}
		if alias == nil {
			s.names = append(s.names, locals.names...)
		}
		if usingAlias := str(child(j, "join_using_alias"), "aliasname"); usingAlias != "" {
			s.names = append(s.names, rangeName{name: usingAlias, columns: merged})
		}
	default:
		a.expr(item, s)
		b.unknownWidth = true
	}
	b = b.renamed(names(alias["colnames"]))
	name := str(alias, "aliasname")
	if name == "" {
		name = defaultName
	} else {
		schema = ""
	}
	if name != "" {
		s.names = append(s.names, rangeName{name, schema, b})
	}
	return b
}

func (a *analyzer) outputs(targets any, s *scope) binding {
	var out binding
	for _, target := range items(targets) {
		t := child(target, "ResTarget")
		out.append(a.project(t["val"], str(t, "name"), s))
	}
	return out
}

func (a *analyzer) project(value any, name string, s *scope) binding {
	if cr := a.directColumn(value, s); cr != nil {
		b, ids := a.columnRef(cr, s)
		if expandsStar(cr["fields"]) {
			return b
		}
		if name == "" {
			name = last(names(cr["fields"]))
		}
		return binding{columns: []output{{name, ids}}}
	}
	if f := child(value, "FuncCall"); name == "" && f != nil {
		name = last(names(f["funcname"]))
	}
	// A composite expression ending in .* expands according to its result type.
	return binding{
		columns:      []output{{name, a.expr(value, s)}},
		unknownWidth: expandsStar(child(value, "A_Indirection")["indirection"]),
	}
}

func (a *analyzer) valuesRow(values any, s *scope) binding {
	var out binding
	for _, value := range items(values) {
		out.append(a.project(value, "", s))
	}
	for i := range out.columns {
		out.columns[i].name = "column" + strconv.Itoa(i+1)
	}
	return out
}
func (a *analyzer) with(n node, s *scope) {
	var pending []*cteBinding
	for _, w := range items(n["ctes"]) {
		c := child(w, "CommonTableExpr")
		name := str(c, "ctename")
		aliases := names(c["aliascolnames"])
		query := child(c, "ctequery")
		entry := &cteBinding{columns: binding{unknownWidth: true}}
		entry.resolve = func() binding {
			var b binding
			if sel := child(query, "SelectStmt"); sel != nil && n["recursive"] == true {
				b = a.selectWithAnchor(sel, s, func(anchor binding) { entry.columns = anchor.renamed(aliases) })
			} else {
				b = a.statement(query, s)
			}
			// SEARCH and CYCLE add columns after the recursive query's outputs.
			if c["search_clause"] != nil || c["cycle_clause"] != nil {
				b.unknownWidth = true
			}
			return b.renamed(aliases)
		}
		if n["recursive"] == true {
			pending = append(pending, entry)
		} else {
			entry.get() // An ordinary CTE sees only its previously declared siblings.
		}
		s.ctes[name] = entry
	}
	for _, entry := range pending {
		entry.get() // Include dependencies from unreferenced CTEs as well.
	}
}

// A standalone name in ORDER BY or DISTINCT ON prefers a select-list name.
// GROUP BY first checks the local FROM items. Expressions use ordinary scope.
func (a *analyzer) clauseExpr(v any, s *scope, out binding, group bool) {
	if group {
		if set := child(v, "GroupingSet"); set != nil {
			for _, item := range items(set["content"]) {
				a.clauseExpr(item, s, out, true)
			}
			return
		}
		if row := child(v, "RowExpr"); str(row, "row_format") == "COERCE_IMPLICIT_CAST" {
			for _, item := range items(row["args"]) {
				a.clauseExpr(item, s, out, true)
			}
			return
		}
	}
	cr := child(v, "ColumnRef")
	if fields := names(cr["fields"]); len(fields) == 1 && fields[0] != "*" {
		name := fields[0]
		if ids, hits := out.lookup(name); hits > 0 {
			var localHits int
			if group {
				_, localHits = s.local(name)
			}
			if localHits == 0 {
				a.readReference(name, num(cr, "location"), ids, hits, nil)
				return
			}
		}
	}
	a.expr(v, s)
}

func (a *analyzer) selectStmt(n node, parent *scope) binding {
	return a.selectWithAnchor(n, parent, nil)
}

func (a *analyzer) selectWithAnchor(n node, parent *scope, anchor func(binding)) binding {
	s := newScope(parent)
	a.with(child(n, "withClause"), s)
	var out binding
	if op := str(n, "op"); op != "" && op != "SETOP_NONE" {
		out = a.selectStmt(child(n, "larg"), s)
		if anchor != nil {
			anchor(out)
		}
		right := a.selectStmt(child(n, "rarg"), s)
		out.mergeRow(right)
	} else {
		for _, f := range items(n["fromClause"]) {
			b := a.from(obj(f), s)
			s.sources = append(s.sources, b)
		}
		out = a.outputs(n["targetList"], s)
		for i, row := range items(n["valuesLists"]) {
			values := a.valuesRow(child(row, "List")["items"], s)
			if i == 0 {
				out = values
				continue
			}
			out.mergeRow(values)
		}
		for _, item := range items(n["groupClause"]) {
			a.clauseExpr(item, s, out, true)
		}
		for _, key := range []string{"whereClause", "havingClause", "windowClause"} {
			a.expr(n[key], s)
		}
	}
	a.expr(n["limitOffset"], s)
	a.expr(n["limitCount"], s)
	for _, item := range items(n["sortClause"]) {
		a.clauseExpr(child(item, "SortBy")["node"], s, out, false)
	}
	for _, item := range items(n["distinctClause"]) {
		a.clauseExpr(item, s, out, false)
	}
	return out
}
