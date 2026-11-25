package analysis

import (
	"slices"
	"strings"
	"testing"
	"unicode/utf16"

	"postgres-viz/internal/snapshot"
)

func TestCallSiteOccurrences(t *testing.T) {
	const sql = `SELECT '🍒', public."F Δ"(), public."F Δ"();`
	for _, kind := range []string{"function", "view", "sql-body"} {
		t.Run(kind, func(t *testing.T) {
			s := snapshot.New("test", nil, nil)
			s.Objects = append(s.Objects, snapshot.Object{ID: "callee", Schema: "public", Name: "F Δ()", Kind: "function"})
			routines := []snapshot.Routine{{ID: "callee", Schema: "public", Name: "F Δ", CallParameters: []snapshot.CallParameter{}}}
			def := sql
			objKind := kind
			if kind == "sql-body" {
				objKind = "function"
				def = "CREATE FUNCTION public.caller() RETURNS record LANGUAGE SQL BEGIN ATOMIC " + sql + " END"
			}
			s.Objects = append(s.Objects, snapshot.Object{ID: "caller", Schema: "public", Name: "caller", Kind: objKind})
			s.Definitions = append(s.Definitions, snapshot.Definition{OwnerID: "caller", SQL: def})
			if kind != "view" {
				routines = append(routines, snapshot.Routine{ID: "caller", Name: "caller", Schema: "public", Language: "sql", Body: sql, Definition: def, HasSQLBody: kind == "sql-body"})
			}
			if kind != "function" {
				s.Relationships = append(s.Relationships, snapshot.Relationship{ID: "calls|caller|callee", Kind: "calls", Source: "caller", Target: "callee", Provenance: "catalog"})
			}
			if err := Analyze(t.Context(), s, routines); err != nil {
				t.Fatal(err)
			}
			if len(s.Relationships) != 1 || len(s.Evidence) != 2 {
				t.Fatalf("relationships=%+v evidence=%+v", s.Relationships, s.Evidence)
			}
			chars := utf16.Encode([]rune(def))
			for i, e := range s.Evidence {
				if e.Start == nil || e.End == nil || !strings.Contains(e.Snippet, `"F Δ"`) ||
					string(utf16.Decode(chars[*e.Start:*e.End])) != `public."F Δ"` ||
					(i > 0 && *e.Start <= *s.Evidence[i-1].End) || e.RelationshipID != s.Relationships[0].ID {
					t.Fatalf("bad occurrence %d: %+v", i, e)
				}
			}
		})
	}
}

func TestRepeatedPLCallLocations(t *testing.T) {
	body := "\nBEGIN\n  /* PERFORM public.f(); */ PERFORM public.f(); PERFORM public.f();\n  CALL public.p();\n  CALL public.p();\nEND"
	def := "CREATE PROCEDURE public.caller() LANGUAGE plpgsql AS $$" + body + "$$"
	s := snapshot.Snapshot{Objects: []snapshot.Object{
		{ID: "f", Kind: "function", Schema: "public"}, {ID: "p", Kind: "procedure", Schema: "public"},
	}}
	routines := []snapshot.Routine{{ID: "caller", Language: "plpgsql", Schema: "public", Body: body, Definition: def},
		{ID: "f", Name: "f", Schema: "public"}, {ID: "p", Name: "p", Schema: "public"}}
	if err := Analyze(t.Context(), &s, routines); err != nil {
		t.Fatal(err)
	}
	if len(s.Evidence) != 4 {
		t.Fatalf("got %d occurrences", len(s.Evidence))
	}
	lastEnd := 0
	for i, e := range s.Evidence {
		name := "public.f"
		if i >= 2 {
			name = "public.p"
		}
		if e.Start == nil || e.End == nil || *e.Start < lastEnd || def[*e.Start:*e.End] != name {
			t.Fatalf("occurrence %d: %+v", i, e)
		}
		lastEnd = *e.End
	}
}

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
