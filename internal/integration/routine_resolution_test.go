package integration

import (
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"
	"postgres-viz/internal/snapshot"
)

func exerciseRoutineResolution(t *testing.T, db *pgx.Conn, scan func(...string) string, read func(string) *snapshot.Snapshot) {
	t.Helper()
	ctx := t.Context()
	_, err := db.Exec(ctx, `CREATE SCHEMA review;
CREATE SCHEMA "Actual, Data";
CREATE TABLE review.orders(total int);
CREATE TABLE "Actual, Data".orders(total int);
INSERT INTO review.orders VALUES (10);
INSERT INTO "Actual, Data".orders VALUES (20);
CREATE FUNCTION review.by_path() RETURNS int LANGUAGE sql SET search_path = "Actual, Data", review
  AS $$ SELECT total FROM orders $$;
CREATE FUNCTION review.sampled() RETURNS int LANGUAGE sql
  AS $$ SELECT o.total FROM review.orders AS o TABLESAMPLE BERNOULLI(100) REPEATABLE(1) $$;
CREATE FUNCTION review.forward_cte() RETURNS int LANGUAGE sql
  AS $$ WITH RECURSIVE first_pass AS (SELECT total FROM orders), orders AS
  (SELECT total FROM "Actual, Data".orders) SELECT total FROM first_pass $$;`)
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]int{"by_path": 20, "sampled": 10, "forward_cte": 20} {
		var got int
		if err := db.QueryRow(ctx, "SELECT review."+name+"()").Scan(&got); err != nil || got != want {
			t.Fatalf("%s: got %d, want %d (%v)", name, got, want, err)
		}
	}
	s := read(scan("--schema", "review", "--schema", "Actual, Data"))
	for column, want := range map[string][]string{
		"review.orders.total":         {"review.sampled()"},
		`"Actual, Data".orders.total`: {"review.by_path()", "review.forward_cte()"},
	} {
		refs, err := s.References(column, 1)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, path := range refs.Paths {
			got = append(got, path[0].SourceName)
		}
		slices.Sort(got)
		if !slices.Equal(got, want) {
			t.Errorf("%s: got %v, want %v", column, got, want)
		}
	}
	if len(s.Diagnostics.Unresolved) != 0 {
		t.Errorf("unexpected unresolved references: %+v", s.Diagnostics.Unresolved)
	}
}
