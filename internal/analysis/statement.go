package analysis

func (a *analyzer) targets(list any, rel, kind string) {
	a.table(kind, rel)
	for _, v := range items(list) {
		t := child(v, "ResTarget")
		name := str(t, "name")
		ids, _ := a.base(rel).lookup(name)
		for _, id := range ids {
			a.column(kind, id, num(t, "location"), name)
		}
	}
}

func (a *analyzer) insertTargets(list any, rel string, source binding) {
	if len(items(list)) > 0 {
		a.targets(list, rel, "inserts")
		return
	}
	columns := a.cols[rel]
	width := len(source.columns)
	if source.unknownWidth || width == 0 || width > len(columns) {
		// Keep this statement's table write even if another statement names columns.
		if !a.view {
			a.addEdge("inserts", rel, "parsed")
		}
		return
	}
	for _, col := range columns[:width] {
		a.column("inserts", col.ID, -1, col.Name)
	}
}

func (a *analyzer) statement(stmt node, parent *scope) binding {
	if q := child(stmt, "SelectStmt"); q != nil {
		return a.selectStmt(q, parent)
	}
	s := newScope(parent)
	for tag, data := range stmt {
		n := obj(data)
		rv := child(n, "relation")
		rel := a.sqlRelation(rv)
		a.with(child(n, "withClause"), s)
		target := a.base(rel)
		name := str(child(rv, "alias"), "aliasname")
		var schema string
		if name == "" {
			name = str(rv, "relname")
			schema = a.objs[rel].Schema
		}
		bindTarget := func() {
			if name != "" {
				s.names = append(s.names, rangeName{name, schema, target})
				s.sources = append(s.sources, target)
			}
		}
		switch tag {
		case "InsertStmt":
			source := a.statement(child(n, "selectStmt"), s)
			a.insertTargets(n["cols"], rel, source)
			a.expr(n["cols"], s)
			bindTarget()
			if conflict := child(n, "onConflictClause"); conflict != nil {
				for _, elem := range items(child(conflict, "infer")["indexElems"]) {
					index := child(elem, "IndexElem")
					name := str(index, "name")
					ids, _ := target.lookup(name)
					loc := -1
					if index["location"] != nil {
						loc = num(index, "location")
					}
					for _, id := range ids {
						a.column("reads", id, loc, name)
					}
				}
				if len(items(conflict["targetList"])) > 0 {
					a.targets(conflict["targetList"], rel, "updates")
				}
				cs := newScope(s)
				cs.names = append(cs.names, rangeName{name: "excluded", columns: target})
				a.expr(conflict["infer"], s)
				if str(conflict, "action") == "ONCONFLICT_SELECT" {
					a.table("reads", rel)
					cs.sources = []binding{target, target}
				}
				a.expr(conflict["targetList"], cs)
				a.expr(conflict["whereClause"], cs)
			}
		case "UpdateStmt", "DeleteStmt", "MergeStmt":
			bindTarget()
			for _, key := range []string{"fromClause", "usingClause"} {
				for _, f := range items(n[key]) {
					s.sources = append(s.sources, a.from(obj(f), s))
				}
			}
			switch tag {
			case "UpdateStmt":
				a.targets(n["targetList"], rel, "updates")
				a.expr(n["targetList"], s)
			case "DeleteStmt":
				a.table("deletes", rel)
			case "MergeStmt":
				s.sources = append(s.sources, a.from(child(n, "sourceRelation"), s))
				a.expr(n["joinCondition"], s)
				for _, v := range items(n["mergeWhenClauses"]) {
					w := child(v, "MergeWhenClause")
					switch str(w, "commandType") {
					case "CMD_INSERT":
						if len(items(w["targetList"])) > 0 {
							a.targets(w["targetList"], rel, "inserts")
							break
						}
						a.expr(w["condition"], s)
						values := a.valuesRow(w["values"], s)
						a.insertTargets(nil, rel, values)
						continue
					case "CMD_UPDATE":
						a.targets(w["targetList"], rel, "updates")
					case "CMD_DELETE":
						a.table("deletes", rel)
					}
					a.expr(w, s)
				}
			}
			a.expr(n["whereClause"], s)
		case "RefreshMatViewStmt":
			a.table("writes", rel)
		case "CopyStmt":
			if n["is_from"] == true {
				a.table("inserts", rel)
			} else {
				a.table("reads", rel)
			}
			a.expr(n["query"], s)
		case "TruncateStmt":
			for _, v := range items(n["relations"]) {
				r := child(v, "RangeVar")
				a.table("deletes", a.sqlRelation(r))
			}
		case "CallStmt":
			f := child(n, "funccall")
			a.parsedCall(f, "procedure")
			a.expr(f["args"], s)
		default:
			a.expr(n, s)
		}
		if len(items(n["returningList"])) > 0 && supports(a.r.ServerVersion, 18) {
			aliases := child(n, "returningAliases")
			for _, role := range []string{"old", "new"} {
				if alias := str(aliases, role); alias != "" {
					s.names = append(s.names, rangeName{name: alias, columns: target})
				}
			}
			for _, role := range []string{"old", "new"} {
				if str(aliases, role) == "" && len(s.qualified("", role)) == 0 {
					s.names = append(s.names, rangeName{name: role, columns: target})
				}
			}
		}
		return a.outputs(n["returningList"], s)
	}
	return binding{}
}
func statements(tree any) []any { return items(obj(tree)["stmts"]) }
func (a *analyzer) query(tree any) {
	for _, v := range statements(tree) {
		a.statement(child(v, "stmt"), newScope(nil))
	}
}
