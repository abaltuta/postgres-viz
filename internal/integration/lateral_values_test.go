package integration

import (
	"testing"

	"github.com/jackc/pgx/v5"
	"postgres-viz/internal/snapshot"
)

func exerciseLateralValues(t *testing.T, db *pgx.Conn, scan func(...string) string, read func(string) *snapshot.Snapshot) {
	t.Helper()
	ctx := t.Context()
	if _, err := db.Exec(ctx, `CREATE SCHEMA lineage;
CREATE TABLE lineage.outer_row (v int);
CREATE TABLE lineage.inner_row (v int);
INSERT INTO lineage.outer_row VALUES (11);
INSERT INTO lineage.inner_row VALUES (29);`); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, modifier string
		want           int
	}{
		{"outer_value", "", 11},
		{"inner_value", "LATERAL", 29},
	} {
		sql := "CREATE FUNCTION lineage." + tc.name + `() RETURNS int LANGUAGE sql AS $$
SELECT (SELECT q.column2 FROM lineage.inner_row a, ` + tc.modifier + ` (VALUES (0, a.v)) q)
FROM lineage.outer_row a $$`
		if _, err := db.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
		var got int
		if err := db.QueryRow(ctx, "SELECT lineage."+tc.name+"()").Scan(&got); err != nil || got != tc.want {
			t.Fatalf("%s returned %d, want %d (error %v)", tc.name, got, tc.want, err)
		}
	}
	s := read(scan("--schema", "lineage"))
	if len(s.Diagnostics.Unresolved) != 0 {
		t.Fatalf("unexpected lineage diagnostics: %+v", s.Diagnostics.Unresolved)
	}
	for column, routine := range map[string]string{
		"lineage.outer_row.v": "lineage.outer_value()",
		"lineage.inner_row.v": "lineage.inner_value()",
	} {
		refs, err := s.References(column, 1)
		if err != nil {
			t.Fatal(err)
		}
		if len(refs.Paths) != 1 {
			t.Fatalf("%s expected one reference from %s, got %v", column, routine, refs.Paths)
		}
		hop := refs.Paths[0][0]
		if hop.SourceName != routine || hop.Kind != "reads" || hop.Provenance != "parsed" || len(hop.Evidence) == 0 {
			t.Errorf("%s expected parsed read from %s with evidence, got %+v", column, routine, hop)
		}
	}
}
