package analysis

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"postgres-viz/internal/snapshot"
)

func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == "__parser" {
		if os.Getenv("PGVIZ_TEST_HUNG_PARSER") == "1" {
			var warmup request
			if err := json.NewDecoder(os.Stdin).Decode(&warmup); err != nil {
				os.Exit(1)
			}
			if err := json.NewEncoder(os.Stdout).Encode(response{Tree: json.RawMessage("{}")}); err != nil {
				os.Exit(1)
			}
			time.Sleep(time.Minute)
			return
		}
		if err := Worker(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	os.Exit(m.Run())
}

func TestWorkerTimeoutAndRecovery(t *testing.T) {
	t.Setenv("PGVIZ_TEST_HUNG_PARSER", "1")
	p := &parser{ctx: context.Background()}
	defer p.close()
	if _, err := p.parse("SELECT 1", false); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected timeout, got %v", err)
	}
	if p.cmd != nil {
		t.Fatal("timed-out worker still running")
	}
	t.Setenv("PGVIZ_TEST_HUNG_PARSER", "0")
	if _, err := p.parse("SELECT 2", false); err != nil {
		t.Fatal(err)
	}
	first := p.cmd.Process.Pid
	p.count = 500
	if _, err := p.parse("SELECT 3", false); err != nil {
		t.Fatal(err)
	}
	if first == p.cmd.Process.Pid {
		t.Fatal("parser process was not recycled")
	}
}

func TestWorkerCancellation(t *testing.T) {
	t.Setenv("PGVIZ_TEST_HUNG_PARSER", "1")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	p := &parser{ctx: ctx}
	defer p.close()
	if _, err := p.parse("SELECT 1", false); err == nil {
		t.Fatal("cancelled worker returned success")
	}
	if p.cmd != nil {
		t.Fatal("cancelled worker is still running")
	}
}

func TestRoutineFixture(t *testing.T) {
	data, err := os.ReadFile("../../examples/routines/routines.pgviz.json")
	if err != nil {
		t.Fatal(err)
	}
	var s snapshot.Snapshot
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatal(err)
	}
	var routines []snapshot.Routine
	for _, obj := range s.Objects {
		if obj.Kind != "function" && obj.Kind != "procedure" {
			continue
		}
		name, args, _ := strings.Cut(obj.Name, "(")
		for _, def := range s.Definitions {
			if def.OwnerID != obj.ID {
				continue
			}
			language := strings.Fields(obj.Detail)[0]
			_, rest, ok := strings.Cut(def.SQL, "AS $")
			if !ok {
				t.Fatal(def.SQL)
			}
			tag, body, _ := strings.Cut(rest, "$")
			body, _, _ = strings.Cut(body, "$"+tag+"$")
			routines = append(routines, snapshot.Routine{ID: obj.ID, Schema: obj.Schema, Name: name, Args: strings.TrimSuffix(args, ")"), Body: body, Definition: def.SQL, Language: language})
		}
	}
	edgeIDs := func(s snapshot.Snapshot) []string {
		var ids []string
		for _, e := range s.Relationships {
			ids = append(ids, e.ID+" "+e.Provenance)
		}
		slices.Sort(ids)
		return ids
	}
	want := edgeIDs(s)
	s.Relationships = slices.DeleteFunc(s.Relationships, func(e snapshot.Relationship) bool { return e.Provenance != "catalog" })
	s.Evidence = nil
	s.Diagnostics.Unresolved = nil
	if err := Analyze(context.Background(), &s, routines); err != nil {
		t.Fatal(err)
	}
	if got := edgeIDs(s); !slices.Equal(got, want) {
		t.Fatalf("relationships\ngot  %v\nwant %v", got, want)
	}
	if len(s.Diagnostics.Unresolved) != 1 || s.Diagnostics.Unresolved[0].Identifier != "EXECUTE" {
		t.Fatalf("diagnostics: %+v", s.Diagnostics.Unresolved)
	}
	for _, ref := range []string{"e.owner", "t.account_key", "t.change", "pending.delta"} {
		found := false
		for _, e := range s.Evidence {
			for _, d := range s.Definitions {
				if d.OwnerID == e.OwnerID && e.Start != nil && e.End != nil && d.SQL[*e.Start:*e.End] == ref {
					found = true
				}
			}
		}
		if found != (ref != "pending.delta") {
			t.Fatalf("incorrect attribution for %s", ref)
		}
	}
}
