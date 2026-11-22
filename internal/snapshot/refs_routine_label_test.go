package snapshot

import "testing"

func TestReferencesRoutineLabels(t *testing.T) {
	s := New("test", nil, nil)
	s.Objects = []Object{{ID: "t", Kind: "table", Schema: "sales", Name: "items"}}
	s.Columns = []Column{{ID: "c", ObjectID: "t", Name: "total"}}
	for _, tc := range []struct{ kind, name, label string }{
		{"function", "roll.up()", `sales."roll.up"()`},
		{"procedure", `roll"(up(amount integer)`, `sales."roll""(up"(amount integer)`},
		{"function", `roll(up)("a)""(" "s)"."t("[])`, `sales."roll(up)"("a)""(" "s)"."t("[])`},
		{"function", "rollup(input numeric)", "sales.rollup(input numeric)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s.Objects = append(s.Objects[:1], Object{ID: "r", Kind: tc.kind, Schema: "sales", Name: tc.name})
			s.Relationships = []Relationship{{ID: "reads", Source: "r", Target: "c", Kind: "reads", Provenance: "catalog"}}
			refs, err := s.References("sales.items.total", 1)
			if err != nil {
				t.Fatal(err)
			}
			if got := refs.Paths[0][0].SourceName; got != tc.label {
				t.Errorf("got %q, want %q", got, tc.label)
			}
		})
	}
}
