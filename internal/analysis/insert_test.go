package analysis

import (
	"context"
	"slices"
	"testing"

	"postgres-viz/internal/snapshot"
)

func TestInsertColumnWrites(t *testing.T) {
	cases := []struct {
		name, sql string
		want      []string
		explicit  bool
	}{
		{"short values", "INSERT INTO destination VALUES (1), (2)", []string{"destination.first"}, false},
		{"values spanning dropped column", "INSERT INTO destination VALUES (1, DEFAULT)", []string{"destination.first", "destination.second"}, false},
		{"short select", "INSERT INTO destination SELECT id FROM customers", []string{"destination.first"}, false},
		{"expanded CTE star", "WITH source AS (SELECT id, name FROM customers) INSERT INTO destination SELECT source.* FROM source", []string{"destination.first", "destination.second"}, false},
		{"defined function star", `INSERT INTO destination SELECT src.* FROM json_to_record('{"first":1,"second":"two"}') AS src(first int, second text)`, []string{"destination.first", "destination.second"}, false},
		{"set operation", "INSERT INTO destination SELECT id, name FROM customers UNION ALL SELECT 1, 'second'", []string{"destination.first", "destination.second"}, false},
		{"explicit columns", "INSERT INTO destination (third) VALUES (1)", []string{"destination.third"}, true},
		{"default values", "INSERT INTO destination DEFAULT VALUES", []string{"destination"}, false},
		{"zero select outputs", "INSERT INTO destination SELECT FROM customers", []string{"destination"}, false},
		{"unavailable star width", "INSERT INTO destination SELECT 1, src.* FROM outside.source AS src", []string{"destination"}, false},
		{"mixed known and unknown writes", "INSERT INTO destination VALUES (1); INSERT INTO destination SELECT 1, src.* FROM outside.source AS src", []string{"destination", "destination.first"}, false},
		{"nested unavailable star width", "INSERT INTO destination SELECT q.* FROM (SELECT 1, src.* FROM outside.source AS src) AS q", []string{"destination"}, false},
		{"partially aliased function star", "INSERT INTO destination SELECT 1, src.* FROM outside.pair() AS src(renamed)", []string{"destination"}, false},
		{"unknown composite select star", "INSERT INTO destination SELECT 1, (ROW('two', 2)::outside.pair).*", []string{"destination"}, false},
		{"unknown composite values star", "INSERT INTO destination VALUES (1, (ROW('two', 2)::outside.pair).*)", []string{"destination"}, false},
		{"aggregate star", "INSERT INTO destination SELECT count(*) FROM customers", []string{"destination.first"}, false},
		{"merge star", "MERGE INTO destination USING customers AS src ON false WHEN NOT MATCHED THEN INSERT VALUES (src.*)", []string{"destination.first", "destination.second"}, false},
		{"PL/pgSQL", "BEGIN INSERT INTO destination VALUES (1); END;", []string{"destination.first"}, false},
	}
	s := scopeCatalog()
	s.Objects = append(s.Objects, snapshot.Object{ID: "destination", Name: "destination", Schema: "public", Kind: "table"})
	s.Columns = append(s.Columns,
		snapshot.Column{ID: "destination.third", ObjectID: "destination", Name: "third", Position: 4},
		snapshot.Column{ID: "destination.second", ObjectID: "destination", Name: "second", Position: 3},
		snapshot.Column{ID: "destination.first", ObjectID: "destination", Name: "first", Position: 1},
	)
	var routines []snapshot.Routine
	for _, tc := range cases {
		routine := snapshot.Routine{ID: tc.name, Name: "record_write", Schema: "public", Language: "sql", Body: tc.sql, Definition: tc.sql}
		if tc.name == "PL/pgSQL" {
			routine.Language = "plpgsql"
			routine.Definition = "CREATE FUNCTION record_write() RETURNS void LANGUAGE plpgsql AS $$" + tc.sql + "$$"
		}
		routines = append(routines, routine)
	}
	if err := Analyze(context.Background(), s, routines); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var writes []string
			spans := 0
			for _, edge := range s.Relationships {
				if edge.Kind != "inserts" || edge.Source != tc.name {
					continue
				}
				writes = append(writes, edge.Target)
				if edge.Provenance != "parsed" {
					t.Errorf("write provenance: got %q, want parsed", edge.Provenance)
				}
				for _, evidence := range s.Evidence {
					if evidence.RelationshipID != edge.ID || (evidence.Start == nil && evidence.End == nil) {
						continue
					}
					spans++
					if !tc.explicit || evidence.Start == nil || evidence.End == nil || tc.sql[*evidence.Start:*evidence.End] != "third" {
						t.Errorf("unexpected source range on write to %s: %+v", edge.Target, evidence)
					}
				}
			}
			slices.Sort(writes)
			if !slices.Equal(writes, tc.want) {
				t.Errorf("insert targets: got %v, want %v", writes, tc.want)
			}
			if tc.explicit && spans != 1 {
				t.Errorf("explicit write evidence: got %d source spans, want 1", spans)
			}
		})
	}
}
