package analysis

import (
	"context"
	"slices"
	"strings"
	"testing"

	"postgres-viz/internal/snapshot"
)

func TestRoutinePartialColumnAliases(t *testing.T) {
	const query = `WITH priced_orders (order_key) AS (
  SELECT o.id, o.total, o.customer_id FROM orders AS o
)
SELECT linked.joined_customer, linked.total, linked.name
FROM (
  (SELECT p.billed_customer, p.total
   FROM priced_orders AS p (public_key, total, billed_customer)) AS d (customer_id)
  JOIN (SELECT c.id, c.name FROM customers AS c) AS customer (customer_id) USING (customer_id)
) AS linked (joined_customer)
WHERE EXISTS (
  SELECT 1 FROM priced_orders AS original WHERE original.order_key > 0
)`
	for _, language := range []string{"sql", "plpgsql"} {
		t.Run(language, func(t *testing.T) {
			body := query
			if language == "plpgsql" {
				body = "BEGIN\n  RETURN QUERY " + body + ";\nEND"
			}
			routine := snapshot.Routine{
				ID: "f", Name: "priced_customers", Schema: "public", Language: language, Body: body,
				Definition: "CREATE FUNCTION priced_customers() RETURNS TABLE (customer bigint, amount numeric, label text) LANGUAGE " + language + " AS $$\n" + body + "\n$$",
			}
			s := scopeCatalog()
			if err := Analyze(context.Background(), s, []snapshot.Routine{routine}); err != nil {
				t.Fatal(err)
			}
			if len(s.Diagnostics.Unresolved) != 0 || len(s.Diagnostics.Warnings) != 0 {
				t.Errorf("diagnostics: %+v", s.Diagnostics)
			}
			var gotEdges []string
			for _, edge := range s.Relationships {
				gotEdges = append(gotEdges, edge.ID+" "+edge.Provenance)
			}
			slices.Sort(gotEdges)
			wantEdges := []string{
				"reads|f|customers.id parsed",
				"reads|f|customers.name parsed",
				"reads|f|orders.customer_id parsed",
				"reads|f|orders.id parsed",
				"reads|f|orders.total parsed",
			}
			if !slices.Equal(gotEdges, wantEdges) {
				t.Errorf("relationships: got %v, want %v", gotEdges, wantEdges)
			}
			for _, ref := range []struct {
				text  string
				edges []string
			}{
				{"linked.joined_customer", []string{"reads|f|customers.id", "reads|f|orders.customer_id"}},
				{"linked.total", []string{"reads|f|orders.total"}},
				{"linked.name", []string{"reads|f|customers.name"}},
				{"p.billed_customer", []string{"reads|f|orders.customer_id"}},
				{"original.order_key", []string{"reads|f|orders.id"}},
			} {
				start := strings.Index(routine.Definition, ref.text)
				end := start + len(ref.text)
				var got []string
				for _, evidence := range s.Evidence {
					if evidence.OwnerID == routine.ID && evidence.Provenance == "parsed" && evidence.Start != nil && evidence.End != nil && *evidence.Start == start && *evidence.End == end {
						got = append(got, evidence.RelationshipID)
					}
				}
				slices.Sort(got)
				if !slices.Equal(got, ref.edges) {
					t.Errorf("evidence for %q: got %v, want %v", ref.text, got, ref.edges)
				}
			}
		})
	}
}

func TestRoutineValuesPartialColumnAliases(t *testing.T) {
	const body = `WITH settings (customer_id) AS (VALUES (7, 2))
SELECT v.customer_key, v.column2
FROM orders AS o JOIN settings AS s USING (customer_id)
CROSS JOIN LATERAL (
  VALUES (o.customer_id, o.total), (o.id, 42)
) AS v (customer_key)
WHERE s.column2 > 0`
	routine := snapshot.Routine{ID: "f", Name: "configured_orders", Schema: "public", Language: "sql", Body: body}
	s := scopeCatalog()
	if err := Analyze(context.Background(), s, []snapshot.Routine{routine}); err != nil {
		t.Fatal(err)
	}
	if len(s.Diagnostics.Unresolved) != 0 || len(s.Diagnostics.Warnings) != 0 {
		t.Errorf("diagnostics: %+v", s.Diagnostics)
	}
	var got []string
	for _, edge := range s.Relationships {
		got = append(got, edge.ID+" "+edge.Provenance)
	}
	slices.Sort(got)
	want := []string{"reads|f|orders.customer_id parsed", "reads|f|orders.id parsed", "reads|f|orders.total parsed"}
	if !slices.Equal(got, want) {
		t.Errorf("relationships: got %v, want %v", got, want)
	}
	var gotEvidence []string
	for _, e := range s.Evidence {
		if e.Start == nil || e.End == nil {
			continue
		}
		ref := body[*e.Start:*e.End]
		if ref == "v.customer_key" || ref == "v.column2" {
			gotEvidence = append(gotEvidence, ref+" "+e.RelationshipID)
		}
	}
	slices.Sort(gotEvidence)
	wantEvidence := []string{"v.column2 reads|f|orders.total", "v.customer_key reads|f|orders.customer_id", "v.customer_key reads|f|orders.id"}
	if !slices.Equal(gotEvidence, wantEvidence) {
		t.Errorf("VALUES output evidence: got %v, want %v", gotEvidence, wantEvidence)
	}
}

func TestDynamicRoutineQueries(t *testing.T) {
	cases := []struct {
		name, body string
		want       []string
	}{
		{
			name: "return query execute",
			body: `BEGIN
  IF true THEN
    RETURN QUERY EXECUTE 'SELECT total FROM orders';
  END IF;
END`,
			want: []string{"reads orders.total"},
		},
		{
			name: "literal execute uses SQL namespace",
			body: `#variable_conflict use_variable
DECLARE total numeric := 42;
BEGIN
  EXECUTE 'SELECT total FROM orders WHERE id = $1'
    USING (SELECT max(id) FROM customers);
END`,
			want: []string{"reads customers.id", "reads orders.id", "reads orders.total"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := scopeCatalog()
			routine := snapshot.Routine{
				ID: "f1", Name: "dynamic_query", Schema: "public", Language: "plpgsql",
				Body: tc.body, Definition: "CREATE FUNCTION dynamic_query() RETURNS SETOF numeric LANGUAGE plpgsql AS $$" + tc.body + "$$",
			}
			if err := Analyze(context.Background(), s, []snapshot.Routine{routine}); err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, edge := range s.Relationships {
				got = append(got, edge.Kind+" "+edge.Target)
			}
			slices.Sort(got)
			if !slices.Equal(got, tc.want) {
				t.Errorf("relationships: got %v, want %v", got, tc.want)
			}
			if len(s.Diagnostics.Unresolved) != 0 || len(s.Diagnostics.Warnings) != 0 {
				t.Errorf("diagnostics: %+v", s.Diagnostics)
			}
		})
	}
}
