package analysis

import (
	"slices"

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
	a.recordCall(parts, a.schemaMatches(candidates, parts), "parsed")
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
