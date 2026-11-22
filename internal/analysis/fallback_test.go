package analysis

import (
	"context"
	"slices"
	"testing"

	"postgres-viz/internal/snapshot"
)

func TestFallbackMasksCommentsAndLiterals(t *testing.T) {
	for _, tc := range []struct{ name, sql string }{
		{"nested block comment", `/* outer /* inner */ select id from customers */ PERFORM id FROM orders`},
		{"escaped string", `PERFORM E'can\'t query from customers'; PERFORM id FROM orders`},
		{"dollar-quoted string", `PERFORM $message$select id from customers$message$; PERFORM id FROM orders`},
		{"dollar signs in identifier", `PERFORM id AS latest$revision$ FROM orders`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := scopeCatalog()
			// An incomplete definition forces fallback analysis of the body.
			r := snapshot.Routine{
				ID: "routine", Name: "routine", Schema: "public", Language: "plpgsql",
				Definition: "invalid", Body: "BEGIN " + tc.sql + "; END;",
			}
			if err := Analyze(context.Background(), s, []snapshot.Routine{r}); err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, e := range s.Relationships {
				got = append(got, e.Kind+" "+e.Target+" "+e.Provenance)
			}
			if want := []string{"reads orders fallback"}; !slices.Equal(got, want) {
				t.Errorf("relationships = %v, want %v", got, want)
			}
		})
	}
}
