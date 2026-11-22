package analysis

import (
	"context"
	"slices"
	"strings"
	"testing"

	"postgres-viz/internal/snapshot"
)

func TestWholeRowReferences(t *testing.T) {
	target := []string{"orders.id", "orders.total", "orders.customer_id", "orders.Display Name"}
	source := []string{"customers.id", "customers.name"}
	cases := []struct {
		name, sql, token string
		reads            []string
	}{
		{"returning target", "UPDATE orders o SET total=1 FROM customers c RETURNING row_to_json(o)", "o)", target},
		{"returning source", "DELETE FROM orders o USING customers c RETURNING row_to_json(c)", "c)", source},
		{"one composite output", "WITH q AS (SELECT o, c.name FROM orders o, customers c) SELECT q.o FROM q", "q.o", target},
		{"expanded output", "WITH q AS (SELECT o.* FROM orders o) SELECT q.total FROM q", "q.total", []string{"orders.total"}},
		{"column before row", "SELECT id FROM orders id", "id FROM", []string{"orders.id"}},
		{"outer column before inner row", "SELECT (SELECT total FROM customers total) FROM orders", "total FROM", []string{"orders.total"}},
		{"nearest row", "SELECT (SELECT o FROM customers o) FROM orders o", "o FROM", source},
		{"correlated row", "SELECT (SELECT o FROM customers c) FROM orders o", "o FROM", target},
		{"projected field", "WITH q AS (SELECT (o).id FROM orders o) SELECT q.id FROM q", "q.id", []string{"orders.id"}},
		{"projected star", "WITH q AS (SELECT (o).* FROM orders o) SELECT q.total FROM q", "q.total", []string{"orders.total"}},
	}
	s := scopeCatalog()
	var routines []snapshot.Routine
	for _, tc := range cases {
		routines = append(routines, snapshot.Routine{ID: tc.name, Schema: "public", Language: "sql", Body: tc.sql, Definition: tc.sql})
	}
	if err := Analyze(context.Background(), s, routines); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, d := range s.Diagnostics.Unresolved {
				if d.OwnerID == tc.name {
					t.Errorf("unexpected diagnostic: %+v", d)
				}
			}
			start := strings.Index(tc.sql, tc.token)
			var got []string
			for _, e := range s.Evidence {
				if e.OwnerID == tc.name && e.Start != nil && *e.Start == start {
					got = append(got, strings.TrimPrefix(e.RelationshipID, "reads|"+tc.name+"|"))
				}
			}
			if !slices.Equal(got, tc.reads) {
				t.Errorf("reads at %q: got %v, want %v", tc.token, got, tc.reads)
			}
			if tc.name == "projected field" {
				for _, edge := range s.Relationships {
					if edge.Source == tc.name && edge.Target != "orders.id" {
						t.Errorf("unexpected read of %s", edge.Target)
					}
				}
			}
		})
	}
}
