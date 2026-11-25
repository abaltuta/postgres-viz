package analysis

import (
	"maps"
	"regexp"
	"slices"
	"strings"

	"postgres-viz/internal/snapshot"
)

func (a *analyzer) parsedCall(f node, kind string) {
	parts := names(f["funcname"])
	ids := a.functions[last(parts)]
	if len(ids) == 0 {
		return
	}
	args := items(f["args"])
	argNames := make([]string, len(args))
	for i, arg := range args {
		argNames[i] = str(child(arg, "NamedArgExpr"), "name")
	}
	var candidates []string
	for _, id := range ids {
		if a.objs[id].Kind == kind && acceptsCall(a.signatures[id], argNames, f["func_variadic"] == true) {
			candidates = append(candidates, id)
		}
	}
	if a.view || a.r.HasSQLBody {
		// The server resolved these calls already. Never attach a location to
		// an overload which is not a catalog dependency of this definition.
		ids = slices.DeleteFunc(candidates, func(id string) bool {
			return !a.edges["calls|"+a.r.ID+"|"+id] || (len(parts) > 1 && a.objs[id].Schema != parts[len(parts)-2])
		})
	} else {
		ids = a.schemaMatches(candidates, parts)
	}
	edge := a.recordCall(parts, ids, "parsed")
	if edge != "" {
		label := strings.Join(parts, ".")
		loc := num(f, "location")
		pos := loc + a.delta
		width := 0
		if loc >= 0 && pos >= 0 && pos < len(a.sql) {
			text := columnText.FindString(a.sql[pos:])
			tokens := callIdentifier.FindAllString(text, -1)
			if len(tokens) == len(parts) && strings.HasPrefix(strings.TrimSpace(a.sql[pos+len(text):]), "(") {
				for i := range tokens {
					tokens[i] = folded(tokens[i])
				}
				if slices.Equal(tokens, parts) {
					width = len(text)
				}
			}
		}
		a.evidence(edge, loc, label, pos, pos+width)
	}
}

var callIdentifier = regexp.MustCompile(ident)

// SQL-standard bodies already have server-resolved dependency edges. Walk
// only their body for call locations, leaving the catalog's semantics intact.
func (a *analyzer) catalogBodyCalls(v any) {
	switch n := v.(type) {
	case []any:
		for _, item := range n {
			a.catalogBodyCalls(item)
		}
	case map[string]any:
		if f := child(n, "FuncCall"); f != nil {
			a.parsedCall(f, "function")
		}
		if stmt := child(n, "CallStmt"); stmt != nil {
			f := child(stmt, "funccall")
			a.parsedCall(f, "procedure")
			a.catalogBodyCalls(f["args"])
			return
		}
		for _, k := range slices.Sorted(maps.Keys(n)) {
			a.catalogBodyCalls(n[k])
		}
	}
}

func acceptsCall(params []snapshot.CallParameter, names []string, explicitVariadic bool) bool {
	if params == nil {
		return true // No signature metadata.
	}
	expand := last(params).Variadic && !explicitVariadic
	if len(names) > len(params) && !expand {
		return false
	}
	supplied := make([]bool, len(params))
	named := false
	for i, name := range names {
		slot := i
		if name != "" {
			// PostgreSQL only accepts named notation for variadic routines
			// when the caller explicitly passes the array.
			if expand {
				return false
			}
			named = true
			slot = slices.IndexFunc(params, func(p snapshot.CallParameter) bool { return p.Name == name })
			if slot < 0 || supplied[slot] || (params[slot].Variadic && i != len(names)-1) {
				return false
			}
		} else if named {
			return false
		}
		if slot < len(params) {
			supplied[slot] = true
		}
	}
	for i, p := range params {
		if !supplied[i] && !p.Defaulted {
			return false
		}
	}
	return true
}
