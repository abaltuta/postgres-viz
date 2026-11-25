package snapshot

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"time"
	"unicode/utf16"
)

type Object struct {
	ID       string `json:"id"`
	Schema   string `json:"schema"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	ParentID string `json:"parentId,omitempty" snapshot:"nonempty"`
	Detail   string `json:"detail,omitempty"`
}

type Column struct {
	ID       string `json:"id"`
	ObjectID string `json:"objectId"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Position int    `json:"position"`
}

type Relationship struct {
	ID           string `json:"id"`
	Source       string `json:"source"`
	Target       string `json:"target"`
	Kind         string `json:"kind"`
	Provenance   string `json:"provenance"`
	ConstraintID string `json:"constraintId,omitempty"`
	Position     int    `json:"position,omitempty"`
}

type Definition struct {
	OwnerID string `json:"ownerId"`
	SQL     string `json:"sql"`
}

type Evidence struct {
	ID             string `json:"id"`
	RelationshipID string `json:"relationshipId"`
	OwnerID        string `json:"ownerId"`
	Provenance     string `json:"provenance"`
	Snippet        string `json:"snippet"`
	Start          *int   `json:"start,omitempty"`
	End            *int   `json:"end,omitempty"`
}

type Diagnostic struct {
	OwnerID      string   `json:"ownerId"`
	Identifier   string   `json:"identifier"`
	Reason       string   `json:"reason"`
	Snippet      string   `json:"snippet"`
	CandidateIDs []string `json:"candidateIds,omitempty"`
}

type Diagnostics struct {
	Warnings   []string     `json:"warnings"`
	Unresolved []Diagnostic `json:"unresolved"`
}

type Filters struct {
	Include []string `json:"include" snapshot:"nullable"`
	Exclude []string `json:"exclude"`
}

type Snapshot struct {
	Format        string         `json:"format"`
	Version       int            `json:"version"`
	CapturedAt    string         `json:"capturedAt"`
	Database      string         `json:"database"`
	Schemas       Filters        `json:"schemas"`
	Objects       []Object       `json:"objects"`
	Columns       []Column       `json:"columns"`
	Relationships []Relationship `json:"relationships"`
	Definitions   []Definition   `json:"definitions"`
	Evidence      []Evidence     `json:"evidence"`
	Diagnostics   Diagnostics    `json:"diagnostics"`
}

// Routine contains catalog metadata used during analysis, never connection details.
type Routine struct {
	ID, Schema, Name, Args, Language, Body, Definition, Returns string
	HasSQLBody                                                  bool
	ServerVersion                                               int
	CallParameters                                              []CallParameter
	SearchPath                                                  []string // nil means the caller supplies the search path
	InputTypes                                                  *string  // pg_proc.proargtypes, used to compare overload identities
}

// CallParameter describes a parameter supplied by the caller. Procedures include OUT slots.
type CallParameter struct {
	Name                string
	Defaulted, Variadic bool
}

func New(database string, include, exclude []string) *Snapshot {
	if exclude == nil {
		exclude = []string{}
	}
	return &Snapshot{Format: "postgres-viz", Version: 1, CapturedAt: time.Now().UTC().Format(time.RFC3339Nano), Database: database, Schemas: Filters{include, exclude}, Objects: []Object{}, Columns: []Column{}, Relationships: []Relationship{}, Definitions: []Definition{}, Evidence: []Evidence{}, Diagnostics: Diagnostics{[]string{}, []Diagnostic{}}}
}

var procedureDefinition = regexp.MustCompile(`(?i)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s`)
var captureTimestampPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$`)

const maxSafeInteger = 1<<53 - 1

func Read(b []byte) (*Snapshot, error) {
	var s Snapshot
	if err := decodeSnapshot(b, &s); err != nil {
		return nil, err
	}
	if err := s.Validate(); err != nil {
		return nil, err
	}
	defs := map[string]string{}
	for _, d := range s.Definitions {
		defs[d.OwnerID] = d.SQL
	}
	for i, o := range s.Objects {
		if o.Kind == "function" && procedureDefinition.MatchString(defs[o.ID]) {
			s.Objects[i].Kind = "procedure"
		}
	}
	return &s, nil
}

func (s *Snapshot) Validate() error {
	if s.Format != "postgres-viz" {
		return errors.New("expected postgres-viz snapshot")
	}
	if s.Version != 1 {
		return fmt.Errorf("unsupported snapshot version %d", s.Version)
	}
	// time.Parse also accepts some forms outside RFC 3339.
	if _, err := time.Parse(time.RFC3339Nano, s.CapturedAt); err != nil || !captureTimestampPattern.MatchString(s.CapturedAt) {
		return errors.New("invalid capture timestamp")
	}
	if s.Schemas.Exclude == nil || s.Objects == nil || s.Columns == nil || s.Relationships == nil || s.Definitions == nil || s.Evidence == nil || s.Diagnostics.Warnings == nil || s.Diagnostics.Unresolved == nil {
		return errors.New("missing required snapshot collection")
	}
	ids := map[string]bool{}
	objects := map[string]Object{}
	columns := map[string]Column{}
	edges := map[string]Relationship{}
	unique := func(id string) bool {
		if id == "" || ids[id] {
			return false
		}
		ids[id] = true
		return true
	}
	relations := []string{"table", "foreign", "view", "matview"}
	for _, o := range s.Objects {
		if !unique(o.ID) || (!slices.Contains(relations, o.Kind) && !slices.Contains([]string{"function", "procedure", "constraint", "index", "trigger", "policy"}, o.Kind)) {
			return fmt.Errorf("invalid object %q", o.ID)
		}
		objects[o.ID] = o
	}
	for _, o := range s.Objects {
		if o.ParentID != "" && (!slices.Contains(relations, objects[o.ParentID].Kind) || !slices.Contains([]string{"constraint", "trigger", "index", "policy"}, o.Kind)) {
			return fmt.Errorf("invalid parent for %q", o.ID)
		}
	}
	type pos struct {
		owner string
		ord   int
	}
	positions := map[pos]bool{}
	for _, c := range s.Columns {
		k := pos{c.ObjectID, c.Position}
		if !unique(c.ID) || c.Position < 1 || int64(c.Position) > maxSafeInteger || positions[k] || !slices.Contains(relations, objects[c.ObjectID].Kind) {
			return fmt.Errorf("invalid column %q", c.ID)
		}
		positions[k] = true
		columns[c.ID] = c
	}
	endpoint := func(id string) bool { return objects[id].ID != "" || columns[id].ID != "" }
	validOrigin := func(p string) bool { return p == "catalog" || p == "parsed" || p == "fallback" }
	fks := map[string]map[int]bool{}
	fkTargets := map[string]string{}
	for _, e := range s.Relationships {
		if !unique(e.ID) || !endpoint(e.Source) || !endpoint(e.Target) || !validOrigin(e.Provenance) || !slices.Contains([]string{"selects", "reads", "inserts", "updates", "deletes", "writes", "modifies", "calls", "executes", "update-of", "fk", "constrains", "indexes", "default"}, e.Kind) {
			return fmt.Errorf("invalid relationship %q", e.ID)
		}
		if int64(e.Position) < -maxSafeInteger || int64(e.Position) > maxSafeInteger {
			return fmt.Errorf("invalid relationship position on %q", e.ID)
		}
		if e.Kind == "fk" {
			k := objects[e.ConstraintID]
			a, b := columns[e.Source], columns[e.Target]
			if k.Kind != "constraint" || a.ID == "" || b.ID == "" || a.ObjectID != k.ParentID || e.Position < 1 {
				return fmt.Errorf("invalid foreign key %q", e.ID)
			}
			if fks[k.ID] == nil {
				fks[k.ID] = map[int]bool{}
				fkTargets[k.ID] = b.ObjectID
			}
			if fks[k.ID][e.Position] || fkTargets[k.ID] != b.ObjectID {
				return fmt.Errorf("invalid foreign key mapping %q", k.ID)
			}
			fks[k.ID][e.Position] = true
		}
		edges[e.ID] = e
	}
	for k, p := range fks {
		for n := 1; n <= len(p); n++ {
			if !p[n] {
				return fmt.Errorf("missing foreign key position on %s", k)
			}
		}
	}
	lengths := map[string]int{}
	for _, d := range s.Definitions {
		_, dup := lengths[d.OwnerID]
		if dup || objects[d.OwnerID].ID == "" {
			return fmt.Errorf("invalid definition %q", d.OwnerID)
		}
		lengths[d.OwnerID] = len(utf16.Encode([]rune(d.SQL)))
	}
	for _, e := range s.Evidence {
		size, ok := lengths[e.OwnerID]
		if !unique(e.ID) || !ok || edges[e.RelationshipID].Source != e.OwnerID || !validOrigin(e.Provenance) {
			return fmt.Errorf("invalid evidence %q", e.ID)
		}
		if e.Start != nil || e.End != nil {
			if e.Start == nil || e.End == nil || *e.Start < 0 || *e.End < *e.Start || *e.End > size {
				return fmt.Errorf("invalid evidence range on %q", e.ID)
			}
		}
	}
	for _, d := range s.Diagnostics.Unresolved {
		if objects[d.OwnerID].ID == "" {
			return errors.New("invalid diagnostic owner")
		}
		for _, id := range d.CandidateIDs {
			if !endpoint(id) {
				return fmt.Errorf("unknown diagnostic candidate %q", id)
			}
		}
	}
	return nil
}

func (s *Snapshot) CompleteEvidence() {
	seen := map[string]bool{}
	defs := map[string]bool{}
	ids := map[string]bool{}
	for _, o := range s.Objects {
		ids[o.ID] = true
	}
	for _, c := range s.Columns {
		ids[c.ID] = true
	}
	for _, r := range s.Relationships {
		ids[r.ID] = true
	}
	for _, d := range s.Definitions {
		defs[d.OwnerID] = d.SQL != ""
	}
	for _, e := range s.Evidence {
		seen[e.RelationshipID] = true
		ids[e.ID] = true
	}
	n := len(s.Evidence)
	for _, r := range s.Relationships {
		if !seen[r.ID] && defs[r.Source] {
			id := fmt.Sprintf("e%d", n)
			for ids[id] {
				n++
				id = fmt.Sprintf("e%d", n)
			}
			n++
			s.Evidence = append(s.Evidence, Evidence{ID: id, RelationshipID: r.ID, OwnerID: r.Source, Provenance: r.Provenance})
		}
	}
}

func Write(ctx context.Context, path string, s *Snapshot) error {
	if err := s.Validate(); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".postgres-viz-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = json.NewEncoder(f).Encode(s); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
