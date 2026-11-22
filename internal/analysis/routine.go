package analysis

import (
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
)

var (
	declaredType      = regexp.MustCompile(`(?i)^(` + ident + `)(?:\s*\.\s*(` + ident + `))?(?:%ROWTYPE)?$`)
	aliasFor          = regexp.MustCompile(`(?i)(?:\bDECLARE\s+|;\s*)(` + ident + `)\s+ALIAS\s+FOR\s+(\$\d+|` + ident + `)\s*`)
	conflictDirective = regexp.MustCompile(`(?im)^\s*#variable_conflict\s+(use_variable|use_column|error)\b`)
	triggerAssign     = regexp.MustCompile(`(?i)(?:^|;|\bbegin\b|\bthen\b|\belse\b|\bloop\b)\s*"?(_?new|_?old)"?\s*\.\s*(` + ident + `)\s*:?=`)
)

func folded(s string) string {
	if strings.HasPrefix(s, "\"") {
		return strings.ReplaceAll(s[1:len(s)-1], "\"\"", "\"")
	}
	return strings.ToLower(s)
}
func (a *analyzer) parameters() {
	if a.r.Args == "" || a.r.Definition == "" {
		return
	}
	tree, err := a.p.parse(a.r.Definition, false)
	if err != nil {
		return
	}
	list := statements(tree)
	if len(list) == 0 {
		return
	}
	f := child(list[0], "stmt", "CreateFunctionStmt")
	count := 0
	for _, v := range items(f["parameters"]) {
		p := child(v, "FunctionParameter")
		typ := child(p, "argType")
		parts := names(typ["names"])
		row := ""
		if len(parts) > 0 && len(items(typ["arrayBounds"])) == 0 {
			id := a.matches(a.relations, parts)
			if len(id) == 1 {
				row = id[0]
			}
		}
		if name := str(p, "name"); name != "" {
			a.variables[name] = row
		}
		mode := str(p, "mode")
		// PL/pgSQL numbers every declared parameter, including output variables.
		if a.r.Language == "sql" && (mode == "FUNC_PARAM_OUT" || mode == "FUNC_PARAM_TABLE") {
			continue
		}
		count++
		a.variables[fmt.Sprintf("$%d", count)] = row
	}
}
func (a *analyzer) localVariables(f node, masked string) {
	for _, d := range items(f["datums"]) {
		v := child(d, "PLpgSQL_var")
		if v == nil {
			v = child(d, "PLpgSQL_rec")
		}
		if v == nil {
			continue
		}
		name := str(v, "refname")
		_, exists := a.variables[name]
		line := num(v, "lineno")
		if exists && line == 0 {
			continue
		}
		row := ""
		parts := declaredType.FindStringSubmatch(str(child(v, "datatype", "PLpgSQL_type"), "typname"))
		if !exists && line > 0 && parts != nil {
			typ, schema := folded(parts[1]), ""
			if parts[2] != "" {
				schema, typ = typ, folded(parts[2])
			}
			row = a.rel(typ, schema)
		}
		a.variables[name] = row
	}
	for _, m := range aliasFor.FindAllStringSubmatch(masked, -1) {
		if id, ok := a.variables[folded(m[2])]; ok {
			a.variables[folded(m[1])] = id
		}
	}
	a.conflict = "error"
	if m := conflictDirective.FindStringSubmatch(masked); m != nil {
		a.conflict = strings.ToLower(m[1])
	}
}
func (a *analyzer) analyze() error {
	a.parameters()
	if a.r.Language == "sql" {
		if a.r.Body == "" {
			return nil
		}
		tree, err := a.p.parse(a.r.Body, false)
		if err != nil {
			return err
		}
		a.source(a.r.Body, 0, true)
		a.query(tree)
		return nil
	}
	masked := maskSQL(a.r.Body)
	for _, m := range triggerAssign.FindAllStringSubmatch(masked, -1) {
		for _, id := range a.triggerRels {
			cols, _ := a.base(id).lookup(folded(m[2]))
			for _, col := range cols {
				a.addEdge("modifies", col, "fallback")
			}
		}
	}
	tree, err := a.p.parse(a.r.Definition, true)
	if err != nil {
		tree, err = a.retryRowtype(err)
		if err != nil {
			return err
		}
	}
	funcs := items(tree)
	if len(funcs) == 0 {
		return errors.New("empty PL/pgSQL parse")
	}
	f := child(funcs[0], "PLpgSQL_function")
	a.localVariables(f, masked)
	a.fragments(f, false)
	return nil
}

// Each PL expression carries its PostgreSQL raw parse mode, including whether
// a complete assignment or just its value is present.
func (a *analyzer) fragments(v any, dynamic bool) {
	switch n := v.(type) {
	case []any:
		for _, item := range n {
			a.fragments(item, dynamic)
		}
	case map[string]any:
		if e := child(n, "PLpgSQL_expr"); e != nil {
			a.fragment(str(e, "query"), num(e, "parseMode"), dynamic)
			return
		}
		for _, k := range slices.Sorted(maps.Keys(n)) {
			if k == "PLpgSQL_stmt_dynexecute" || k == "PLpgSQL_stmt_dynfors" {
				stmt := obj(n[k])
				for _, key := range slices.Sorted(maps.Keys(stmt)) {
					a.fragments(stmt[key], key == "query")
				}
			} else {
				a.fragments(n[k], k == "dynquery")
			}
		}
	}
}
func (a *analyzer) fragment(sql string, mode int, dynamic bool) {
	if a.r.Returns == "trigger" {
		switch strings.ToLower(strings.TrimSpace(sql)) {
		case "old", "new":
			return
		}
	}
	if mode >= 3 {
		if err := a.assignment(sql); err != nil {
			a.diagnostic("missing", "PL/pgSQL expression", clip(sql, 240), nil)
		}
		return
	}
	input := sql
	delta := 0
	if mode >= 2 {
		input = "SELECT " + input
		delta -= len("SELECT ")
	}
	tree, err := a.p.parse(input, false)
	if err == nil {
		a.source(sql, delta, true)
		a.query(tree)
		if !dynamic || a.literalCommand(tree, sql) {
			return
		}
	}
	label := "PL/pgSQL expression"
	if dynamic {
		label = "EXECUTE"
	}
	a.diagnostic("missing", label, clip(sql, 240), nil)
}

func (a *analyzer) literalCommand(tree any, expression string) bool {
	stmts := statements(tree)
	if len(stmts) != 1 {
		return false
	}
	targets := items(child(stmts[0], "stmt", "SelectStmt")["targetList"])
	if len(targets) != 1 {
		return false
	}
	val := child(targets[0], "ResTarget", "val", "A_Const", "sval")
	command, ok := val["sval"].(string)
	if !ok {
		return false
	}
	parsed, err := a.p.parse(command, false)
	if err != nil {
		return false
	}
	// EXECUTE has its own SQL namespace and receives values only through USING.
	dynamic := *a
	dynamic.variables, dynamic.triggerRels = nil, nil
	dynamic.source(command, 0, strings.Contains(expression, command))
	dynamic.query(parsed)
	return true
}
