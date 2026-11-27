package analysis

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"

	"postgres-viz/internal/snapshot"
)

func scopeCatalog() *snapshot.Snapshot {
	s := &snapshot.Snapshot{}
	for _, row := range [][]string{
		{"orders", "id", "total", "customer_id", "Display Name"},
		{"customers", "id", "name"},
		{"audit", "id", "note"},
	} {
		name := row[0]
		s.Objects = append(s.Objects, snapshot.Object{ID: name, Name: name, Schema: "public", Kind: "table"})
		for i, col := range row[1:] {
			s.Columns = append(s.Columns, snapshot.Column{ID: name + "." + col, ObjectID: name, Name: col, Position: i + 1})
		}
	}
	return s
}

func TestSQLScopesAndWrites(t *testing.T) {
	cases := []struct {
		name, sql string
		edges     []string
	}{
		{"using", "SELECT 1 FROM orders o, customers c JOIN audit a USING (id)", []string{"reads orders", "reads customers.id", "reads audit.id"}},
		{"set limit", "SELECT 1 UNION ALL SELECT 2 LIMIT (SELECT count(id) FROM customers)", []string{"reads customers.id"}},
		{"set offset", "SELECT 1 INTERSECT SELECT 2 OFFSET (SELECT count(id) FROM orders)", []string{"reads orders.id"}},
		{"simple limit and offset", "SELECT 1 LIMIT (SELECT count(id) FROM customers) OFFSET (SELECT count(id) FROM orders)", []string{"reads customers.id", "reads orders.id"}},
		{"natural", "SELECT id FROM orders NATURAL JOIN customers", []string{"reads orders.id", "reads customers.id"}},
		{"nested", "SELECT count(*) FROM orders WHERE EXISTS (WITH orders AS (SELECT 1) SELECT 1 FROM orders)", []string{"reads orders"}},
		{"sample arguments", "SELECT (SELECT o.total FROM orders o TABLESAMPLE SYSTEM(c.id) REPEATABLE(c.id)) FROM customers c", []string{"reads customers.id", "reads orders.total"}},
		{"recursive anchor", "WITH RECURSIVE audit(n) AS (SELECT total FROM orders UNION ALL SELECT n+1 FROM audit WHERE n<3) SELECT n FROM audit", []string{"reads orders.total"}},
		{"forward CTE", "WITH RECURSIVE first_pass AS (SELECT n FROM orders), orders(n) AS (SELECT id FROM customers) SELECT n FROM first_pass", []string{"reads customers.id"}},
		{"ordinary CTE sees physical table", "WITH first_pass AS (SELECT total FROM orders), orders AS (SELECT 1) SELECT total FROM first_pass", []string{"reads orders.total"}},
		{"nested CTE shadows forward sibling", "WITH RECURSIVE a AS (WITH orders(n) AS (SELECT total FROM public.orders) SELECT n FROM orders), orders(n) AS (SELECT id FROM customers) SELECT n FROM a", []string{"reads orders.total", "reads customers.id"}},
		{"join alias", "SELECT j.debit, j.who FROM (orders o JOIN customers c ON c.id=o.customer_id) j(key,debit,cid,label,pk,who)", []string{"reads orders.total", "reads orders.customer_id", "reads customers.id", "reads customers.name"}},
		{"order alias", "SELECT o.total AS id FROM orders o ORDER BY id", []string{"reads orders.total"}},
		{"implicit coalesce output", `SELECT (SELECT "coalesce" FROM (SELECT COALESCE(1, 2)) s) FROM t`, []string{"reads t"}},
		{"explicit coalesce output", `SELECT (SELECT "coalesce" + renamed FROM (SELECT COALESCE(1, 2) AS renamed) s) FROM t`, []string{"reads t.coalesce"}},
		{"set operation", "WITH all_ids(k) AS (SELECT o.customer_id FROM orders o UNION ALL SELECT c.id FROM customers c) SELECT v.id FROM all_ids AS v(id)", []string{"reads orders.customer_id", "reads customers.id"}},
		{"star", "WITH picked AS (SELECT o.* FROM orders o JOIN customers c ON c.id=o.customer_id) SELECT p.total FROM picked p", []string{"reads orders.id", "reads orders.total", "reads orders.customer_id", "reads orders.Display Name", "reads customers.id"}},
		{"insert select", `INSERT INTO orders (customer_id, "Display Name") SELECT id, name FROM customers`, []string{"inserts orders.customer_id", "inserts orders.Display Name", "reads customers.id", "reads customers.name"}},
		{"upsert", "INSERT INTO orders(id,total) VALUES(1,2) ON CONFLICT (id) DO UPDATE SET total=excluded.total", []string{"inserts orders.id", "inserts orders.total", "updates orders.total", "reads orders.id", "reads orders.total"}},
		{"insert conflict do nothing", "INSERT INTO orders (id, total) VALUES (1, 2) ON CONFLICT (id) DO NOTHING", []string{"inserts orders.id", "inserts orders.total", "reads orders.id"}},
		{"delete returning", "DELETE FROM orders o USING customers c WHERE o.customer_id = c.id RETURNING *", []string{"deletes orders", "reads orders.id", "reads orders.total", "reads orders.customer_id", "reads orders.Display Name", "reads customers.id", "reads customers.name"}},
		{"merge", "MERGE INTO orders o USING customers c ON c.id=o.customer_id WHEN MATCHED AND c.name IS NULL THEN DELETE WHEN MATCHED THEN UPDATE SET total=2 WHEN NOT MATCHED THEN INSERT (id,total) VALUES(c.id,0)", []string{"reads customers.id", "reads customers.name", "reads orders.customer_id", "deletes orders", "updates orders.total", "inserts orders.id", "inserts orders.total"}},
		{"merge returning", "MERGE INTO orders o USING customers c ON c.id=o.customer_id WHEN MATCHED THEN UPDATE SET total=2 RETURNING c.name", []string{"reads customers.id", "reads customers.name", "reads orders.customer_id", "updates orders.total"}},
		{"ambiguous", "SELECT id FROM orders o JOIN customers c ON true", []string{"reads orders", "reads customers"}},
		{"quoted", `SELECT '🍋', o."Display Name" FROM orders AS o`, []string{"reads orders.Display Name"}},
	}
	s := scopeCatalog()
	s.Objects = append(s.Objects, snapshot.Object{ID: "t", Name: "t", Schema: "public", Kind: "table"})
	s.Columns = append(s.Columns, snapshot.Column{ID: "t.coalesce", ObjectID: "t", Name: "coalesce", Position: 1})
	var routines []snapshot.Routine
	for i, tc := range cases {
		id := fmt.Sprintf("f%d", i)
		routines = append(routines, snapshot.Routine{ID: id, Name: id, Schema: "public", Language: "sql", Body: tc.sql, Definition: tc.sql})
	}
	if err := Analyze(context.Background(), s, routines); err != nil {
		t.Fatal(err)
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			for _, e := range s.Relationships {
				if e.Source == routines[i].ID {
					got = append(got, e.Kind+" "+e.Target)
				}
			}
			slices.Sort(got)
			slices.Sort(tc.edges)
			if !slices.Equal(got, tc.edges) {
				t.Fatalf("got %v, want %v", got, tc.edges)
			}
		})
	}
	if len(s.Diagnostics.Unresolved) != 1 || s.Diagnostics.Unresolved[0].Reason != "ambiguous" {
		t.Fatalf("diagnostics: %+v", s.Diagnostics.Unresolved)
	}
	lastRoutine := routines[len(routines)-1]
	sql16 := utf16.Encode([]rune(lastRoutine.Body))
	for _, e := range s.Evidence {
		if e.OwnerID == lastRoutine.ID && e.Start != nil && e.End != nil && string(utf16.Decode(sql16[*e.Start:*e.End])) == `o."Display Name"` {
			return
		}
	}
	t.Fatal("missing exact UTF-16 range for quoted identifier following a non-BMP character")
}

func TestJSONTableColumns(t *testing.T) {
	s := scopeCatalog()
	body := `SELECT j.value, j.seq, json_table.customer
FROM orders o,
     JSON_TABLE(to_jsonb(o.total), '$' COLUMNS (
         value_from_json numeric PATH '$',
         NESTED PATH '$' COLUMNS (seq FOR ORDINALITY)
     )) AS j(value),
     JSON_TABLE(to_jsonb(o.customer_id), '$' COLUMNS (customer int PATH '$'));`
	routine := snapshot.Routine{ID: "json_table", Name: "json_values", Schema: "public", Language: "sql", Body: body}
	if err := Analyze(context.Background(), s, []snapshot.Routine{routine}); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, edge := range s.Relationships {
		got = append(got, edge.Kind+" "+edge.Target)
	}
	slices.Sort(got)
	want := []string{"reads orders.customer_id", "reads orders.total"}
	if !slices.Equal(got, want) {
		t.Errorf("relationships: got %v, want %v", got, want)
	}
	if len(s.Diagnostics.Unresolved) != 0 {
		t.Errorf("unresolved references: %+v", s.Diagnostics.Unresolved)
	}
}

func TestSelectNameResolution(t *testing.T) {
	cases := []struct {
		name, sql, ref, target, reason string
	}{
		{"order alias", "SELECT total AS id FROM orders ORDER BY id", "id", "orders.total", ""},
		{"collate", `SELECT q.name FROM (SELECT name COLLATE "C" FROM customers) q`, "q.name", "customers.name", ""},
		{"collate with cast", `SELECT q.name FROM (SELECT (name COLLATE "C")::text FROM customers) q`, "q.name", "customers.name", ""},
		{"collate unnamed literal", `SELECT q."?column?" FROM (SELECT 'x' COLLATE "C") q`, `q."?column?"`, "", ""},
		{"collate with cast label", `SELECT q.text FROM (SELECT 'x'::text COLLATE "C") q`, "q.text", "", ""},
		{"collate with alias", `SELECT q.label FROM (SELECT name COLLATE "C" AS label FROM customers) q`, "q.label", "customers.name", ""},
		{"collated scalar subquery", `SELECT q.name FROM (SELECT (SELECT name FROM customers LIMIT 1) COLLATE "C") q`, "q.name", "customers.name", ""},
		{"grouping", `SELECT q.grouping FROM (SELECT GROUPING(id) FROM orders GROUP BY id) q`, "q.grouping", "orders.id", ""},
		{"grouping with cast", `SELECT q.grouping FROM (SELECT GROUPING(id)::bigint FROM orders GROUP BY id) q`, "q.grouping", "orders.id", ""},
		{"grouping with alias", `SELECT q.mask FROM (SELECT GROUPING(id) AS mask FROM orders GROUP BY id) q`, "q.mask", "orders.id", ""},
		{"null test", `SELECT q."?column?" FROM (SELECT id IS NULL FROM orders) q`, `q."?column?"`, "orders.id", ""},
		{"null test with cast", `SELECT q.bool FROM (SELECT (id IS NOT NULL)::boolean FROM orders) q`, "q.bool", "orders.id", ""},
		{"null test in CASE", `SELECT q."case" FROM (SELECT CASE WHEN false THEN true ELSE id IS NULL END FROM orders) q`, `q."case"`, "orders.id", ""},
		{"boolean test", `SELECT q."?column?" FROM (SELECT NULL IS UNKNOWN) q`, `q."?column?"`, "", ""},
		{"boolean test with cast", `SELECT q.bool FROM (SELECT (id = 1 IS NOT TRUE)::boolean FROM orders) q`, "q.bool", "orders.id", ""},
		{"boolean test in CASE", `SELECT q."case" FROM (SELECT CASE WHEN false THEN true ELSE (id = 1) IS FALSE END FROM orders) q`, `q."case"`, "orders.id", ""},
		{"JSON object with cast", `SELECT q.json_object FROM (SELECT JSON_OBJECT('key' VALUE id)::text FROM customers) q`, "q.json_object", "customers.id", ""},
		{"JSON array", `SELECT q.json_array FROM (SELECT JSON_ARRAY(7)) q`, "q.json_array", "", ""},
		{"JSON array with cast", `SELECT q.json_array FROM (SELECT JSON_ARRAY(id)::text FROM orders) q`, "q.json_array", "orders.id", ""},
		{"JSON array with query", `SELECT q.json_array FROM (SELECT JSON_ARRAY(SELECT id FROM orders)) q`, "q.json_array", "orders.id", ""},
		{"JSON array aggregate", `SELECT q.json_arrayagg FROM (SELECT JSON_ARRAYAGG(7)) q`, "q.json_arrayagg", "", ""},
		{"JSON array aggregate with cast", `SELECT q.json_arrayagg FROM (SELECT JSON_ARRAYAGG(id)::text FROM orders) q`, "q.json_arrayagg", "orders.id", ""},
		{"JSON array aggregate with alias", `SELECT q.totals FROM (SELECT JSON_ARRAYAGG(total) AS totals FROM orders) q`, "q.totals", "orders.total", ""},
		{"XML serialize", `SELECT q.xmlserialize FROM (SELECT XMLSERIALIZE(CONTENT XML '<r/>' AS text)) q`, "q.xmlserialize", "", ""},
		{"XML serialize with cast", `SELECT q.xmlserialize FROM (SELECT XMLSERIALIZE(CONTENT XMLELEMENT(NAME r, total) AS text)::varchar FROM orders) q`, "q.xmlserialize", "orders.total", ""},
		{"XML serialize with alias", `SELECT q.serialized FROM (SELECT XMLSERIALIZE(CONTENT XMLELEMENT(NAME r, total) AS text) AS serialized FROM orders) q`, "q.serialized", "orders.total", ""},
		{"JSON object function", `SELECT q.json_object FROM (SELECT pg_catalog.json_object(ARRAY['key', name])::text FROM customers) q`, "q.json_object", "customers.name", ""},
		{"order expression", "SELECT total AS id FROM orders ORDER BY id + 1", "id", "orders.id", ""},
		{"group alias", "SELECT total AS amount FROM orders GROUP BY amount", "amount", "orders.total", ""},
		{"group input", "SELECT count(*) AS id FROM orders GROUP BY id", "id", "orders.id", ""},
		{"group expression", "SELECT sum(total) AS id FROM orders GROUP BY id + 1", "id", "orders.id", ""},
		{"grouping set alias", "SELECT total AS amount FROM orders GROUP BY GROUPING SETS ((id, amount), ())", "amount", "orders.total", ""},
		{"distinct alias", "SELECT DISTINCT ON (ID) total AS id FROM orders", "ID", "orders.total", ""},
		{"distinct expression", "SELECT DISTINCT ON (ID + 1) total AS id FROM orders", "ID", "orders.id", ""},
		{"schema qualified", "SELECT public.orders.id FROM public.orders CROSS JOIN billing.orders", "public.orders.id", "orders.id", ""},
		{"implicit schema", "SELECT public.orders.id FROM orders", "public.orders.id", "orders.id", ""},
		{"schema across scopes", "SELECT (SELECT public.orders.id FROM billing.orders) FROM orders", "public.orders.id", "orders.id", ""},
		{"qualified update", "UPDATE orders SET total = billing.orders.id FROM billing.orders WHERE public.orders.id = 1", "public.orders.id", "orders.id", ""},
		{"hidden by alias", "SELECT public.orders.id FROM public.orders AS orders", "public.orders.id", "", "missing"},
		{"hidden by join alias", "SELECT public.orders.id FROM (public.orders JOIN customers ON true) j", "public.orders.id", "", "missing"},
		{"ambiguous relation", "SELECT orders.id FROM public.orders CROSS JOIN billing.orders", "orders.id", "", "ambiguous"},
		{"CTE alias isolation", "WITH q AS (SELECT total FROM orders) SELECT a.first, b.second FROM q AS a(first) JOIN q AS b(second) ON true", "a.first", "orders.total", ""},
		{"correlated unqualified", "SELECT EXISTS (SELECT 1 FROM customers WHERE customer_id = id) FROM orders", "customer_id", "orders.customer_id", ""},
	}
	s := scopeCatalog()
	s.Objects = append(s.Objects, snapshot.Object{ID: "billing.orders", Schema: "billing", Name: "orders", Kind: "table"})
	s.Columns = append(s.Columns, snapshot.Column{ID: "billing.orders.id", ObjectID: "billing.orders", Name: "id", Position: 1})
	var routines []snapshot.Routine
	for _, tc := range cases {
		routines = append(routines, snapshot.Routine{ID: tc.name, Schema: "public", SearchPath: []string{"public"}, Language: "sql", Body: tc.sql})
	}
	if err := Analyze(context.Background(), s, routines); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var diagnostics []string
			for _, d := range s.Diagnostics.Unresolved {
				if d.OwnerID == tc.name {
					diagnostics = append(diagnostics, d.Reason+" "+d.Identifier)
				}
			}
			var want []string
			if tc.reason != "" {
				want = []string{tc.reason + " " + tc.ref}
			}
			if !slices.Equal(diagnostics, want) {
				t.Errorf("diagnostics %v, want %v", diagnostics, want)
			}
			start := strings.LastIndex(tc.sql, tc.ref)
			end := start + len(tc.ref)
			var edges []string
			for _, e := range s.Evidence {
				if e.OwnerID == tc.name && e.Start != nil && e.End != nil && *e.Start == start && *e.End == end {
					edges = append(edges, e.RelationshipID)
				}
			}
			want = nil
			if tc.target != "" {
				want = []string{"reads|" + tc.name + "|" + tc.target}
			}
			if !slices.Equal(edges, want) {
				t.Errorf("evidence at %q refers to %v, want %v", tc.ref, edges, want)
			}
		})
	}
}

func TestImplicitOutputNamesInPLpgSQL(t *testing.T) {
	s := scopeCatalog()
	body := `BEGIN
		PERFORM q.name FROM (SELECT name COLLATE "C" FROM customers) q;
		PERFORM q.grouping FROM (SELECT GROUPING(id) FROM orders GROUP BY id) q;
		PERFORM q."?column?" FROM (SELECT id IS NULL FROM orders) q;
		PERFORM b."?column?" FROM (SELECT (total > 0) IS UNKNOWN FROM orders) b;
		PERFORM q.json_object FROM (SELECT JSON_OBJECT(name VALUE id) FROM customers) q;
		PERFORM q.json_array FROM (SELECT JSON_ARRAY(name) FROM customers) q;
		PERFORM a.json_arrayagg FROM (SELECT JSON_ARRAYAGG(total ORDER BY id) FILTER (WHERE customer_id > 0) FROM orders) a;
		PERFORM q.xmlserialize FROM (SELECT XMLSERIALIZE(CONTENT XMLELEMENT(NAME r, name) AS text) FROM customers) q;
	END`
	routine := snapshot.Routine{ID: "implicit_outputs", Name: "implicit_outputs", Schema: "public", Language: "plpgsql", Returns: "void", Body: body,
		Definition: "CREATE FUNCTION implicit_outputs() RETURNS void LANGUAGE plpgsql AS $$" + body + "$$"}
	if err := Analyze(context.Background(), s, []snapshot.Routine{routine}); err != nil {
		t.Fatal(err)
	}
	if len(s.Diagnostics.Unresolved) != 0 || len(s.Diagnostics.Warnings) != 0 {
		t.Fatalf("diagnostics: %+v", s.Diagnostics)
	}
	for _, dep := range []struct{ ref, target string }{
		{"q.name", "customers.name"},
		{"q.grouping", "orders.id"},
		{`q."?column?"`, "orders.id"},
		{`b."?column?"`, "orders.total"},
		{"q.json_object", "customers.name"},
		{"q.json_object", "customers.id"},
		{"q.json_array", "customers.name"},
		{"a.json_arrayagg", "orders.total"},
		{"a.json_arrayagg", "orders.id"},
		{"a.json_arrayagg", "orders.customer_id"},
		{"q.xmlserialize", "customers.name"},
	} {
		ref, target := dep.ref, dep.target
		start := strings.Index(routine.Definition, ref)
		end := start + len(ref)
		relationship := "reads|" + routine.ID + "|" + target
		if !slices.ContainsFunc(s.Evidence, func(e snapshot.Evidence) bool {
			return e.RelationshipID == relationship && e.Start != nil && e.End != nil && *e.Start == start && *e.End == end
		}) {
			t.Errorf("evidence at %q does not refer to %s", ref, target)
		}
	}
}

func TestTriggerAssignmentsAndVariableConflict(t *testing.T) {
	s := scopeCatalog()
	var routines []snapshot.Routine
	for _, policy := range []string{"use_variable", "use_column", "error"} {
		body := "#variable_conflict " + policy + "\nDECLARE total numeric := 42; BEGIN PERFORM total FROM orders AS o WHERE o.id=1; RETURN NEW; END"
		routines = append(routines, snapshot.Routine{ID: policy, Name: policy, Schema: "public", Language: "plpgsql", Returns: "trigger", Body: body, Definition: "CREATE FUNCTION " + policy + "() RETURNS trigger LANGUAGE plpgsql AS $$" + body + "$$"})
	}
	body := `BEGIN
	  RAISE NOTICE 'example; NEW.total := 0';
	  /* example /* nested */ ; NEW.id := 0; */
	  NEW."Display Name" = upper(OLD."Display Name");
	  RETURN NEW;
	END`
	s.Objects = append(s.Objects, snapshot.Object{ID: "trig", Kind: "trigger", ParentID: "orders"})
	s.Relationships = append(s.Relationships, snapshot.Relationship{ID: "executes|trig|assign", Kind: "executes", Source: "trig", Target: "assign", Provenance: "catalog"})
	routines = append(routines, snapshot.Routine{ID: "assign", Name: "assign", Schema: "public", Language: "plpgsql", Returns: "trigger", Body: body, Definition: "CREATE FUNCTION assign() RETURNS trigger LANGUAGE plpgsql AS $$" + body + "$$"})
	if err := Analyze(context.Background(), s, routines); err != nil {
		t.Fatal(err)
	}
	for i, r := range routines {
		var got []string
		for _, e := range s.Relationships {
			if e.Source == r.ID {
				got = append(got, e.Kind+" "+e.Target)
			}
		}
		slices.Sort(got)
		want := []string{"reads orders.id"}
		if i == 1 {
			want = append(want, "reads orders.total")
		}
		if i == 3 {
			want = []string{"modifies orders.Display Name", "reads orders.Display Name"}
		}
		if i == 2 {
			want = []string{"reads orders", "reads orders.id"}
		}
		if !slices.Equal(got, want) {
			t.Fatalf("%s: got %v, want %v", r.ID, got, want)
		}
	}
	if len(s.Diagnostics.Unresolved) != 1 || s.Diagnostics.Unresolved[0].OwnerID != "error" {
		t.Fatal(s.Diagnostics.Unresolved)
	}
}

func TestFallbackAndQuotedNames(t *testing.T) {
	s := scopeCatalog()
	for _, o := range []snapshot.Object{
		{ID: "rd", Kind: "table", Schema: "sales.eu", Name: "orders"},
		{ID: "rw", Kind: "table", Schema: "sales", Name: "eu.orders"},
		{ID: "fd", Kind: "function", Schema: "sales.eu", Name: "audit()"},
		{ID: "fw", Kind: "function", Schema: "sales", Name: "eu.audit()"},
	} {
		s.Objects = append(s.Objects, o)
	}
	body := `SELECT "sales.eu".audit() FROM sales."eu.orders";`
	routines := []snapshot.Routine{
		{ID: "fd", Schema: "sales.eu", Name: "audit"}, {ID: "fw", Schema: "sales", Name: "eu.audit"},
		{ID: "sql", Name: "sql", Language: "sql", Schema: "public", Body: body, Definition: body},
		{ID: "bad", Name: "bad", Language: "plpgsql", Schema: "public", SearchPath: []string{"public"}, Definition: "invalid", Body: `BEGIN INSERT INTO audit(id) SELECT id FROM orders; PERFORM 'SELECT id FROM customers'; END`},
	}
	if err := Analyze(context.Background(), s, routines); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range s.Relationships {
		got = append(got, strings.Join([]string{e.Source, e.Kind, e.Target, e.Provenance}, " "))
	}
	slices.Sort(got)
	want := []string{"bad inserts audit fallback", "bad reads orders fallback", "sql calls fd parsed", "sql reads rw parsed"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	if !slices.Equal(s.Diagnostics.Warnings, []string{"1 routines required fallback analysis"}) {
		t.Fatal(s.Diagnostics.Warnings)
	}
}
