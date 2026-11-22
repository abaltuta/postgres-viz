package analysis

import (
	"maps"
	"strings"
	"testing"
	"unicode/utf16"

	"postgres-viz/internal/snapshot"
)

func TestCompositePositionalParameterEvidence(t *testing.T) {
	const args = "IN o public.orders, OUT result text, IN c public.customers"
	for _, tc := range []struct {
		language, body string
		customer       string
	}{
		{
			language: "sql",
			body:     `SELECT '🧾' || $1."Display Name" || ($2).name`,
			customer: "($2).name",
		},
		{
			language: "plpgsql",
			body: `BEGIN
  result := '🧾' || $1."Display Name" || (( $3 )).name;
END`,
			customer: "(( $3 )).name",
		},
	} {
		t.Run(tc.language, func(t *testing.T) {
			r := snapshot.Routine{
				ID: "f", Name: "describe_rows", Schema: "public", Language: tc.language, Args: args, Body: tc.body,
				Definition: "CREATE FUNCTION describe_rows(" + args + ") LANGUAGE " + tc.language + " AS $$\n" + tc.body + "\n$$",
			}
			s := scopeCatalog()
			if err := Analyze(t.Context(), s, []snapshot.Routine{r}); err != nil {
				t.Fatal(err)
			}
			if len(s.Diagnostics.Unresolved) != 0 || len(s.Diagnostics.Warnings) != 0 {
				t.Errorf("diagnostics: %+v", s.Diagnostics)
			}
			want := map[string]string{
				"reads|f|orders.Display Name": `$1."Display Name"`,
				"reads|f|customers.name":      tc.customer,
			}
			if len(s.Relationships) != len(want) || len(s.Evidence) != len(want) {
				t.Errorf("relationships: %+v; evidence: %+v", s.Relationships, s.Evidence)
			}
			for _, edge := range s.Relationships {
				if _, ok := want[edge.ID]; !ok || edge.Provenance != "parsed" {
					t.Errorf("unexpected relationship: %+v", edge)
				}
			}
			definition := utf16.Encode([]rune(r.Definition))
			got := map[string]string{}
			for _, e := range s.Evidence {
				if e.OwnerID != r.ID || e.Provenance != "parsed" || e.Start == nil || e.End == nil ||
					*e.Start < 0 || *e.End < *e.Start || *e.End > len(definition) {
					t.Errorf("invalid evidence: %+v", e)
					continue
				}
				ref := string(utf16.Decode(definition[*e.Start:*e.End]))
				if !strings.Contains(e.Snippet, ref) {
					t.Errorf("snippet %q does not contain %q", e.Snippet, ref)
				}
				got[e.RelationshipID] = ref
			}
			if !maps.Equal(got, want) {
				t.Errorf("evidence: got %v, want %v", got, want)
			}
		})
	}
}
