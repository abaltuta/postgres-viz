package analysis

import (
	"encoding/json"
	"slices"
	"strconv"
	"strings"

	pg "github.com/pganalyze/pg_query_go/v6"
	pgquery "github.com/wasilibs/go-pgquery"
)

func supports(version, major int) bool { return version == 0 || version >= major*10000 }

// The embedded PostgreSQL 17 grammar handles the expressions, conflict target
// and WHERE predicate. Replace only newer grammar productions and recover their
// meaning from the corresponding ResTarget in the successfully parsed tree.
type dmlEdit struct {
	start, end, parsedEnd int
	marker, replacement   string
	aliases               map[string]string // RETURNING options; nil for DO SELECT
}

func dmlEdits(sql string, version int) (string, []dmlEdit) {
	scan, err := pgquery.Scan(sql)
	if err != nil {
		return sql, nil
	}
	ts := slices.DeleteFunc(scan.Tokens, func(t *pg.ScanToken) bool {
		return t.Token == pg.Token_SQL_COMMENT || t.Token == pg.Token_C_COMMENT
	})
	word := func(i int) string {
		if i >= len(ts) {
			return ""
		}
		return sql[ts[i].Start:ts[i].End]
	}
	prefix := "__pgviz_"
	lower := strings.ToLower(sql)
	for i := 1; strings.Contains(lower, prefix); i++ {
		prefix = "__pgviz" + strconv.Itoa(i) + "_"
	}
	var b strings.Builder
	var edits []dmlEdit
	lastEnd := 0
	for i := 0; i < len(ts); i++ {
		start, end := i+1, i+1
		marker := prefix + strconv.Itoa(len(edits))
		var replacement string
		var aliases map[string]string
		switch {
		case strings.EqualFold(word(i), "returning") && strings.EqualFold(word(start), "with") && word(start+1) == "(":
			aliases = map[string]string{}
			j := start + 2
			for {
				role := strings.ToLower(word(j))
				if (role != "old" && role != "new") || aliases[role] != "" || !strings.EqualFold(word(j+1), "as") || j+2 >= len(ts) {
					return sql, nil
				}
				j += 2
				aliasStart := j
				if ts[j].Token == pg.Token_UIDENT && strings.EqualFold(word(j+1), "uescape") {
					j += 2
				}
				if j >= len(ts) {
					return sql, nil
				}
				// FROM accepts ColId and applies PostgreSQL's identifier folding,
				// truncation and Unicode-escape decoding to the alias.
				id, err := pgquery.Parse("SELECT 1 FROM " + sql[ts[aliasStart].Start:ts[j].End])
				if err != nil {
					return sql, nil
				}
				from := id.Stmts[0].Stmt.GetSelectStmt().FromClause
				if len(from) != 1 || from[0].GetRangeVar().GetRelname() == "" {
					return sql, nil
				}
				aliases[role] = from[0].GetRangeVar().GetRelname()
				j++
				if word(j) == ")" {
					end = j
					break
				}
				if word(j) != "," {
					return sql, nil
				}
				j++
			}
			replacement = marker + ","
		case supports(version, 19) && strings.EqualFold(word(i), "do") && strings.EqualFold(word(start), "select"):
			if strings.EqualFold(word(end+1), "for") {
				end += 2
				switch strings.ToLower(word(end)) {
				case "update", "share":
				case "key":
					if !strings.EqualFold(word(end+1), "share") {
						return sql, nil
					}
					end++
				case "no":
					if !strings.EqualFold(word(end+1), "key") || !strings.EqualFold(word(end+2), "update") {
						return sql, nil
					}
					end += 2
				default:
					return sql, nil
				}
			}
			if !strings.EqualFold(word(end+1), "where") && !strings.EqualFold(word(end+1), "returning") {
				return sql, nil
			}
			replacement = "UPDATE SET " + marker + "=0"
		default:
			continue
		}
		a, z := int(ts[start].Start), int(ts[end].End)
		replacement = strings.Repeat("\n", strings.Count(sql[a:z], "\n")) + replacement
		b.WriteString(sql[lastEnd:a])
		b.WriteString(replacement)
		edits = append(edits, dmlEdit{a, z, b.Len(), marker, replacement, aliases})
		lastEnd = z
		i = end
	}
	if len(edits) == 0 {
		return sql, nil
	}
	b.WriteString(sql[lastEnd:])
	return b.String(), edits
}

// Each edit's end anchors the original offsets up to the next edit.
func originalDMLLocation(edits []dmlEdit, loc int) int {
	i, found := slices.BinarySearchFunc(edits, loc, func(e dmlEdit, pos int) int { return e.parsedEnd - pos })
	if found {
		i++
	}
	if i == 0 {
		return loc
	}
	return loc + edits[i-1].end - edits[i-1].parsedEnd
}

// IndexElem doesn't carry a location for a bare index column. Its name starts
// at the first token of the element in the validated inference list.
func conflictColumnLocations(infer node, sql string, start, end int) {
	elems := items(infer["indexElems"])
	if len(elems) == 0 || start < 0 || end < start || end > len(sql) {
		return
	}
	scan, err := pgquery.Scan(sql[start:end])
	if err != nil {
		return
	}
	depth, i := 0, -1
	next := false
	for _, t := range scan.Tokens {
		if t.Token == pg.Token_C_COMMENT || t.Token == pg.Token_SQL_COMMENT {
			continue
		}
		if next && i < len(elems) {
			if e := child(elems[i], "IndexElem"); str(e, "name") != "" {
				e["location"] = start + int(t.Start)
			}
			next = false
		}
		switch sql[start+int(t.Start) : start+int(t.End)] {
		case "(", "[":
			if depth == 0 {
				i = 0
				next = true
			}
			depth++
		case ")", "]":
			depth--
			if depth == 0 {
				return
			}
		case ",":
			if depth == 1 {
				i++
				next = true
			}
		}
	}
}

func visitDMLTree(v any, visit func(node)) {
	switch n := v.(type) {
	case []any:
		for _, child := range n {
			visitDMLTree(child, visit)
		}
	case node:
		visit(n)
		for _, child := range n {
			visitDMLTree(child, visit)
		}
	}
}

func modernSQL(sql string, version int, parseErr error) (string, error) {
	input, edits := dmlEdits(sql, version)
	if len(edits) == 0 {
		return "", parseErr
	}
	raw, err := pgquery.ParseToJSON(input)
	if err != nil {
		return "", parseErr
	}
	var tree node
	if err = json.Unmarshal([]byte(raw), &tree); err != nil {
		return "", err
	}
	markers := map[string]dmlEdit{}
	for _, e := range edits {
		markers[e.marker] = e
	}
	visitDMLTree(tree, func(n node) {
		if loc, ok := n["location"].(float64); ok && loc >= 0 {
			n["location"] = originalDMLLocation(edits, int(loc))
		}
		if list := items(n["returningList"]); len(list) > 0 {
			fields := names(child(list[0], "ResTarget", "val", "ColumnRef")["fields"])
			if len(fields) == 1 {
				if e, found := markers[fields[0]]; found && e.aliases != nil && len(list) > 1 {
					n["returningAliases"] = e.aliases
					n["returningList"] = list[1:]
					delete(markers, e.marker)
				}
			}
		}
		c := child(n, "onConflictClause")
		if targets := items(c["targetList"]); len(targets) == 1 {
			key := str(child(targets[0], "ResTarget"), "name")
			if e, found := markers[key]; found && e.aliases == nil && child(c, "infer") != nil && len(items(n["returningList"])) > 0 {
				infer := child(c, "infer")
				conflictColumnLocations(infer, sql, originalDMLLocation(edits, num(infer, "location")), e.start)
				c["action"] = "ONCONFLICT_SELECT"
				delete(c, "targetList")
				delete(markers, key)
			}
		}
	})
	if len(markers) > 0 {
		return "", parseErr
	}
	data, err := json.Marshal(tree)
	return string(data), err
}

// PL/pgSQL validates static SQL while compiling the function. Compile the
// compatible body, then hand its original fragments to the SQL analyzer.
func modernPL(def string, version int, parseErr error) (string, error) {
	decl, err := pgquery.Parse(def)
	if err != nil || len(decl.Stmts) != 1 {
		return "", parseErr
	}
	for _, option := range decl.Stmts[0].Stmt.GetCreateFunctionStmt().GetOptions() {
		opt := option.GetDefElem()
		if opt.GetDefname() != "as" {
			continue
		}
		args := opt.GetArg().GetList().GetItems()
		if len(args) != 1 || args[0].GetString_() == nil {
			break
		}
		literal := args[0].GetString_()
		body := literal.Sval
		input, edits := dmlEdits(body, version)
		if len(edits) == 0 {
			break
		}
		literal.Sval = input
		compat, err := pgquery.Deparse(decl)
		if err != nil {
			break
		}
		raw, err := pgquery.ParsePlPgSqlToJSON(compat)
		if err != nil {
			return "", err
		}
		var tree any
		if err = json.Unmarshal([]byte(raw), &tree); err != nil {
			return "", err
		}
		var pairs []string
		for _, e := range edits {
			pairs = append(pairs, e.replacement, body[e.start:e.end])
		}
		restore := strings.NewReplacer(pairs...)
		visitDMLTree(tree, func(n node) {
			if e := child(n, "PLpgSQL_expr"); e != nil {
				e["query"] = restore.Replace(str(e, "query"))
			}
		})
		data, err := json.Marshal(tree)
		return string(data), err
	}
	return "", parseErr
}
