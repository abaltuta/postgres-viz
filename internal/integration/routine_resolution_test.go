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
CREATE TABLE review.audit(sum bigint, "coalesce" int, ordinality bigint, "greatest" int);
INSERT INTO review.audit VALUES (99, 99, 99, 99);
CREATE TABLE review.pagination(page_size int, skip_rows int);
INSERT INTO review.pagination VALUES (1, 1);
CREATE FUNCTION review.paged_union() RETURNS SETOF int LANGUAGE sql AS $$
  SELECT 10 UNION ALL SELECT 20 ORDER BY 1
  LIMIT (SELECT page_size FROM review.pagination)
  OFFSET (SELECT skip_rows FROM review.pagination)
$$;
CREATE FUNCTION review.implicit_output() RETURNS bigint LANGUAGE sql
  AS $$ SELECT (SELECT sum FROM (SELECT sum(o.total) FROM review.orders AS o) q) FROM review.audit $$;
CREATE FUNCTION review.coalesce_output() RETURNS int LANGUAGE sql
  AS $$ SELECT (SELECT "coalesce" FROM (SELECT COALESCE(1, 2)) q) FROM review.audit $$;
CREATE FUNCTION review.greatest_output() RETURNS int LANGUAGE sql
  AS $$ SELECT (SELECT "greatest" FROM (SELECT GREATEST(o.total, 2) FROM review.orders o) q) FROM review.audit $$;
CREATE FUNCTION review.nullif_output() RETURNS int LANGUAGE sql AS $$
  SELECT (SELECT "nullif" FROM (SELECT NULLIF(o.total, 0) FROM review.orders o) q)
  FROM review.audit AS a("nullif")
$$;
CREATE FUNCTION review.cast_output() RETURNS bigint LANGUAGE sql
  AS $$ SELECT (SELECT total FROM (SELECT o.total::bigint FROM review.orders o) q) FROM "Actual, Data".orders $$;
CREATE FUNCTION review.inner_ordinal() RETURNS bigint LANGUAGE sql
  AS $$ SELECT (SELECT ordinality FROM generate_series(7,7) WITH ORDINALITY AS g) FROM review.audit $$;
CREATE FUNCTION review.outer_ordinal() RETURNS bigint LANGUAGE sql
  AS $$ SELECT (SELECT ordinality FROM generate_series(7,7) AS g) FROM review.audit $$;
CREATE TABLE review.buffer(payload int[]);
CREATE TABLE review.samples(vals int[], pos int);
INSERT INTO review.samples VALUES (ARRAY[3, 7], 2);
CREATE FUNCTION review.sample_value() RETURNS int LANGUAGE sql
  AS $$ SELECT q.vals FROM (SELECT vals[pos] FROM review.samples) q $$;
CREATE TABLE review.documents(n integer, doc xml);
INSERT INTO review.documents VALUES (7, XML '<r>8</r>');
CREATE FUNCTION review.scalar_result() RETURNS int LANGUAGE sql
  AS $$ SELECT q.n FROM (SELECT (SELECT n FROM review.documents)) q $$;
CREATE FUNCTION review.xml_result() RETURNS int LANGUAGE sql AS $$
  SELECT x.n FROM review.documents d,
    XMLTABLE('/r' PASSING d.doc COLUMNS n int PATH '.') x
$$;
CREATE FUNCTION review.case_result() RETURNS int LANGUAGE sql AS $$
  SELECT q."case" FROM (SELECT CASE WHEN n > 0 THEN n END FROM review.documents) q
$$;
CREATE FUNCTION review.series_result() RETURNS int LANGUAGE sql AS $$
  SELECT g.g FROM review.samples s, generate_series(s.pos, s.pos) g
$$;
CREATE FUNCTION review.cycle_result() RETURNS int LANGUAGE sql AS $$
  WITH RECURSIVE r(n) AS (SELECT n FROM review.documents UNION ALL SELECT n FROM r)
  CYCLE n SET seen USING path
  SELECT cardinality(r.path) FROM r WHERE r.seen
$$;
CREATE FUNCTION review.exists_result() RETURNS int LANGUAGE sql AS $$
  SELECT q."exists"::int FROM (SELECT EXISTS(SELECT 1 FROM review.samples WHERE pos > 0)) q
$$;
CREATE FUNCTION review.date_result() RETURNS int LANGUAGE sql AS $$
  SELECT (q.current_date = CURRENT_DATE)::int FROM (SELECT CURRENT_DATE) q
$$;
CREATE FUNCTION review.array_result() RETURNS int LANGUAGE sql AS $$
  SELECT q.array[1] FROM (SELECT ARRAY(SELECT n FROM review.documents)) q
$$;
CREATE FUNCTION review.collated_result() RETURNS int LANGUAGE sql AS $$
  SELECT q.n::int FROM (SELECT n::text COLLATE "C" FROM review.documents) q
$$;
CREATE FUNCTION review.grouping_result() RETURNS bigint LANGUAGE sql AS $$
  SELECT sum(q.grouping) FROM (SELECT GROUPING(pos) FROM review.samples GROUP BY ROLLUP(pos)) q
$$;
CREATE FUNCTION review.put() RETURNS int LANGUAGE sql AS $$
  INSERT INTO review.buffer (payload[(SELECT total FROM review.orders)]) VALUES (7)
  RETURNING payload[10]
$$;
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
	for name, want := range map[string]int{
		"by_path": 20, "sampled": 10, "forward_cte": 20, "implicit_output": 10,
		"paged_union": 20, "coalesce_output": 1, "put": 7, "cast_output": 10,
		"inner_ordinal": 1, "outer_ordinal": 99, "greatest_output": 10, "nullif_output": 10,
		"sample_value": 7, "scalar_result": 7, "xml_result": 8,
		"case_result": 7, "series_result": 2,
		"cycle_result": 2, "exists_result": 1,
		"date_result": 1, "array_result": 7,
		"collated_result": 7, "grouping_result": 1,
	} {
		var got int
		if err := db.QueryRow(ctx, "SELECT review."+name+"()").Scan(&got); err != nil || got != want {
			t.Fatalf("%s: got %d, want %d (%v)", name, got, want, err)
		}
	}
	s := read(scan("--schema", "review", "--schema", "Actual, Data"))
	for column, want := range map[string][]string{
		"review.orders.total":         {"review.cast_output()", "review.greatest_output()", "review.implicit_output()", "review.nullif_output()", "review.put()", "review.sampled()"},
		"review.audit.sum":            {},
		"review.audit.coalesce":       {},
		"review.audit.greatest":       {},
		"review.audit.ordinality":     {"review.outer_ordinal()"},
		"review.pagination.page_size": {"review.paged_union()"},
		"review.pagination.skip_rows": {"review.paged_union()"},
		"review.samples.vals":         {"review.sample_value()"},
		"review.samples.pos":          {"review.exists_result()", "review.grouping_result()", "review.sample_value()", "review.series_result()"},
		"review.documents.n":          {"review.array_result()", "review.case_result()", "review.collated_result()", "review.cycle_result()", "review.scalar_result()"},
		"review.documents.doc":        {"review.xml_result()"},
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
