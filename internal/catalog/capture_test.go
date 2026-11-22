package catalog

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"postgres-viz/internal/snapshot"
)

func TestConnectionErrorRedactsPassword(t *testing.T) {
	_, _, err := Capture(context.Background(), "postgres://user:secret-canary@%invalid", nil, nil, true)
	if err == nil || strings.Contains(err.Error(), "secret-canary") {
		t.Fatal("expected a credential-free connection error")
	}
}

func TestCallParameters(t *testing.T) {
	names := []string{"start", "result", "scale", "extras"}
	modes := []string{"i", "o", "b", "v"}
	for _, tc := range []struct {
		kind string
		want []snapshot.CallParameter
	}{
		{"f", []snapshot.CallParameter{{Name: "start"}, {Name: "scale", Defaulted: true}, {Name: "extras", Variadic: true, Defaulted: true}}},
		{"p", []snapshot.CallParameter{{Name: "start"}, {Name: "result"}, {Name: "scale", Defaulted: true}, {Name: "extras", Variadic: true, Defaulted: true}}},
	} {
		got := callParameters(tc.kind, 3, 2, names, modes)
		if !slices.Equal(got, tc.want) {
			t.Errorf("kind %s: got %+v, want %+v", tc.kind, got, tc.want)
		}
	}
	if got := callParameters("f", 0, 0, nil, nil); got == nil || len(got) != 0 {
		t.Errorf("known zero-argument signature = %#v", got)
	}
}

func TestCapturePostgres(t *testing.T) {
	url := os.Getenv("PGVIZ_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set PGVIZ_TEST_DATABASE_URL to run with PostgreSQL")
	}
	ctx := context.Background()
	db, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal("fixture connection failed")
	}
	defer db.Close(ctx)
	schema := fmt.Sprintf("pgviz_fixture_%d", time.Now().UnixNano())
	helper := schema + "_helper"
	defer db.Exec(ctx, "DROP SCHEMA IF EXISTS "+schema+" CASCADE; DROP SCHEMA IF EXISTS "+helper+" CASCADE")
	sql := `CREATE SCHEMA APP; CREATE SCHEMA AUX; SET search_path=APP;
 CREATE TABLE "Parent.A"(b int,a int,PRIMARY KEY(b,a));
 CREATE TABLE child(x int,y int,unused text, amount int, double_amount int GENERATED ALWAYS AS (amount*2) STORED, CONSTRAINT "paired FK" FOREIGN KEY (x,y) REFERENCES "Parent.A"(b,a));
 CREATE FUNCTION AUX.twice(int) RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT $1*2';
 CREATE FUNCTION AUX.is_positive(int) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT $1>0';
 CREATE FUNCTION AUX.highest() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT max(amount) FROM APP.child; END;
 ALTER TABLE child ADD COLUMN prior int DEFAULT AUX.highest();
 ALTER TABLE child ADD CONSTRAINT positive CHECK(AUX.twice(amount)>=x);
 CREATE INDEX amount_ix ON child(y,AUX.twice(amount)) INCLUDE (unused) WHERE AUX.is_positive(x) AND y>0;
 CREATE FUNCTION sum_amount() RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT sum(AUX.twice(amount)) FROM APP.child; END;
 CREATE PROCEDURE run() LANGUAGE sql AS 'SELECT 1';
 CREATE VIEW summaries AS SELECT sum_amount() AS total FROM child;
 CREATE MATERIALIZED VIEW copies AS SELECT amount FROM child;
 CREATE FUNCTION before_write() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
 CREATE TRIGGER changed BEFORE UPDATE OF amount ON child FOR EACH ROW EXECUTE FUNCTION before_write();`
	if _, err = db.Exec(ctx, strings.NewReplacer("APP", schema, "AUX", helper).Replace(sql)); err != nil {
		t.Fatal(err)
	}
	var version int
	if err = db.QueryRow(ctx, "SELECT current_setting('server_version_num')::int").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version >= 180000 {
		if _, err = db.Exec(ctx, `ALTER TABLE child ADD COLUMN virtual_amount int GENERATED ALWAYS AS (amount + x) VIRTUAL;
 ALTER TABLE child ADD CONSTRAINT required_amount NOT NULL amount`); err != nil {
			t.Fatal(err)
		}
	}
	s, routines, err := Capture(ctx, url, []string{schema}, []string{schema}, true)
	if err != nil {
		t.Fatal(err)
	}
	objs := map[string]string{}
	for _, o := range s.Objects {
		objs[o.Name] = o.ID
	}
	cols := map[string]string{}
	for _, c := range s.Columns {
		cols[c.ObjectID+"/"+c.Name] = c.ID
	}
	child := objs["child"]
	amount := cols[child+"/amount"]
	twice := objs["twice(integer)"]
	if amount == "" || twice == "" || objs["run()"] == "" || cols[child+"/unused"] == "" || len(routines) < 5 {
		t.Fatalf("missing object or column: %v", objs)
	}
	wantEdges := [][3]string{
		{"selects", objs["copies"], amount}, {"calls", objs["summaries"], objs["sum_amount()"]},
		{"reads", objs["sum_amount()"], amount}, {"calls", objs["sum_amount()"], twice},
		{"default", cols[child+"/prior"], objs["highest()"]}, {"reads", objs["highest()"], amount},
		{"default", cols[child+"/double_amount"], amount},
		{"executes", objs["changed"], objs["before_write()"]}, {"update-of", objs["changed"], amount},
	}
	for _, tc := range []struct {
		name string
		want [][2]string
	}{
		{"positive", [][2]string{{"calls", twice}, {"constrains", amount}, {"constrains", cols[child+"/x"]}}},
		{"amount_ix", [][2]string{
			{"calls", twice}, {"calls", objs["is_positive(integer)"]}, {"indexes", cols[child+"/y"]},
			{"reads", amount}, {"reads", cols[child+"/x"]}, {"reads", cols[child+"/unused"]},
		}},
	} {
		want := make(map[[2]string]bool, len(tc.want))
		for _, expected := range tc.want {
			want[expected] = true
		}
		for _, e := range s.Relationships {
			if e.Source != objs[tc.name] {
				continue
			}
			pair := [2]string{e.Kind, e.Target}
			if !want[pair] || e.Provenance != "catalog" {
				t.Errorf("unexpected %s relationship: %+v", tc.name, e)
			}
			delete(want, pair)
		}
		for expected := range want {
			t.Errorf("missing %s relationship %s to %s", tc.name, expected[0], expected[1])
		}
	}
	if version >= 180000 {
		virtual := cols[child+"/virtual_amount"]
		wantEdges = append(wantEdges, [3]string{"default", virtual, amount}, [3]string{"default", virtual, cols[child+"/x"]})
		for _, expected := range []struct{ table, constraint, column string }{
			{"child", "required_amount", "amount"},
			{"Parent.A", "Parent.A_b_not_null", "b"},
			{"Parent.A", "Parent.A_a_not_null", "a"},
		} {
			id := objs[expected.constraint]
			found := false
			for _, o := range s.Objects {
				if o.ID == id && o.Kind == "constraint" && o.ParentID == objs[expected.table] && strings.HasPrefix(o.Detail, "NOT NULL ") {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("missing NOT NULL constraint %s on %s.%s", expected.constraint, expected.table, expected.column)
			}
			wantEdges = append(wantEdges, [3]string{"constrains", id, cols[objs[expected.table]+"/"+expected.column]})
		}
	}
	for _, expected := range wantEdges {
		found := false
		for _, e := range s.Relationships {
			if [3]string{e.Kind, e.Source, e.Target} == expected {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("missing edge %v", expected)
		}
	}
	fk := objs["paired FK"]
	found := 0
	for _, e := range s.Relationships {
		if e.ConstraintID != fk || e.Kind != "fk" {
			continue
		}
		found++
		if e.Position < 1 || e.Position > 2 || e.Source != cols[child+"/"+[]string{"x", "y"}[e.Position-1]] || e.Target != cols[objs["Parent.A"]+"/"+[]string{"b", "a"}[e.Position-1]] {
			t.Errorf("incorrect FK %v", e)
		}
	}
	if found != 2 {
		t.Errorf("expected 2 FK constituents, found %d", found)
	}
	noFK, _, err := Capture(ctx, url, []string{schema}, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range noFK.Relationships {
		if e.Kind == "fk" {
			t.Error("found disabled FK")
		}
	}
}

func TestCaptureForeignKeyDetails(t *testing.T) {
	url := os.Getenv("PGVIZ_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set PGVIZ_TEST_DATABASE_URL to run with PostgreSQL")
	}
	ctx := t.Context()
	db, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal("fixture connection failed")
	}
	defer db.Close(context.Background())
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	var version int
	if err = tx.QueryRow(ctx, "SELECT current_setting('server_version_num')::int").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `CREATE TEMP TABLE fk_parent(id int PRIMARY KEY);
 CREATE TEMP TABLE fk_child(id int CONSTRAINT ordinary_fk REFERENCES fk_parent(id));`); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"ordinary_fk": "FOREIGN KEY"}
	if version >= 180000 {
		if _, err = tx.Exec(ctx, `ALTER TABLE fk_child ADD CONSTRAINT unenforced_fk FOREIGN KEY(id) REFERENCES fk_parent(id) NOT ENFORCED;
 CREATE TEMP TABLE period_parent(scope int4range, span int4range, PRIMARY KEY(scope, span WITHOUT OVERLAPS));
 CREATE TEMP TABLE period_child(scope int4range, stay int4range, CONSTRAINT period_fk FOREIGN KEY(scope, PERIOD stay) REFERENCES period_parent(scope, PERIOD span));`); err != nil {
			t.Fatal(err)
		}
		want["unenforced_fk"] = "FOREIGN KEY (id) REFERENCES fk_parent(id) NOT ENFORCED"
		want["period_fk"] = "FOREIGN KEY (scope, PERIOD stay) REFERENCES period_parent(scope, PERIOD span)"
	}
	var schema string
	if err = tx.QueryRow(ctx, "SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema()").Scan(&schema); err != nil {
		t.Fatal(err)
	}
	// Run the capture SQL inside the fixture transaction so the temporary tables are visible.
	sql := strings.ReplaceAll(catalogSQL, "/*HAS_SQL_BODY*/", "p.prosqlbody IS NOT NULL")
	rows, err := tx.Query(ctx, `SELECT data->>'name', data->>'detail' FROM (`+sql+`) capture
 WHERE category='object' AND data->>'id' LIKE 'fk:%'`, []string{schema}, []string{}, true)
	if err != nil {
		t.Fatal(err)
	}
	var name, detail string
	_, err = pgx.ForEachRow(rows, []any{&name, &detail}, func() error {
		if detail != want[name] {
			t.Errorf("%s detail = %q, want %q", name, detail, want[name])
		}
		delete(want, name)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(want) > 0 {
		t.Errorf("missing foreign keys: %v", want)
	}
}

func TestCaptureSchemaFilters(t *testing.T) {
	url := os.Getenv("PGVIZ_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set PGVIZ_TEST_DATABASE_URL to run with PostgreSQL")
	}
	ctx := context.Background()
	db, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal("fixture connection failed")
	}
	defer db.Close(ctx)
	app := fmt.Sprintf("pgviz_filters_%d", time.Now().UnixNano())
	dependency := " " + app + " dependency "
	quoted := pgx.Identifier{dependency}.Sanitize()
	defer db.Exec(ctx, "DROP SCHEMA IF EXISTS "+app+" CASCADE; DROP SCHEMA IF EXISTS "+quoted+" CASCADE")
	if _, err = db.Exec(ctx, "CREATE SCHEMA "+app+"; CREATE SCHEMA "+quoted+
		"; CREATE TABLE "+quoted+".parent(id int PRIMARY KEY); CREATE TABLE "+app+
		".child(id int CONSTRAINT parent_fk REFERENCES "+quoted+".parent)"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name              string
		include, exclude  []string
		child, parent, fk bool
	}{
		{name: "include dependent", include: []string{app}, child: true},
		{name: "include padded schema", include: []string{dependency}, parent: true},
		{name: "exclude padded schema", exclude: []string{dependency}, child: true},
		{name: "exclude dependent", exclude: []string{app}, parent: true},
		{name: "include both", include: []string{app, dependency}, child: true, parent: true, fk: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _, err := Capture(ctx, url, tc.include, tc.exclude, true)
			if err != nil {
				t.Fatal(err)
			}
			var child, parent bool
			var fk string
			for _, o := range s.Objects {
				child = child || o.Schema == app && o.Name == "child"
				parent = parent || o.Schema == dependency && o.Name == "parent"
				if o.Schema == app && o.Name == "parent_fk" {
					fk = o.ID
				}
			}
			if child != tc.child || parent != tc.parent {
				t.Errorf("captured child=%t, parent=%t; want child=%t, parent=%t", child, parent, tc.child, tc.parent)
			}
			if (fk != "") != tc.fk {
				t.Errorf("foreign key constraint present = %t, want %t", fk != "", tc.fk)
			}
			pair := slices.ContainsFunc(s.Relationships, func(e snapshot.Relationship) bool {
				return e.Kind == "fk" && e.ConstraintID == fk
			})
			if pair != tc.fk {
				t.Errorf("foreign key relationship present = %t, want %t", pair, tc.fk)
			}
			if err := s.Validate(); err != nil {
				t.Errorf("filtered snapshot: %v", err)
			}
		})
	}
}

func TestCaptureSelfForeignKey(t *testing.T) {
	url := os.Getenv("PGVIZ_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set PGVIZ_TEST_DATABASE_URL to run with PostgreSQL")
	}
	ctx := t.Context()
	db, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal("fixture connection failed")
	}
	defer db.Close(context.Background())
	schema := fmt.Sprintf("pgviz_self_fk_%d", time.Now().UnixNano())
	defer func() {
		if _, err := db.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE"); err != nil {
			t.Errorf("drop fixture schema: %v", err)
		}
	}()
	if _, err := db.Exec(ctx, "CREATE SCHEMA "+schema+"; CREATE TABLE "+schema+`.node(
		id_a int, id_b int, parent_a int, discarded int, parent_b int,
		CONSTRAINT node_pk PRIMARY KEY(id_a, id_b),
		CONSTRAINT parent_fk FOREIGN KEY(parent_b, parent_a) REFERENCES `+schema+`.node(id_b, id_a));
		ALTER TABLE `+schema+`.node DROP COLUMN discarded;`); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name      string
		includeFK bool
	}{
		{name: "enabled", includeFK: true},
		{name: "disabled"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _, err := Capture(t.Context(), url, []string{schema}, nil, tc.includeFK)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.Validate(); err != nil {
				t.Fatal(err)
			}
			var constraint, primaryKey, table string
			for _, object := range s.Objects {
				switch object.Name {
				case "parent_fk":
					constraint = object.ID
				case "node_pk":
					primaryKey = object.ID
				case "node":
					table = object.ID
				}
			}
			if primaryKey == "" || table == "" {
				t.Fatal("expected the table and primary key")
			}
			if (constraint != "") != tc.includeFK {
				t.Errorf("foreign key constraint present = %t, want %t", constraint != "", tc.includeFK)
			}
			cols := map[string]string{}
			for _, c := range s.Columns {
				if c.ObjectID == table {
					cols[c.ID] = c.Name
				}
			}
			var pairs [][2]string
			primaryKeyEdges := 0
			for _, e := range s.Relationships {
				if e.Kind == "constrains" && e.Source == primaryKey {
					primaryKeyEdges++
				}
				if e.Kind != "fk" {
					continue
				}
				pairs = append(pairs, [2]string{cols[e.Source], cols[e.Target]})
				if e.ConstraintID != constraint || e.Position != len(pairs) || e.Provenance != "catalog" {
					t.Errorf("incorrect foreign key relationship: %+v", e)
				}
			}
			if primaryKeyEdges != 2 {
				t.Errorf("got %d primary key relationships, want 2", primaryKeyEdges)
			}
			var want [][2]string
			if tc.includeFK {
				want = [][2]string{{"parent_b", "id_b"}, {"parent_a", "id_a"}}
			}
			if !slices.Equal(pairs, want) {
				t.Errorf("foreign key pairs = %v, want %v", pairs, want)
			}
		})
	}
}
