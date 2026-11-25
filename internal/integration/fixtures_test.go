package integration

import (
	"context"
	"crypto/rand"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"postgres-viz/internal/snapshot"
)

// Run against a PostgreSQL test server whose user may create databases.
// Each schema installs into its own disposable database, including public.
func TestCaptureFixtures(t *testing.T) {
	conn := os.Getenv("DATABASE_URL")
	if conn == "" {
		t.Skip("set DATABASE_URL to run PostgreSQL fixture captures")
	}
	adminURL, err := url.Parse(conn)
	if err != nil || (adminURL.Scheme != "postgres" && adminURL.Scheme != "postgresql") {
		t.Fatal("DATABASE_URL must be a PostgreSQL URI")
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	binary := os.Getenv("PGVIZ_BINARY")
	if binary == "" {
		binary = filepath.Join(root, "dist", "postgres-viz")
	}
	binary, err = filepath.Abs(binary)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(binary); err != nil {
		t.Fatalf("build postgres-viz and set PGVIZ_BINARY: %v", err)
	}
	admin, err := pgx.Connect(t.Context(), conn)
	if err != nil {
		t.Fatal("cannot connect to fixture administrator database")
	}
	defer admin.Close(context.Background())
	var version int
	if err := admin.QueryRow(t.Context(), "SELECT current_setting('server_version_num')::int").Scan(&version); err != nil {
		t.Fatalf("read fixture server version: %v", err)
	}
	major := version / 10000
	if requested := os.Getenv("PGVIZ_POSTGRES_MAJOR"); requested != "" && requested != strconv.Itoa(major) {
		t.Fatalf("fixture server runs PostgreSQL %d, requested %q", major, requested)
	}
	t.Logf("PostgreSQL server_version_num=%d", version)
	for _, name := range []string{"simple", "commerce", "routines", "regression"} {
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(root, "examples", name)
			expected := filepath.Join(dir, name+".pgviz.json")
			if name == "regression" {
				dir = filepath.Join(root, "test", "fixtures", name)
				expected = filepath.Join(dir, "expected.pgviz.json")
			}
			sql, err := os.ReadFile(filepath.Join(dir, "schema.sql"))
			if err != nil {
				t.Fatal(err)
			}
			fixture := *adminURL
			dbName := "pgviz_test_" + strings.ToLower(rand.Text())
			fixture.Path = "/" + dbName
			fixture.RawPath = ""
			params := fixture.Query()
			params.Del("dbname")
			params.Del("database")
			fixture.RawQuery = params.Encode()
			quoted := pgx.Identifier{dbName}.Sanitize()
			if _, err = admin.Exec(t.Context(), "CREATE DATABASE "+quoted+" TEMPLATE template0"); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				defer cancel()
				if _, err := admin.Exec(ctx, "DROP DATABASE "+quoted); err != nil {
					t.Errorf("drop fixture database: %v", err)
				}
			})
			db, err := pgx.Connect(t.Context(), fixture.String())
			if err != nil {
				t.Fatal("cannot connect to fixture database")
			}
			defer db.Close(context.Background())
			var connected string
			if err = db.QueryRow(t.Context(), "SELECT current_database()").Scan(&connected); err != nil || connected != dbName {
				t.Fatal("fixture connection opened the wrong database")
			}
			if _, err = db.Exec(t.Context(), string(sql)); err != nil {
				t.Fatal(err)
			}
			if name == "routines" {
				exerciseProcedure(t, db)
			}
			scan := func(args ...string) string {
				t.Helper()
				path := filepath.Join(t.TempDir(), "captured snapshot.pgviz.json")
				cmd := exec.CommandContext(t.Context(), binary, append([]string{"scan", "--out", path}, args...)...)
				cmd.Env = append(os.Environ(), "DATABASE_URL="+fixture.String())
				if out, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("CLI scan failed: %v\n%s", err, out)
				}
				return path
			}
			capture := scan()
			read := func(path string) *snapshot.Snapshot {
				t.Helper()
				raw, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				s, err := snapshot.Read(raw)
				if err != nil {
					t.Fatal(err)
				}
				return s
			}
			want, actual := read(expected), read(capture)
			if actual.Database != dbName {
				t.Fatalf("scan captured unexpected database %q", actual.Database)
			}
			if name == "regression" {
				expectCurrentParser(t, want, actual)
			}
			if version >= 180000 {
				expectNotNullConstraints(t, name, want)
			}
			compareFixture(t, want, actual)
			if name != "regression" {
				schema := "absent"
				if name == "commerce" {
					schema = "reporting"
				}
				raw, err := os.ReadFile(scan("--schema", schema, "--no-fks"))
				if err != nil {
					t.Fatal(err)
				}
				subset, err := snapshot.Read(raw)
				if err != nil {
					t.Fatal(err)
				}
				for _, e := range subset.Relationships {
					if e.Kind == "fk" {
						t.Error("schema-filtered scan contains disabled FK")
					}
				}
				if schema == "absent" && len(subset.Objects) > 0 {
					t.Fatal("expected empty inventory")
				}
				if schema == "reporting" {
					found := false
					for _, o := range subset.Objects {
						if o.Kind == "table" && o.Schema != schema {
							t.Errorf("filtered scan includes table %s.%s", o.Schema, o.Name)
						}
						if o.Schema == "billing" && strings.HasPrefix(o.Name, "invoice_total(") {
							found = true
						}
					}
					if !found {
						t.Error("missing out-of-scope dependency billing.invoice_total")
					}
				}
			}
			if name == "simple" && !t.Failed() {
				exerciseLateralValues(t, db, scan, read)
				exerciseImplicitInserts(t, db, scan, read)
				exerciseRoutineResolution(t, db, scan, read)
				exerciseServerFeatures(t, db, major, scan)
			}
		})
	}
}

func exerciseProcedure(t *testing.T, db *pgx.Conn) {
	t.Helper()
	ctx := t.Context()
	if _, err := db.Exec(ctx, `INSERT INTO ledger.accounts VALUES (1,10,'unused');
 INSERT INTO ledger.entries VALUES (1,2.345,'unused');
 CALL ledger.post_deltas(1,NULL);`); err != nil {
		t.Fatal(err)
	}
	var balance, previous float64
	if err := db.QueryRow(ctx, `SELECT a.balance::float8,j.previous_balance::float8
 FROM ledger.accounts a JOIN ledger.journal j ON j.account_id=a.id`).Scan(&balance, &previous); err != nil {
		t.Fatal(err)
	}
	if balance != 12.35 || previous != 10 {
		t.Fatalf("procedure balance %v, previous %v", balance, previous)
	}
	if _, err := db.Exec(ctx, "CALL ledger.post_deltas(1,'ledger.pending')"); err != nil {
		t.Fatal(err)
	}
	var delta float64
	if err := db.QueryRow(ctx, "SELECT delta::float8 FROM ledger.pending").Scan(&delta); err != nil || delta != 2.35 {
		t.Fatalf("dynamic procedure delta %v, error %v", delta, err)
	}
}
