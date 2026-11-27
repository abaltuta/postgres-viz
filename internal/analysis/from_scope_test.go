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
		{"case label without else", `SELECT q."case" FROM (SELECT CASE WHEN true THEN 7 END) q`, ""},
		{"case ignores weak else label", `SELECT q."case" FROM (SELECT CASE WHEN true THEN o.id ELSE 7::bigint END FROM orders o) q`, "orders.id"},
		{"case uses strong else label", `SELECT q.total FROM (SELECT CASE WHEN true THEN o.id ELSE o.total END FROM orders o) q`, "orders.id orders.total"},
		{"cast overrides weak case label", `SELECT q.int8 FROM (SELECT (CASE WHEN true THEN 7 END)::bigint) q`, ""},
		{"cast preserves strong case label", `SELECT q.total FROM (SELECT (CASE WHEN true THEN o.id ELSE o.total END)::bigint FROM orders o) q`, "orders.id orders.total"},
		{"explicit alias overrides case label", `SELECT q.amount FROM (SELECT CASE WHEN true THEN 7 END AS amount) q`, ""},
		{"case with separately named else expression", `SELECT (SELECT "case" FROM (SELECT CASE WHEN true THEN CURRENT_DATE ELSE CURRENT_DATE END) q) FROM audit a("case")`, "audit.id"},
		{"implicit greatest label", `SELECT (SELECT "greatest" FROM (SELECT GREATEST(1, 2)) q) FROM audit`, ""},
		{"implicit least label with operands", `SELECT (SELECT "least" FROM (SELECT LEAST(o.id, o.total) FROM orders o) q) FROM audit`, "orders.id orders.total"},
		{"cast preserves greatest label", `SELECT (SELECT "greatest" + int8 FROM (SELECT GREATEST(1, 2)::bigint) q) FROM audit`, "audit.int8"},
		{"explicit alias overrides least label", `SELECT (SELECT "least" + amount FROM (SELECT LEAST(o.total, 2) AS amount FROM orders o) q) FROM audit`, "audit.least orders.total"},
		{"implicit nullif label", `SELECT (SELECT "nullif" FROM (SELECT NULLIF(1, 2)) q) FROM audit`, ""},
		{"cast preserves nullif label and operand reads", `SELECT (SELECT "nullif" + int8 FROM (SELECT NULLIF(o.id, o.total)::bigint FROM orders o) q) FROM audit`, "audit.int8 orders.id orders.total"},
		{"explicit alias overrides nullif label", `SELECT (SELECT "nullif" + amount FROM (SELECT NULLIF(o.total, 2) AS amount FROM orders o) q) FROM audit`, "audit.nullif orders.total"},
		{"explicit alias overrides cast label", "SELECT (SELECT id + amount FROM (SELECT o.id::bigint AS amount FROM orders o) q) FROM audit", "audit.id orders.id"},
		{"implicit subscript label", "SELECT q.amounts FROM (SELECT o.amounts[o.id] FROM orders o) q", "orders.amounts orders.id"},
		{"cast preserves subscript label", "SELECT q.amounts FROM (SELECT o.amounts[o.id]::bigint FROM orders o) q", "orders.amounts orders.id"},
		{"explicit alias overrides subscript label", "SELECT (SELECT amounts + q.amount FROM (SELECT o.amounts[o.id] AS amount FROM orders o) q) FROM audit", "audit.amounts orders.amounts orders.id"},
		{"subscript ignores index as label", "SELECT (SELECT id + q.array FROM (SELECT (ARRAY[o.total])[o.id] FROM orders o) q) FROM audit", "audit.id orders.id orders.total"},
		{"scalar subquery label", "SELECT q.n FROM (SELECT (SELECT 7 AS n)) q", ""},
		{"scalar subquery label from star", "SELECT q.n FROM (SELECT (SELECT s.* FROM (SELECT o.total AS n FROM orders o) s)) q", "orders.total"},
		{"scalar subquery label from set operation", "SELECT q.n FROM (SELECT (SELECT o.total AS n FROM orders o UNION ALL SELECT c.id FROM customers c LIMIT 1)) q", "customers.id orders.total"},
		{"default scalar subquery label", `SELECT q."?column?" FROM (SELECT (SELECT 7)) q`, ""},
		{"explicit alias overrides scalar subquery label", "SELECT q.amount FROM (SELECT (SELECT total FROM orders) AS amount) q", "orders.total"},
		{"current date label", "SELECT q.current_date FROM (SELECT CURRENT_DATE) q", ""},
		{"other SQL value function labels", `SELECT q.current_time, q.current_timestamp, q.localtime, q.localtimestamp,
			q.current_role, q.current_user, q.user, q.session_user, q.current_catalog, q.current_schema
			FROM (SELECT CURRENT_TIME, CURRENT_TIMESTAMP, LOCALTIME, LOCALTIMESTAMP,
				CURRENT_ROLE, CURRENT_USER, USER, SESSION_USER, CURRENT_CATALOG, CURRENT_SCHEMA) q`, ""},
		{"SQL value function labels with precision", `SELECT q.current_time, q.current_timestamp, q.localtime, q.localtimestamp
			FROM (SELECT CURRENT_TIME(0), CURRENT_TIMESTAMP(1), LOCALTIME(2), LOCALTIMESTAMP(3)) q`, ""},
		{"cast preserves SQL value function label", "SELECT q.current_date FROM (SELECT CURRENT_DATE::text) q", ""},
		{"array subquery label", "SELECT q.array FROM (SELECT ARRAY(SELECT 7)) q", ""},
		{"cast preserves array subquery label and reads", "SELECT q.array FROM (SELECT ARRAY(SELECT o.total FROM orders o)::bigint[]) q", "orders.total"},
		{"exists subquery label and reads", "SELECT q.exists FROM (SELECT EXISTS(SELECT 1 FROM orders WHERE id = 7)) q", "orders.id"},
		{"xmltable qualified column", `SELECT x.n FROM XMLTABLE('/r' PASSING XML '<r>8</r>' COLUMNS n int PATH '.') x`, ""},
		{"xmltable implicit range name and alias prefix", `SELECT xmltable.n, x.renamed, x.seq FROM XMLTABLE('/r' PASSING XML '<r>8</r>' COLUMNS n int PATH '.') CROSS JOIN XMLTABLE('/r' PASSING XML '<r>8</r>' COLUMNS n int PATH '.', seq FOR ORDINALITY) AS x(renamed)`, ""},
		{"xmltable lateral expressions and column shadowing", `SELECT (SELECT note FROM orders o CROSS JOIN XMLTABLE((o.total::text) PASSING (o.customer_id::text::xml) COLUMNS note int PATH (o.amounts::text) DEFAULT o.id) x) FROM audit`, "orders.amounts orders.customer_id orders.id orders.total"},
		{"ordinality shadows outer column", "SELECT (SELECT ordinality FROM generate_series(7, 7) WITH ORDINALITY AS g) FROM audit", ""},
		{"qualified ordinality", "SELECT g.ordinality FROM generate_series(7, 7) WITH ORDINALITY AS g", ""},
		{"implicit range name for ordinality", "SELECT generate_series.ordinality FROM generate_series(7, 7) WITH ORDINALITY", ""},
		{"outer column without ordinality", "SELECT (SELECT ordinality FROM generate_series(7, 7) AS g) FROM audit", "audit.ordinality"},
		{"scalar range alias label", "SELECT g.g FROM generate_series(8, 8) g", ""},
		{"scalar range implicit label", "SELECT generate_series.generate_series FROM pg_catalog.generate_series(8, 8)", ""},
		{"scalar range explicit column alias", "SELECT g.value FROM generate_series(8, 8) AS g(value)", ""},
		{"scalar range label shadows outer column", "SELECT (SELECT id FROM generate_series(8, 8) id) FROM audit", ""},
		{"alias before ordinality", "SELECT (SELECT ordinality FROM generate_series(7, 7) WITH ORDINALITY AS g(value)) FROM audit", ""},
		{"alias renames ordinality", "SELECT (SELECT ordinality + g.n FROM generate_series(7, 7) WITH ORDINALITY AS g(value, n)) FROM audit", "audit.ordinality"},
		{"rows from ordinality after defined output", "SELECT (SELECT ordinality FROM ROWS FROM (json_to_record('{}') AS (x integer)) WITH ORDINALITY AS g(value)) FROM audit", ""},
		{"rows from ordinal renamed after defined outputs", "SELECT (SELECT ordinality + g.n FROM ROWS FROM (json_to_record('{}') AS (x integer, y integer)) WITH ORDINALITY AS g(x, y, n)) FROM audit", "audit.ordinality"},
		{"rows from ordinality follows all members", "SELECT (SELECT ordinality FROM ROWS FROM (json_to_record('{}') AS (x integer), pg_catalog.generate_series(7, 7)) WITH ORDINALITY AS g(x, n)) FROM audit", ""},
		{"rows from known suffix after unknown outputs", "SELECT (SELECT id + ordinality FROM ROWS FROM (jsonb_each('{}'), json_to_record('{\"id\":1}') AS (x integer, id integer)) WITH ORDINALITY AS g(k)) FROM audit", ""},
		{"ordinality after unknown outputs", "SELECT (SELECT ordinality FROM jsonb_each('{}') WITH ORDINALITY AS g) FROM audit", ""},
	}
	for _, language := range []string{"sql", "plpgsql"} {
		s := scopeCatalog()
		s.Columns = append(s.Columns,
			snapshot.Column{ID: "audit.sum", ObjectID: "audit", Name: "sum", Position: 3},
			snapshot.Column{ID: "audit.int8", ObjectID: "audit", Name: "int8", Position: 4},
			snapshot.Column{ID: "audit.numeric", ObjectID: "audit", Name: "numeric", Position: 5},
			snapshot.Column{ID: "audit.ordinality", ObjectID: "audit", Name: "ordinality", Position: 6},
			snapshot.Column{ID: "audit.greatest", ObjectID: "audit", Name: "greatest", Position: 7},
			snapshot.Column{ID: "audit.least", ObjectID: "audit", Name: "least", Position: 8},
			snapshot.Column{ID: "audit.nullif", ObjectID: "audit", Name: "nullif", Position: 9},
			snapshot.Column{ID: "audit.amounts", ObjectID: "audit", Name: "amounts", Position: 10},
			snapshot.Column{ID: "orders.amounts", ObjectID: "orders", Name: "amounts", Position: 5},
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
