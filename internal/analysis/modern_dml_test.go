package analysis

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"

	"postgres-viz/internal/snapshot"
)

func TestModernDML(t *testing.T) {
	cases := []struct {
		version       int
		sql, language string
		reads         map[string]string
	}{
		{18, "UPDATE orders SET total=0 RETURNING old.id, new.total", "sql", map[string]string{"old.id": "orders.id", "new.total": "orders.total"}},
		{18, `DELETE FROM orders USING customers AS old RETURNING WITH (NEW AS "After") old.name, "After".id`, "sql", map[string]string{"old.name": "customers.name", `"After".id`: "orders.id"}},
		{18, "WITH q AS (INSERT INTO orders DEFAULT VALUES RETURNING WITH (OLD AS prev) prev.total) SELECT q.total FROM q", "sql", map[string]string{"prev.total": "orders.total", "q.total": "orders.total"}},
		{18, "MERGE INTO orders USING customers c ON false WHEN MATCHED THEN DELETE RETURNING WITH (NEW AS next) next.id, c.name", "sql", map[string]string{"next.id": "orders.id", "c.name": "customers.name"}},
		{19, "INSERT INTO orders(id) VALUES(1) ON CONFLICT(id) DO /* lock */ SELECT FOR NO KEY UPDATE WHERE excluded.customer_id > orders.total RETURNING WITH (OLD AS prev) prev.id", "sql", map[string]string{"excluded.customer_id": "orders.customer_id", "orders.total": "orders.total", "prev.id": "orders.id"}},
		{19, "BEGIN RETURN QUERY INSERT INTO orders(id) VALUES(1) ON CONFLICT(id) DO SELECT WHERE orders.total=1 RETURNING WITH (NEW AS later) later.id; END", "plpgsql", map[string]string{"orders.total": "orders.total", "later.id": "orders.id"}},
		{17, "UPDATE orders SET total=0 FROM customers new RETURNING new.name", "sql", map[string]string{"new.name": "customers.name"}},
		{19, `INSERT INTO orders SELECT 1, 2, 3, 'DO SELECT' ON CONFLICT (customer_id /*,*/ , "id") DO SELECT FOR KEY SHARE RETURNING 1`, "sql", map[string]string{"customer_id": "orders.customer_id", `"id"`: "orders.id"}},
		{18, "UPDATE orders SET total=0 /* 漢 */ RETURNING WITH (NEW AS n) (SELECT n.name FROM customers n), n.id", "sql", map[string]string{"n.name": "customers.name", "n.id": "orders.id"}},
	}
	s := scopeCatalog()
	var routines []snapshot.Routine
	for i, tc := range cases {
		id := fmt.Sprint("f", i)
		r := snapshot.Routine{ID: id, Name: id, Language: tc.language, Schema: "public", Body: tc.sql, Definition: tc.sql, ServerVersion: tc.version * 10000}
		if tc.language == "plpgsql" {
			r.Definition = "CREATE FUNCTION " + id + "() RETURNS SETOF int LANGUAGE plpgsql AS $$" + tc.sql + "$$"
		}
		routines = append(routines, r)
	}
	if err := Analyze(context.Background(), s, routines); err != nil {
		t.Fatal(err)
	}
	if len(s.Diagnostics.Unresolved) != 0 || len(s.Diagnostics.Warnings) != 0 {
		t.Errorf("diagnostics %+v", s.Diagnostics)
	}
	for i, tc := range cases {
		r := routines[i]
		for token, target := range tc.reads {
			offset := strings.Index(r.Definition, token)
			start := units(r.Definition[:offset])
			end := start + units(token)
			found := slices.ContainsFunc(s.Evidence, func(e snapshot.Evidence) bool {
				return e.RelationshipID == "reads|"+r.ID+"|"+target && e.Provenance == "parsed" && e.Start != nil && e.End != nil && *e.Start == start && *e.End == end
			})
			if !found {
				t.Errorf("%s: missing source range for %s -> %s", r.ID, token, target)
			}
		}
		for _, e := range s.Relationships {
			if e.Source == r.ID && (e.Provenance != "parsed" || tc.version == 19 && e.Kind == "updates") {
				t.Errorf("%s: unexpected edge %+v", r.ID, e)
			}
		}
	}
}

func TestDMLGrammarRejections(t *testing.T) {
	p := &parser{ctx: t.Context()}
	defer p.close()
	for _, tc := range []struct {
		version int
		sql     string
	}{
		{170000, "DELETE FROM orders RETURNING WITH (OLD AS o) o.id"},
		{180000, "INSERT INTO orders DEFAULT VALUES ON CONFLICT(id) DO SELECT RETURNING id"},
		{190000, "INSERT INTO orders DEFAULT VALUES ON CONFLICT DO SELECT RETURNING id"},
		{190000, "INSERT INTO orders DEFAULT VALUES ON CONFLICT(id) DO SELECT"},
		{190000, "INSERT INTO orders DEFAULT VALUES ON CONFLICT(id) DO SELECT + orders.total RETURNING id"},
		{190000, "INSERT INTO orders DEFAULT VALUES ON CONFLICT(id) DO SELECT FOR KEY UPDATE RETURNING id"},
		{180000, "DELETE FROM orders RETURNING WITH (OLD AS o, OLD AS b) b.id"},
	} {
		p.version = tc.version
		if _, err := p.parse(tc.sql, false); err == nil {
			t.Errorf("%d accepted %s", tc.version, tc.sql)
		}
	}
}

func TestReturningTriggerRecordConflict(t *testing.T) {
	s := scopeCatalog()
	for i, tc := range []struct {
		version                 int
		policy                  string
		field, want, diagnostic string
	}{
		{17, "error", "id", "customers.id", ""},
		{18, "use_variable", "id", "customers.id", ""},
		{18, "use_column", "id", "orders.id", ""},
		{18, "error", "id", "", "ambiguous"},
		{18, "error", "name", "customers.name", ""},
		{18, "error", "total", "", "missing"},
		{18, "use_column", "name", "customers.name", ""},
	} {
		id := fmt.Sprintf("f%d", i)
		trigger := "trigger_" + id
		s.Objects = append(s.Objects, snapshot.Object{ID: trigger, Kind: "trigger", ParentID: "customers"})
		s.Relationships = append(s.Relationships, snapshot.Relationship{ID: "executes|" + trigger + "|" + id, Source: trigger, Target: id, Kind: "executes", Provenance: "catalog"})
		body := "#variable_conflict " + tc.policy + "\nDECLARE n text; BEGIN UPDATE orders SET total=0 RETURNING new." + tc.field + " INTO n; RETURN NEW; END"
		r := snapshot.Routine{ID: id, Name: id, Language: "plpgsql", Schema: "public", Returns: "trigger", Body: body, Definition: "CREATE FUNCTION " + id + "() RETURNS trigger LANGUAGE plpgsql AS $$" + body + "$$", ServerVersion: tc.version * 10000}
		if err := Analyze(t.Context(), s, []snapshot.Routine{r}); err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, e := range s.Relationships {
			if e.Source == id && e.Kind == "reads" && e.Provenance == "parsed" {
				got = append(got, e.Target)
			}
		}
		if strings.Join(got, ",") != tc.want {
			t.Errorf("%s reads %v, want %q", id, got, tc.want)
		}
		var reason string
		for _, d := range s.Diagnostics.Unresolved {
			if d.OwnerID == id && d.Identifier == "new."+tc.field {
				reason = d.Reason
			}
		}
		if reason != tc.diagnostic {
			t.Errorf("%s diagnostic %q, want %q", id, reason, tc.diagnostic)
		}
	}
}
