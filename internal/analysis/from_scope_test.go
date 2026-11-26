package analysis

import (
	"context"
	"slices"
	"strings"
	"testing"

	"postgres-viz/internal/snapshot"
)

func TestFromSubqueryVisibility(t *testing.T) {
	cases := []struct {
		name, query, reads string
	}{
		{"outer alias", "SELECT (SELECT q.v FROM customers a CROSS JOIN (SELECT a.id AS v) q) FROM orders a", "orders.id"},
		{"lateral alias", "SELECT (SELECT q.v FROM customers a CROSS JOIN LATERAL (SELECT a.id AS v) q) FROM orders a", "customers.id"},
		{"comma outer column", "SELECT (SELECT q.v FROM customers, (SELECT id AS v) q) FROM orders", "orders.id"},
		{"nested join outer alias", "SELECT (SELECT q.v FROM customers a, audit b CROSS JOIN (SELECT a.id AS v) q) FROM orders a", "orders.id"},
		{"nested join lateral alias", "SELECT (SELECT q.v FROM customers a, audit b CROSS JOIN LATERAL (SELECT a.id AS v) q) FROM orders a", "customers.id"},
		{"same level CTE", "WITH c AS (SELECT id FROM orders) SELECT q.id FROM customers CROSS JOIN (SELECT id FROM c) q", "orders.id"},
		{"correlated join condition", "SELECT (SELECT 1 FROM customers a, audit b JOIN audit c ON a.id = c.id) FROM orders a", "audit.id orders.id"},
		{"implicit function label", "SELECT (SELECT sum FROM (SELECT sum(o.total) FROM orders o) q) FROM audit", "orders.total"},
		{"qualified function in CTE", "WITH totals AS (SELECT pg_catalog.sum(o.total) FROM orders o) SELECT (SELECT sum FROM totals) FROM audit", "orders.total"},
		{"explicit alias overrides function label", "SELECT (SELECT sum FROM (SELECT sum(o.total) AS amount FROM orders o) q) FROM audit", "audit.sum orders.total"},
		{"cast column label", "SELECT (SELECT id FROM (SELECT o.id::bigint FROM orders o) q) FROM audit", "orders.id"},
		{"nested cast column label", "SELECT (SELECT id FROM (SELECT CAST(o.id AS bigint)::numeric FROM orders o) q) FROM audit", "orders.id"},
		{"cast function label", "SELECT (SELECT sum FROM (SELECT pg_catalog.sum(o.total)::numeric FROM orders o) q) FROM audit", "orders.total"},
		{"cast type label", "SELECT (SELECT int8 FROM (SELECT (o.total + o.id)::bigint FROM orders o) q) FROM audit", "orders.id orders.total"},
		{"outer cast type label", `SELECT (SELECT "numeric" FROM (SELECT 1::bigint::numeric) q) FROM audit`, ""},
		{"cast with unmodeled argument label", "SELECT (SELECT int8 FROM (SELECT GREATEST(1, 2)::bigint) q) FROM audit", "audit.int8"},
		{"explicit alias overrides cast label", "SELECT (SELECT id + amount FROM (SELECT o.id::bigint AS amount FROM orders o) q) FROM audit", "audit.id orders.id"},
	}
	for _, language := range []string{"sql", "plpgsql"} {
		s := scopeCatalog()
		s.Columns = append(s.Columns,
			snapshot.Column{ID: "audit.sum", ObjectID: "audit", Name: "sum", Position: 3},
			snapshot.Column{ID: "audit.int8", ObjectID: "audit", Name: "int8", Position: 4},
			snapshot.Column{ID: "audit.numeric", ObjectID: "audit", Name: "numeric", Position: 5},
		)
		var routines []snapshot.Routine
		for _, tc := range cases {
			body := tc.query
			if language == "plpgsql" {
				body = "BEGIN RETURN QUERY " + body + "; END"
			}
			routines = append(routines, snapshot.Routine{
				ID: tc.name, Name: "f", Schema: "public", Language: language, Body: body,
				Definition: "CREATE FUNCTION f() RETURNS SETOF integer LANGUAGE " + language + " AS $$" + body + "$$",
			})
		}
		if err := Analyze(context.Background(), s, routines); err != nil {
			t.Fatal(err)
		}
		if len(s.Diagnostics.Unresolved) != 0 || len(s.Diagnostics.Warnings) != 0 {
			t.Errorf("%s diagnostics: %+v", language, s.Diagnostics)
		}
		for _, tc := range cases {
			t.Run(language+"/"+tc.name, func(t *testing.T) {
				var reads []string
				for _, e := range s.Relationships {
					if e.Source == tc.name && e.Kind == "reads" && strings.Contains(e.Target, ".") {
						reads = append(reads, e.Target)
					}
				}
				slices.Sort(reads)
				if !slices.Equal(reads, strings.Fields(tc.reads)) {
					t.Errorf("column reads %v, want %s", reads, tc.reads)
				}
			})
		}
	}
}
