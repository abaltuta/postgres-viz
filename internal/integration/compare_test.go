package integration

import (
	"encoding/json"
	"fmt"
	"postgres-viz/internal/snapshot"
	"slices"
	"testing"
)

type endpoint struct{ Schema, Kind, Parent, Name, Column string }
type link struct {
	Source, Target, Constraint endpoint
	Kind, Provenance           string
	Position                   int
}
type inventory map[string]map[string]int

// Local IDs and capture times differ on every fixture installation. Compare
// a multiset for each collection so duplicate edges or occurrences cannot hide.
func semantic(s *snapshot.Snapshot) inventory {
	out := inventory{}
	add := func(category string, fields ...any) {
		data, err := json.Marshal(fields)
		if err != nil {
			panic(err)
		}
		if out[category] == nil {
			out[category] = map[string]int{}
		}
		out[category][string(data)]++
	}
	add("schema filters", s.Schemas)
	names := map[string]endpoint{}
	for _, o := range s.Objects {
		names[o.ID] = endpoint{Schema: o.Schema, Kind: o.Kind, Name: o.Name}
	}
	for _, o := range s.Objects {
		key := names[o.ID]
		key.Parent = names[o.ParentID].Name
		names[o.ID] = key
		add("objects", key, o.Detail)
	}
	for _, c := range s.Columns {
		key := names[c.ObjectID]
		key.Column = c.Name
		names[c.ID] = key
		add("columns", key, c.Position, c.Type)
	}
	for _, d := range s.Definitions {
		add("definitions", names[d.OwnerID], d.SQL)
	}
	edges := map[string]link{}
	for _, e := range s.Relationships {
		key := link{Source: names[e.Source], Target: names[e.Target], Constraint: names[e.ConstraintID], Kind: e.Kind, Provenance: e.Provenance, Position: e.Position}
		edges[e.ID] = key
		add("relationships", key)
	}
	for _, e := range s.Evidence {
		add("evidence", edges[e.RelationshipID], names[e.OwnerID], e.Provenance, e.Snippet, e.Start, e.End)
	}
	for _, w := range s.Diagnostics.Warnings {
		add("warnings", w)
	}
	for _, d := range s.Diagnostics.Unresolved {
		candidates := make([]string, 0, len(d.CandidateIDs))
		for _, id := range d.CandidateIDs {
			data, _ := json.Marshal(names[id])
			candidates = append(candidates, string(data))
		}
		slices.Sort(candidates)
		add("diagnostics", names[d.OwnerID], d.Identifier, d.Reason, d.Snippet, candidates)
	}
	return out
}

func compareFixture(t *testing.T, expected, actual *snapshot.Snapshot) {
	t.Helper()
	want, got := semantic(expected), semantic(actual)
	for _, category := range []string{"schema filters", "objects", "columns", "definitions", "relationships", "evidence", "warnings", "diagnostics"} {
		var diff []string
		for record, a := range want[category] {
			if b := got[category][record]; a > b {
				diff = append(diff, fmt.Sprintf("missing %d x %s", a-b, record))
			}
		}
		for record, b := range got[category] {
			if a := want[category][record]; b > a {
				diff = append(diff, fmt.Sprintf("extra %d x %s", b-a, record))
			}
		}
		slices.Sort(diff)
		for _, line := range diff[:min(3, len(diff))] {
			t.Errorf("%s (%d differences): %.900s", category, len(diff), line)
		}
	}
}

func expectCurrentParser(t *testing.T, expected, actual *snapshot.Snapshot) {
	t.Helper()
	objectID := func(schema, kind, name string) string {
		t.Helper()
		for _, o := range expected.Objects {
			if o.Schema == schema && o.Kind == kind && o.Name == name {
				return o.ID
			}
		}
		t.Fatalf("frozen regression fixture lacks %s %s.%s", kind, schema, name)
		return ""
	}
	logOrder := objectID("public", "function", "log_order()")
	recalculate := objectID("payroll", "function", "recalculate_totals(report_id uuid)")
	reportEntry := objectID("payroll", "table", "report_entry")
	const sumLine = "SUM(payroll.entry_amount(e)) AS computed_total"
	// Both calls pass a whole row. Remove exactly the old missing-name diagnostic
	// for each.
	for _, old := range []struct{ owner, identifier, snippet string }{
		{logOrder, "new", "INSERT INTO audit_log (table_name, payload) VALUES ('orders', to_jsonb(NEW))"},
		{recalculate, "e", sumLine},
	} {
		count := len(expected.Diagnostics.Unresolved)
		expected.Diagnostics.Unresolved = slices.DeleteFunc(expected.Diagnostics.Unresolved, func(d snapshot.Diagnostic) bool {
			return d.OwnerID == old.owner && d.Reason == "missing" && d.Identifier == old.identifier &&
				d.Snippet == old.snippet && len(d.CandidateIDs) == 0
		})
		if len(expected.Diagnostics.Unresolved) != count-1 {
			t.Fatalf("frozen regression fixture lacks one missing %q diagnostic in %s", old.identifier, old.snippet)
		}
	}

	// The caller passes all five report_entry fields to entry_amount(e).
	// Its aggregate then supplies the outer SELECT's t.computed_total.
	// Other references in this function already account for three of the edges.
	columns := map[string]string{}
	for _, c := range expected.Columns {
		if c.ObjectID == reportEntry {
			columns[c.Name] = c.ID
		}
	}
	for _, name := range []string{"id", "payroll_report_id", "employee_id", "payroll_paycode_id", "amount"} {
		column := columns[name]
		if column == "" {
			t.Fatalf("frozen regression fixture lacks payroll.report_entry.%s", name)
		}
		edge := "reads|" + recalculate + "|" + column
		if name == "id" || name == "amount" {
			expected.Relationships = append(expected.Relationships, snapshot.Relationship{
				ID: edge, Source: recalculate, Target: column, Kind: "reads", Provenance: "parsed",
			})
		}
		for _, ref := range []struct {
			start, end int
			line       string
		}{
			{349, 350, sumLine}, // e
			{770, 786, "SELECT t.payroll_report_id, t.employee_id, t.paycode_type, COALESCE(t.computed_total, 0)"}, // t.computed_total
		} {
			expected.Evidence = append(expected.Evidence, snapshot.Evidence{
				RelationshipID: edge, OwnerID: recalculate, Provenance: "parsed",
				Snippet: ref.line, Start: &ref.start, End: &ref.end,
			})
		}
	}
	// PostgreSQL resolves both zero-argument calls to child_sum(). The
	// view already has the catalog edge in the frozen fixture.
	caller := objectID("public", "function", "ambiguous_sum_call()")
	callee := objectID("public", "function", "child_sum()")
	other := objectID("public", "function", "child_sum(integer)")
	for _, owner := range []string{caller, objectID("public", "view", "child_summary")} {
		count := len(expected.Diagnostics.Unresolved)
		expected.Diagnostics.Unresolved = slices.DeleteFunc(expected.Diagnostics.Unresolved, func(d snapshot.Diagnostic) bool {
			return d.OwnerID == owner && d.Reason == "ambiguous" && d.Identifier == "child_sum" &&
				d.Snippet == "child_sum(...)" && len(d.CandidateIDs) == 2 &&
				slices.Contains(d.CandidateIDs, callee) && slices.Contains(d.CandidateIDs, other)
		})
		if len(expected.Diagnostics.Unresolved) != count-1 {
			t.Fatal("frozen fixture lacks the expected child_sum overload diagnostic")
		}
	}
	edge := snapshot.Relationship{ID: "calls|" + caller + "|" + callee, Source: caller, Target: callee, Kind: "calls", Provenance: "parsed"}
	expected.Relationships = append(expected.Relationships, edge)
	start, end := 106, 115
	expected.Evidence = append(expected.Evidence, snapshot.Evidence{
		RelationshipID: edge.ID, OwnerID: caller, Provenance: "parsed", Snippet: "SELECT child_sum()", Start: &start, End: &end,
	})
	// Three other call edges already exist in the frozen snapshot with only
	// owner-level evidence. Require each new occurrence independently of the scanner.
	for _, call := range []struct {
		source, target, snippet string
		start, end              int
	}{
		{logOrder, objectID("public", "function", "notify_stats()"), "notify_stats()", 369, 381},
		{recalculate, objectID("payroll", "function", "entry_amount(entry payroll.report_entry)"), sumLine, 328, 348},
		{objectID("public", "view", "child_summary"), callee, "SELECT child_sum() AS total;", 8, 17},
	} {
		id := "calls|" + call.source + "|" + call.target
		i := slices.IndexFunc(expected.Evidence, func(e snapshot.Evidence) bool { return e.RelationshipID == id })
		if i < 0 || expected.Evidence[i].Snippet != "" || expected.Evidence[i].Start != nil || expected.Evidence[i].End != nil {
			t.Fatalf("frozen fixture lacks definition-only evidence for %s", id)
		}
		e := &expected.Evidence[i]
		e.Snippet, e.Provenance = call.snippet, "parsed"
		e.Start, e.End = &call.start, &call.end
	}
	// The old grammar also fell back for the generic updated_at trigger. Require
	// both the exact old aggregate warnings and the exact new result.
	old := []string{"1 routines required fallback analysis", "4 unresolved SQL references"}
	if !slices.Equal(expected.Diagnostics.Warnings, old) {
		t.Fatalf("unexpected frozen warnings: %v", expected.Diagnostics.Warnings)
	}
	expected.Diagnostics.Warnings = []string{}
	if !slices.Equal(actual.Diagnostics.Warnings, expected.Diagnostics.Warnings) {
		t.Errorf("native parser warnings: %v", actual.Diagnostics.Warnings)
	}
}
