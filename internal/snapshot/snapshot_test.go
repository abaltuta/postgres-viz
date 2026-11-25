package snapshot

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
)

func TestSnapshotRoundTrip(t *testing.T) {
	s := evidenceSnapshot()
	s.Database = `Sales.😀"DB`
	s.Schemas.Exclude = []string{`schema\"`}
	s.Objects[0].Name = `a."b` + "\u2028"
	snippet := `SELECT '"\<&>'` + "\r\n"
	s.Definitions[0].SQL = "😀" + snippet
	start, end := 2, 2+len(snippet)
	s.Evidence = []Evidence{{ID: "ev", OwnerID: "view", RelationshipID: "rel", Provenance: "parsed", Snippet: snippet, Start: &start, End: &end}}
	for _, include := range [][]string{nil, {}} {
		s.Schemas.Include = include
		path := filepath.Join(t.TempDir(), "snapshot.pgviz.json")
		if err := Write(t.Context(), path, s); err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		escaped := bytes.ReplaceAll(raw, []byte("😀"), []byte(`\uD83D\uDE00`))
		for _, data := range [][]byte{raw, escaped} {
			got, err := Read(data)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, s) {
				t.Fatalf("snapshot changed after round trip\ngot  %+v\nwant %+v", got, s)
			}
		}
	}
}

func TestWriteRejectsUnsafeIntegerPositions(t *testing.T) {
	unsafePosition, err := strconv.Atoi("9007199254740992")
	if err != nil {
		t.Skip("unsafe position is outside the native int range")
	}
	for _, position := range []struct {
		name string
		set  func(*Snapshot)
	}{
		{"column", func(s *Snapshot) {
			s.Columns = []Column{{ID: "col", ObjectID: "table", Position: unsafePosition}}
		}},
		{"relationship", func(s *Snapshot) {
			s.Relationships[0].Position = -unsafePosition
		}},
	} {
		t.Run(position.name, func(t *testing.T) {
			s := evidenceSnapshot()
			position.set(s)
			path := filepath.Join(t.TempDir(), "snapshot.pgviz.json")
			if err := Write(t.Context(), path, s); err == nil {
				t.Fatal("wrote a snapshot with an unsafe integer position")
			}
		})
	}
}

func TestExistingCapture(t *testing.T) {
	b, err := os.ReadFile("../../examples/routines/routines.pgviz.json")
	if err != nil {
		t.Fatal(err)
	}
	s, err := Read(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Objects) == 0 || len(s.Relationships) == 0 {
		t.Fatal("empty fixture")
	}
	s.Relationships[0].Target = "missing"
	b, err = json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Read(b); err == nil {
		t.Fatal("accepted dangling endpoint")
	}
}

func TestReferencesFollowColumnAndOverload(t *testing.T) {
	b, err := os.ReadFile("../../examples/routines/routines.pgviz.json")
	if err != nil {
		t.Fatal(err)
	}
	s, err := Read(b)
	if err != nil {
		t.Fatal(err)
	}
	refs, err := s.References(`"ledger".entries."account_id"`, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs.Paths) != 2 || len(refs.Paths[1]) != 2 || refs.Paths[1][1].Kind != "calls" {
		t.Fatal("lost two-hop routine call")
	}
	proof := refs.Paths[1][1].Evidence
	if len(proof) != 1 || proof[0].Snippet != "FROM ledger.account_deltas(cutoff) AS d(account_key, delta)" ||
		proof[0].Start == nil || proof[0].End == nil {
		t.Fatalf("lost call-site evidence: %+v", proof)
	}
	sibling, err := s.References("ledger.pending.delta", 2)
	if err != nil || len(sibling.Paths) != 0 {
		t.Fatal("leaked sibling references", err)
	}
}

func TestQuotedIdentifiers(t *testing.T) {
	names, err := qualifiedColumn(` "Sales Ops"."a.b"."a""b" `)
	if err != nil || len(names) != 3 || names[0] != "Sales Ops" || names[1] != "a.b" || names[2] != "a\"b" {
		t.Fatal(names, err)
	}
	for _, bad := range []string{"", "a.b", "a.b.c.d", `a.b."c`} {
		if _, err := qualifiedColumn(bad); err == nil {
			t.Fatal("accepted", bad)
		}
	}
}

func TestInterruptedSavePreservesSnapshot(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "example file.pgviz.json")
	s := New("old", nil, nil)
	if err := Write(context.Background(), path, s); err != nil {
		t.Fatal(err)
	}
	cancelCtx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := Write(cancelCtx, path, New("new", nil, nil)); err == nil {
		t.Fatal("cancelled save succeeded")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	old, err := Read(b)
	if err != nil || old.Database != "old" {
		t.Fatal("lost previous snapshot", err)
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 1 {
		t.Fatal("temporary output left behind")
	}
}
