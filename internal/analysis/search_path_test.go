package analysis

import (
	"slices"
	"testing"

	"postgres-viz/internal/snapshot"
)

func TestRoutineSearchPath(t *testing.T) {
	s := scopeCatalog()
	s.Objects = append(s.Objects, snapshot.Object{ID: "other_orders", Schema: "Other, Data", Name: "orders", Kind: "table"})
	ids := []string{"orders", "other_orders"}
	a := analyzer{catalog: index(s, nil), r: snapshot.Routine{Schema: "public"}}
	for _, tc := range []struct {
		name                       string
		path, include, parts, want []string
	}{
		{"caller supplies path", nil, nil, []string{"orders"}, ids},
		{"ordered", []string{"Other, Data", "public"}, nil, []string{"orders"}, []string{"other_orders"}},
		{"qualified", []string{"Other, Data"}, nil, []string{"public", "orders"}, []string{"orders"}},
		{"empty", []string{}, nil, []string{"orders"}, nil},
		{"no fallback outside path", []string{"missing"}, nil, []string{"orders"}, nil},
		{"excluded first schema", []string{"Other, Data", "public"}, []string{"public"}, []string{"orders"}, nil},
		{"runtime user first", []string{"$user", "public"}, nil, []string{"orders"}, nil},
		{"known relation before runtime user", []string{"public", "$user"}, nil, []string{"orders"}, []string{"orders"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a.s.Schemas.Include = tc.include
			a.r.SearchPath = tc.path
			if got := a.schemaMatches(ids, tc.parts); !slices.Equal(got, tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestSearchPathOverloads(t *testing.T) {
	s := scopeCatalog()
	var routines []snapshot.Routine
	for _, entry := range []struct{ id, schema, types string }{
		{"early_int", "early", "23"}, {"late_int", "late", "23"}, {"late_text", "late", "25"},
	} {
		s.Objects = append(s.Objects, snapshot.Object{ID: entry.id, Schema: entry.schema, Name: "price", Kind: "function"})
		routines = append(routines, snapshot.Routine{ID: entry.id, Schema: entry.schema, Name: "price", InputTypes: &entry.types})
	}
	a := analyzer{catalog: index(s, routines), r: snapshot.Routine{SearchPath: []string{"pg_temp", "early", "late"}}}
	got := a.matches(a.functions, []string{"price"})
	if want := []string{"early_int", "late_text"}; !slices.Equal(got, want) {
		t.Fatalf("visible overloads = %v, want %v", got, want)
	}
}

func TestFilteredRoutineSearchPathCount(t *testing.T) {
	s := scopeCatalog()
	s.Schemas.Include = []string{"public"}
	r := snapshot.Routine{ID: "count", Schema: "public", Language: "sql", SearchPath: []string{"unscanned", "public"}, Body: "SELECT count(*) FROM orders"}
	if err := Analyze(t.Context(), s, []snapshot.Routine{r}); err != nil {
		t.Fatal(err)
	}
	if len(s.Relationships) != 0 || len(s.Diagnostics.Unresolved) != 1 || s.Diagnostics.Unresolved[0].Identifier != "orders" {
		t.Fatalf("expected an unresolved relation, got relationships %+v and diagnostics %+v", s.Relationships, s.Diagnostics)
	}
}
