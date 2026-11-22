package integration

import (
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"
	"postgres-viz/internal/snapshot"
)

func exerciseImplicitInserts(t *testing.T, db *pgx.Conn, scan func(...string) string, read func(string) *snapshot.Snapshot) {
	t.Helper()
	ctx := t.Context()
	_, err := db.Exec(ctx, `CREATE SCHEMA writes;
CREATE TABLE writes.sink (a int, retired int, b int, c int DEFAULT 17);
ALTER TABLE writes.sink DROP COLUMN retired;
CREATE TABLE writes.src (x int, y int);
INSERT INTO writes.src VALUES (23, 29);
CREATE FUNCTION writes.one() RETURNS void LANGUAGE sql AS $$ INSERT INTO writes.sink VALUES (11) $$;
CREATE FUNCTION writes.two() RETURNS void LANGUAGE plpgsql AS $$ BEGIN INSERT INTO writes.sink SELECT * FROM writes.src; END $$;
SELECT writes.one(), writes.two();`)
	if err != nil {
		t.Fatal(err)
	}
	var rowsMatch bool
	err = db.QueryRow(ctx, `SELECT count(*) = 2 AND
count(*) FILTER (WHERE a = 11 AND b IS NULL AND c = 17) = 1 AND
count(*) FILTER (WHERE a = 23 AND b = 29 AND c = 17) = 1 FROM writes.sink`).Scan(&rowsMatch)
	if err != nil || !rowsMatch {
		t.Fatalf("unexpected rows after implicit INSERTs (error %v)", err)
	}
	s := read(scan("--schema", "writes"))
	for column, want := range map[string][]string{
		"a": {"writes.one()", "writes.two()"},
		"b": {"writes.two()"},
		"c": {},
	} {
		refs, err := s.References("writes.sink."+column, 1)
		if err != nil {
			t.Fatal(err)
		}
		var writers []string
		for _, path := range refs.Paths {
			h := path[0]
			if h.Kind == "inserts" {
				if h.Provenance != "parsed" || len(h.Evidence) == 0 {
					t.Errorf("missing parsed write evidence for %s to %s", h.SourceName, column)
				}
				writers = append(writers, h.SourceName)
			}
		}
		slices.Sort(writers)
		if !slices.Equal(writers, want) {
			t.Errorf("writes.sink.%s writers %v, want %v", column, writers, want)
		}
	}
}
