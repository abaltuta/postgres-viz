package analysis

import (
	"context"
	"slices"
	"testing"

	"postgres-viz/internal/snapshot"
)

func TestFallbackIdentifierBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		want       []string
	}{
		{"quoted aliases", `SELECT id AS "updated from customers", id AS "audit_check()" FROM orders`, []string{"reads orders"}},
		{"distinct from", `SELECT o.id IS DISTINCT FROM customers, o.id IS NOT DISTINCT FROM audit FROM orders o CROSS JOIN (VALUES (17, 18)) settings(customers, audit)`, []string{"reads orders"}},
		{"distinct alias", `SELECT id AS distinct FROM customers`, []string{"reads customers"}},
		{"quoted names", `INSERT INTO "Lab"."Log ""from customers""" (id) SELECT "Lab"."check ()"() AS "audit_check()" FROM "public"."orders"`, []string{"calls check", "inserts log", "reads orders"}},
		{"write targets", `UPDATE ONLY orders SET total = 1; DELETE FROM ONLY customers; TRUNCATE TABLE ONLY audit; MERGE INTO orders USING (VALUES (1)) AS src(id) ON false WHEN MATCHED THEN DO NOTHING`, []string{"deletes audit", "deletes customers", "updates orders", "writes orders"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := scopeCatalog()
			s.Objects = append(s.Objects,
				snapshot.Object{ID: "log", Schema: "Lab", Name: `Log "from customers"`, Kind: "table"},
				snapshot.Object{ID: "check", Schema: "Lab", Name: "check ()", Kind: "function"},
				snapshot.Object{ID: "decoy", Schema: "public", Name: "audit_check", Kind: "function"},
			)
			routines := []snapshot.Routine{
				{ID: "check", Schema: "Lab", Name: "check ()"},
				{ID: "decoy", Schema: "public", Name: "audit_check"},
				{ID: "subject", Schema: "public", Name: "subject", Language: "plpgsql", Definition: "invalid", Body: tc.body},
			}
			if err := Analyze(context.Background(), s, routines); err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, e := range s.Relationships {
				if e.Source != "subject" || e.Provenance != "fallback" {
					t.Fatalf("unexpected relationship %+v", e)
				}
				got = append(got, e.Kind+" "+e.Target)
			}
			slices.Sort(got)
			if !slices.Equal(got, tc.want) {
				t.Errorf("relationships = %v, want %v", got, tc.want)
			}
		})
	}
}
