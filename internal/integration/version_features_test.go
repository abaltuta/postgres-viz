package integration

import (
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"postgres-viz/internal/snapshot"
)

// Run the newer syntax on the real server, then check what the CLI records.
// This fixture lives in the disposable simple database after its parity gate.
func exerciseServerFeatures(t *testing.T, db *pgx.Conn, major int, scan func(...string) string) {
	t.Helper()
	if major < 17 {
		return
	}
	ctx := t.Context()
	if _, err := db.Exec(ctx, `CREATE SCHEMA dialect;
CREATE TABLE dialect.orders(id int PRIMARY KEY, total int, payload jsonb, spare text);
INSERT INTO dialect.orders VALUES (1, 10, '{"key":42}', 'unused'), (2, 20, '{}', 'unchanged');`); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		major                        int
		name, language, body, column string
		result                       int
	}{
		{17, "json_value", "sql", `SELECT j.value FROM dialect.orders o,
 JSON_TABLE(o.payload, '$' COLUMNS (value int PATH '$.key')) AS j WHERE o.id = 1`, "payload", 42},
		{18, "price_change", "sql", `UPDATE dialect.orders SET total = 15 WHERE id = 1
 RETURNING WITH (OLD AS prior, NEW AS current_row) current_row.total - prior.total`, "total", 5},
		{18, "pl_price_change", "plpgsql", `BEGIN
 RETURN QUERY UPDATE dialect.orders SET total=total+1 WHERE id=1
 RETURNING WITH (OLD AS p, NEW AS n) n.total-p.total;
 END`, "total", 1},
		{19, "existing_price", "sql", `INSERT INTO dialect.orders(id,total) VALUES (2,99)
 ON CONFLICT (id) DO SELECT RETURNING total`, "total", 20},
	}
	for _, tc := range cases {
		if major < tc.major {
			continue
		}
		name := "dialect." + tc.name + "()"
		if _, err := db.Exec(ctx, "CREATE FUNCTION "+name+" RETURNS SETOF int LANGUAGE "+tc.language+" AS $$"+tc.body+"$$"); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var result int
		if err := db.QueryRow(ctx, "SELECT "+name).Scan(&result); err != nil || result != tc.result {
			t.Fatalf("%s returned %d, want %d (error %v)", name, result, tc.result, err)
		}
	}
	raw, err := os.ReadFile(scan("--schema", "dialect"))
	if err != nil {
		t.Fatal(err)
	}
	s, err := snapshot.Read(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Diagnostics.Warnings) != 0 || len(s.Diagnostics.Unresolved) != 0 {
		t.Fatalf("unexpected dialect diagnostics: %+v", s.Diagnostics)
	}
	for _, tc := range cases {
		if major < tc.major {
			continue
		}
		refs, err := s.References("dialect.orders."+tc.column, 1)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, path := range refs.Paths {
			h := path[0]
			if h.SourceName == "dialect."+tc.name+"()" && h.Kind == "reads" && h.Provenance == "parsed" && len(h.Evidence) != 0 {
				found = true
			}
		}
		if !found {
			t.Errorf("no parsed read with evidence from %s to orders.%s", tc.name, tc.column)
		}
	}
}
