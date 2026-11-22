package analysis

import (
	"slices"
	"testing"

	"postgres-viz/internal/snapshot"
)

func TestParsedCallCandidates(t *testing.T) {
	s := &snapshot.Snapshot{}
	var routines []snapshot.Routine
	add := func(schema, name, id, kind string, params ...snapshot.CallParameter) {
		s.Objects = append(s.Objects, snapshot.Object{ID: id, Name: name, Schema: schema, Kind: kind})
		routines = append(routines, snapshot.Routine{ID: id, Name: name, Schema: schema, CallParameters: params})
	}
	q := snapshot.CallParameter{Name: "q"}
	tax := snapshot.CallParameter{Name: "Tax"}
	unit := snapshot.CallParameter{Name: "unit"}
	option := snapshot.CallParameter{Name: "pct", Defaulted: true}
	rest := snapshot.CallParameter{Name: "rest", Variadic: true}
	add("app", "price", "one", "function", q)
	add("app", "price", "two", "function", q, tax)
	add("app", "price", "proc", "procedure", q, snapshot.CallParameter{Name: "outval"}, tax)
	add("public", "price", "public_three", "function", q, tax, unit)
	add("app", "rate", "optional", "function", q, option)
	add("app", "rate", "same_count", "function", tax)
	add("app", "rate", "long", "function", q, tax, unit)
	add("app", "collect", "variable", "function", q, rest)
	add("app", "collect", "empty", "function", []snapshot.CallParameter{}...)
	add("app", "choose", "int", "function", q)
	add("app", "choose", "text", "function", q)
	add("app", "legacy", "unknown", "function")
	add("app", "legacy", "zero", "function", []snapshot.CallParameter{}...)
	cases := []struct {
		id, sql   string
		target    string
		ambiguous []string
	}{
		{"one_arg", "SELECT price(1)", "one", nil},
		{"two_args", "BEGIN PERFORM app.price(1, 2); END", "two", nil},
		{"proc_out", "CALL price(1, NULL, 2)", "proc", nil},
		{"proc_missing_out", "CALL price(1, 2)", "", nil},
		{"func_scope", "SELECT price(1,2,3)", "public_three", nil},
		{"qualified_scope", "SELECT app.price(1,2,3)", "", nil},
		{"named_default", "SELECT rate(q=>1)", "optional", nil},
		{"mixed_named", "SELECT price(1, \"Tax\"=>2)", "two", nil},
		{"unknown_case", "SELECT price(1, tax=>2)", "", nil},
		{"reordered", "SELECT rate(pct=>2, q=>1)", "optional", nil},
		{"required", "SELECT rate(pct=>2)", "", nil},
		{"default_overlap", "SELECT rate(1)", "", []string{"optional", "same_count"}},
		{"empty_var", "SELECT collect()", "empty", nil},
		{"missing_var", "SELECT collect(1)", "", nil},
		{"many_var", "SELECT collect(1,2,3)", "variable", nil},
		{"named_var", "SELECT collect(q=>1, VARIADIC rest=>ARRAY[2])", "variable", nil},
		{"implicit_named_var", "SELECT collect(q=>1, rest=>ARRAY[2])", "", nil},
		{"explicit_fixed", "SELECT app.price(VARIADIC 1)", "one", nil},
		{"same_shape", "SELECT choose(1::int)", "", []string{"int", "text"}},
		{"missing_signature", "SELECT legacy(1)", "unknown", nil},
		{"known_zero", "SELECT legacy()", "", []string{"unknown", "zero"}},
		{"fallback", "SELECT app.price(1)", "", []string{"one", "two", "proc"}},
	}
	for _, tc := range cases {
		r := snapshot.Routine{ID: tc.id, Name: tc.id, Schema: "app", Language: "sql", Body: tc.sql}
		switch tc.id {
		case "two_args":
			r.Language = "plpgsql"
			r.Definition = "CREATE FUNCTION subject() RETURNS void LANGUAGE plpgsql AS $$" + r.Body + "$$"
		case "fallback":
			r.Language, r.Definition = "plpgsql", "invalid"
		}
		routines = append(routines, r)
	}
	if err := Analyze(t.Context(), s, routines); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.id, func(t *testing.T) {
			var targets, candidates []string
			for _, e := range s.Relationships {
				if e.Source == tc.id {
					if e.Kind != "calls" || e.Provenance != "parsed" {
						t.Errorf("unexpected edge %+v", e)
					}
					targets = append(targets, e.Target)
				}
			}
			var want []string
			if tc.target != "" {
				want = []string{tc.target}
			}
			if !slices.Equal(targets, want) {
				t.Errorf("targets %v, want %v", targets, want)
			}
			for _, d := range s.Diagnostics.Unresolved {
				if d.OwnerID == tc.id {
					if d.Reason != "ambiguous" {
						t.Errorf("unexpected diagnostic %+v", d)
					}
					candidates = append(candidates, d.CandidateIDs...)
				}
			}
			if !slices.Equal(candidates, tc.ambiguous) {
				t.Errorf("candidates %v, want %v", candidates, tc.ambiguous)
			}
		})
	}
}
