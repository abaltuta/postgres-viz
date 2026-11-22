package snapshot

import "testing"

func TestReferencesPostgreSQLIdentifiers(t *testing.T) {
	for _, tc := range []struct {
		selector string
		table    string
	}{
		{"SALES.Ångström.C$1", "Ångström"},
		{"sales.🔥.c$1", "🔥"},
		{"sales.name\u00a0.c$1", "name\u00a0"},
		{`sales.U&"d\0061t".c$1`, "dat"},
		{`sales.u&"a!002eb" UESCAPE '!'.c$1`, "a.b"},
	} {
		t.Run(tc.selector, func(t *testing.T) {
			s := New("test", nil, nil)
			s.Objects = []Object{{ID: "table", Kind: "table", Schema: "sales", Name: tc.table}}
			s.Columns = []Column{{ID: "column", ObjectID: "table", Name: "c$1", Position: 1}}
			refs, err := s.References(tc.selector, 1)
			if err != nil || refs.Column.ID != "column" {
				t.Fatalf("refs returned column %q and error %v", refs.Column.ID, err)
			}
		})
	}
	for _, selector := range []string{
		`sales.U&"d\zzzz".c`,
		`sales.U&"dat" UESCAPE '0'.c`,
		`sales.U&"dat" UESCAPE .c`,
		`sales.U&"dat".c FROM extra`,
		`sales.U&"dat".c;`,
		`sales.U&"dat".c.extra`,
	} {
		if _, err := qualifiedColumn(selector); err == nil {
			t.Errorf("accepted invalid selector %q", selector)
		}
	}
}

func TestValidateUTF16EvidenceOffsets(t *testing.T) {
	s := evidenceSnapshot()
	start, end := 2, 3
	s.Evidence = []Evidence{{ID: "e0", OwnerID: "view", RelationshipID: "rel", Provenance: "parsed", Snippet: "x", Start: &start, End: &end}}
	if err := s.Validate(); err != nil {
		t.Fatalf("valid UTF-16 range was rejected: %v", err)
	}
	end = 4
	if err := s.Validate(); err == nil {
		t.Fatal("out-of-range UTF-16 offset was accepted")
	}
}

func TestCompleteEvidenceAvoidsOccupiedIDs(t *testing.T) {
	s := evidenceSnapshot()
	s.Objects = append(s.Objects, Object{ID: "e1", Kind: "table"})
	s.Columns = []Column{{ID: "e4", ObjectID: "e1", Position: 1}}
	s.Relationships = append(s.Relationships, Relationship{ID: "e3", Source: "view", Target: "e4", Kind: "reads", Provenance: "catalog"})
	s.Evidence = []Evidence{{ID: "e2", OwnerID: "view", RelationshipID: "rel", Provenance: "parsed"}}
	if err := s.Validate(); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	s.CompleteEvidence()
	if err := s.Validate(); err != nil {
		t.Fatalf("invalid completed snapshot: %v", err)
	}
	if len(s.Evidence) != 2 || s.Evidence[1].RelationshipID != "e3" {
		t.Fatalf("unexpected evidence: %+v", s.Evidence)
	}
	s.CompleteEvidence()
	if len(s.Evidence) != 2 {
		t.Fatalf("completion duplicated existing evidence: %+v", s.Evidence)
	}
}

func evidenceSnapshot() *Snapshot {
	s := New("test", nil, nil)
	s.Objects = []Object{{ID: "view", Kind: "view"}, {ID: "table", Kind: "table"}}
	s.Relationships = []Relationship{{ID: "rel", Source: "view", Target: "table", Kind: "selects", Provenance: "catalog"}}
	s.Definitions = []Definition{{OwnerID: "view", SQL: "😀x"}}
	return s
}
