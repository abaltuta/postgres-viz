package analysis

import (
	"context"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"

	"postgres-viz/internal/snapshot"
)

func TestAssignmentSubscriptReads(t *testing.T) {
	s := scopeCatalog()
	body := `DECLARE values_to_set int[] := ARRAY[1,1];
  matrix_to_set int[][] := ARRAY[[1,1],[1,1]];
  local_row record;
BEGIN
  SELECT 0 AS total INTO local_row;
  local_row.total := 1;
  values_to_set[(SELECT o.id FROM orders o)] := 42;
  matrix_to_set[(ARRAY[1,2])[2]][CASE WHEN '𐐀]=' = '𐐀]=' THEN c.id ELSE 1 END] = DISTINCT c.id FROM customers c;
  RETURN values_to_set[2];
END`
	def := "CREATE FUNCTION assignment_lookup() RETURNS int LANGUAGE plpgsql AS $$" + body + "$$"
	r := snapshot.Routine{ID: "f1", Name: "assignment_lookup", Schema: "public", Language: "plpgsql", Body: body, Definition: def}
	if err := Analyze(context.Background(), s, []snapshot.Routine{r}); err != nil {
		t.Fatal(err)
	}
	var edges, spans []string
	for _, edge := range s.Relationships {
		edges = append(edges, edge.Provenance+" "+edge.Kind+" "+edge.Target)
	}
	slices.Sort(edges)
	if want := []string{"parsed reads customers.id", "parsed reads orders.id"}; !slices.Equal(edges, want) {
		t.Errorf("relationships = %v, want %v", edges, want)
	}
	sql16 := utf16.Encode([]rune(def))
	seen := map[int]bool{}
	for _, e := range s.Evidence {
		if e.Start != nil && e.End != nil {
			if seen[*e.Start] {
				t.Errorf("repeated evidence offset %d", *e.Start)
			}
			seen[*e.Start] = true
			spans = append(spans, string(utf16.Decode(sql16[*e.Start:*e.End])))
		}
	}
	slices.Sort(spans)
	if want := []string{"c.id", "c.id", "o.id"}; !slices.Equal(spans, want) {
		t.Errorf("evidence spans = %v, want %v", spans, want)
	}
	if len(s.Diagnostics.Warnings) != 0 || len(s.Diagnostics.Unresolved) != 0 {
		t.Errorf("diagnostics: %+v", s.Diagnostics)
	}
}

func TestRowtypeFieldAssignment(t *testing.T) {
	s := scopeCatalog()
	body := `DECLARE
  -- decoy audit%ROWTYPE;
  message text := 'DECLARE rec audit%ROWTYPE; BEGIN';
  rec "public" /* marker */ .orders%ROWTYPE;
BEGIN
  rec.total := (SELECT c.id FROM customers c);
  RETURN rec.total + 0;
END`
	def := "CREATE FUNCTION field_write() RETURNS numeric LANGUAGE plpgsql AS $$" + body + "$$"
	r := snapshot.Routine{ID: "f1", Name: "field_write", Schema: "public", Language: "plpgsql", Body: body, Definition: def}
	if err := Analyze(context.Background(), s, []snapshot.Routine{r}); err != nil {
		t.Fatal(err)
	}
	var edges, spans []string
	for _, edge := range s.Relationships {
		edges = append(edges, edge.Provenance+" "+edge.Kind+" "+edge.Target)
	}
	slices.Sort(edges)
	if want := []string{"parsed reads customers.id", "parsed reads orders.total"}; !slices.Equal(edges, want) {
		t.Errorf("relationships = %v, want %v", edges, want)
	}
	sql16 := utf16.Encode([]rune(def))
	for _, e := range s.Evidence {
		if e.Start != nil && e.End != nil {
			spans = append(spans, string(utf16.Decode(sql16[*e.Start:*e.End])))
		}
	}
	slices.Sort(spans)
	if want := []string{"c.id", "rec.total"}; !slices.Equal(spans, want) {
		t.Errorf("evidence spans = %v, want %v", spans, want)
	}
	if len(s.Diagnostics.Warnings) != 0 || len(s.Diagnostics.Unresolved) != 0 {
		t.Errorf("diagnostics: %+v", s.Diagnostics)
	}
}

func TestUnknownRowtypeFieldAssignmentKeepsFallback(t *testing.T) {
	for _, tc := range []struct{ typ, field string }{
		{"absent_table", "id"}, {"orders", "absent_field"},
	} {
		t.Run(tc.typ+"."+tc.field, func(t *testing.T) {
			body := "DECLARE r " + tc.typ + "%ROWTYPE; BEGIN r." + tc.field + " := (SELECT c.id FROM customers c); RETURN 1; END"
			r := snapshot.Routine{ID: "f1", Name: "field_write", Schema: "public", Language: "plpgsql", Body: body,
				Definition: "CREATE FUNCTION field_write() RETURNS int LANGUAGE plpgsql AS $$" + body + "$$"}
			s := scopeCatalog()
			if err := Analyze(context.Background(), s, []snapshot.Routine{r}); err != nil {
				t.Fatal(err)
			}
			if len(s.Relationships) != 1 || s.Relationships[0].Provenance != "fallback" || s.Relationships[0].Target != "customers" {
				t.Errorf("relationships = %+v", s.Relationships)
			}
			if len(s.Diagnostics.Warnings) != 1 || !strings.Contains(s.Diagnostics.Warnings[0], "fallback analysis") {
				t.Errorf("diagnostics: %+v", s.Diagnostics)
			}
		})
	}
}
