package snapshot

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestReferencesOutputQualifiesEndpointNames(t *testing.T) {
	s := New("test", nil, nil)
	s.Objects = []Object{
		{ID: "table", Kind: "table", Schema: "Billing Ops", Name: "invoice.lines"},
		{ID: "view1", Kind: "view", Schema: "sales.eu", Name: "audit"},
		{ID: "view2", Kind: "view", Schema: "sales", Name: "eu.audit"},
		{ID: "routine", Kind: "function", Schema: "sales", Name: "rollup(input numeric)"},
	}
	s.Columns = []Column{{ID: "column", ObjectID: "table", Name: `a"b`, Position: 1}}
	s.Relationships = []Relationship{
		{ID: "reads1", Source: "view1", Target: "column", Kind: "selects", Provenance: "catalog"},
		{ID: "reads2", Source: "view2", Target: "column", Kind: "selects", Provenance: "catalog"},
		{ID: "call", Source: "view2", Target: "routine", Kind: "calls", Provenance: "catalog"},
		{ID: "reads3", Source: "routine", Target: "column", Kind: "reads", Provenance: "parsed"},
	}
	const column = `"Billing Ops"."invoice.lines"."a""b"`
	refs, err := s.References(column, 2)
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	refs.Print(&output)
	want := column + "\n" +
		`"sales.eu".audit selects ` + column + " [catalog]\n" +
		`sales."eu.audit" selects ` + column + " [catalog]\n" +
		"sales.rollup(input numeric) reads " + column + " [parsed]\n" +
		"sales.rollup(input numeric) reads " + column + ` [parsed]  /  sales."eu.audit" calls sales.rollup(input numeric) [catalog]` + "\n"
	if got := output.String(); got != want {
		t.Errorf("output:\n%s\nwant:\n%s", got, want)
	}
	if got := refs.Paths[0][0].TargetName; got != column {
		t.Errorf("target name %q cannot be reused as selector %q", got, column)
	}
}

func TestReferencesOutputQualifiesParentScopedNames(t *testing.T) {
	s := New("test", nil, nil)
	s.Objects = []Object{
		{ID: "t1", Kind: "trigger", Schema: "Sales Ops", Name: "changed.at", ParentID: "orders"},
		{ID: "t2", Kind: "trigger", Schema: "Sales Ops", Name: "changed.at", ParentID: "drafts"},
		{ID: "k1", Kind: "constraint", Schema: "Sales Ops", Name: `min"qty`, ParentID: "orders"},
		{ID: "k2", Kind: "constraint", Schema: "Sales Ops", Name: `min"qty`, ParentID: "drafts"},
		{ID: "i1", Kind: "index", Schema: "Sales Ops", Name: "orders_qty_idx", ParentID: "orders"},
		{ID: "i2", Kind: "index", Schema: "Sales Ops", Name: "drafts_qty_idx", ParentID: "drafts"},
		{ID: "orders", Kind: "table", Schema: "Sales Ops", Name: "confirmed.orders"},
		{ID: "drafts", Kind: "table", Schema: "Sales Ops", Name: `draft"orders`},
	}
	s.Columns = []Column{
		{ID: "c1", ObjectID: "orders", Name: "qty", Position: 1, Type: "integer"},
		{ID: "c2", ObjectID: "drafts", Name: "qty", Position: 1, Type: "integer"},
	}
	s.Relationships = []Relationship{
		{ID: "trigger1", Source: "t1", Target: "c1", Kind: "update-of", Provenance: "catalog"},
		{ID: "constraint1", Source: "k1", Target: "c1", Kind: "constrains", Provenance: "catalog"},
		{ID: "index1", Source: "i1", Target: "c1", Kind: "indexes", Provenance: "catalog"},
		{ID: "trigger2", Source: "t2", Target: "c2", Kind: "update-of", Provenance: "catalog"},
		{ID: "constraint2", Source: "k2", Target: "c2", Kind: "constrains", Provenance: "catalog"},
		{ID: "index2", Source: "i2", Target: "c2", Kind: "indexes", Provenance: "catalog"},
	}
	if err := s.Validate(); err != nil {
		t.Fatal(err)
	}
	for i, tc := range []struct {
		parent string
		index  string
	}{
		{`"Sales Ops"."confirmed.orders"`, `"Sales Ops".orders_qty_idx`},
		{`"Sales Ops"."draft""orders"`, `"Sales Ops".drafts_qty_idx`},
	} {
		t.Run(tc.parent, func(t *testing.T) {
			column := tc.parent + ".qty"
			refs, err := s.References(column, 1)
			if err != nil {
				t.Fatal(err)
			}
			if len(refs.Paths) != 3 {
				t.Fatalf("got %d paths, want 3", len(refs.Paths))
			}
			wantNames := []string{tc.parent + `."changed.at"`, tc.parent + `."min""qty"`, tc.index}
			for j, path := range refs.Paths {
				hop := path[0]
				if want := s.Relationships[i*len(wantNames)+j]; hop.Relationship != want {
					t.Errorf("hop = %+v, want %+v", hop.Relationship, want)
				}
				if hop.SourceName != wantNames[j] || hop.TargetName != column {
					t.Errorf("hop labels = %q, %q, want %q, %q", hop.SourceName, hop.TargetName, wantNames[j], column)
				}
				selected, err := s.ObjectReferences(hop.SourceName, 1)
				if err != nil || selected.Object.ID != hop.Source || len(selected.Paths) != 0 {
					t.Errorf("object label lookup %s: %+v, %v", hop.SourceName, selected, err)
				}
			}
		})
	}
}

func TestObjectReferencesOverloadsAndCollisions(t *testing.T) {
	s := New("test", nil, nil)
	s.Objects = []Object{
		{ID: "fn1", Kind: "function", Schema: "sales", Name: "total(input numeric)"},
		{ID: "fn2", Kind: "function", Schema: "sales", Name: "total(input int)"},
		{ID: "table", Kind: "table", Schema: "sales", Name: "orders"},
		{ID: "policy", Kind: "policy", Schema: "sales", Name: "check", ParentID: "table"},
		{ID: "constraint", Kind: "constraint", Schema: "sales", Name: "check", ParentID: "table"},
	}
	s.Relationships = []Relationship{{ID: "r", Source: "fn1", Target: "fn2", Kind: "calls", Provenance: "parsed"}}
	for _, fn := range s.Objects[:2] {
		refs, err := s.ObjectReferences("sales."+fn.Name, 2)
		if err != nil || refs.Object.ID != fn.ID || (len(refs.Paths) == 1) != (fn.ID == "fn2") {
			t.Fatalf("wrong overload: %+v, error %v", refs, err)
		}
	}
	if _, err := s.ObjectReferences("sales.orders.check", 1); err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("expected ambiguous object error, got %v", err)
	}
	if _, err := s.ObjectReferences("sales.total()", 1); err == nil || !strings.Contains(err.Error(), "object not found") {
		t.Fatalf("expected missing object error, got %v", err)
	}
}

func TestReferencesOutputPrintsEvidence(t *testing.T) {
	s := New("test", nil, nil)
	s.Objects = []Object{
		{ID: "table", Kind: "table", Schema: "billing", Name: "invoices"},
		{ID: "routine", Kind: "function", Schema: "billing", Name: "rollup()"},
		{ID: "view", Kind: "view", Schema: "billing", Name: "totals"},
	}
	s.Columns = []Column{{ID: "column", ObjectID: "table", Name: "total", Position: 1}}
	s.Relationships = []Relationship{
		{ID: "read", Source: "routine", Target: "column", Kind: "reads", Provenance: "catalog"},
		{ID: "call", Source: "view", Target: "routine", Kind: "calls", Provenance: "catalog"},
	}
	const snippet = "SELECT total FROM billing.invoices"
	const viewDefinition = "SELECT billing.rollup()"
	s.Definitions = []Definition{
		{OwnerID: "routine", SQL: "BEGIN ATOMIC\n" + snippet + ";\nEND"},
		{OwnerID: "view", SQL: viewDefinition},
	}
	s.Evidence = []Evidence{
		{ID: "parsed", RelationshipID: "read", OwnerID: "routine", Provenance: "parsed", Snippet: snippet},
		{ID: "catalog", RelationshipID: "call", OwnerID: "view", Provenance: "catalog"},
	}
	refs, err := s.References("billing.invoices.total", 2)
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	refs.Print(&output)
	want := "billing.invoices.total\n" +
		"billing.rollup() reads billing.invoices.total [catalog]\n" +
		"  " + snippet + "\n" +
		"billing.rollup() reads billing.invoices.total [catalog]  /  billing.totals calls billing.rollup() [catalog]\n" +
		"  " + snippet + "\n" +
		"  " + viewDefinition + "\n"
	if got := output.String(); got != want {
		t.Errorf("output:\n%s\nwant:\n%s", got, want)
	}
}

func TestReferencesOutputEmptyPaths(t *testing.T) {
	s := New("test", nil, nil)
	s.Objects = []Object{{ID: "table", Kind: "table", Schema: "billing", Name: "invoices"}}
	s.Columns = []Column{{ID: "column", ObjectID: "table", Name: "total", Position: 1}}
	refs, err := s.References("billing.invoices.total", 2)
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	refs.Print(&output)
	if got := output.String(); got != "No recorded incoming references.\n" {
		t.Errorf("empty reference report = %q", got)
	}
	raw, err := json.Marshal(refs)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Column Column          `json:"column"`
		Paths  json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if result.Column.ID != "column" || string(result.Paths) != "[]" {
		t.Errorf("unexpected empty reference JSON: %s", raw)
	}
}

func TestReferencesLookupAndWalk(t *testing.T) {
	s := New("test", nil, nil)
	s.Objects = []Object{
		{ID: "base", Kind: "table", Schema: "billing", Name: "invoices"},
		{ID: "otherSchema", Kind: "table", Schema: "audit", Name: "invoices"},
		{ID: "otherTable", Kind: "table", Schema: "billing", Name: "credits"},
		{ID: "middle", Kind: "view", Schema: "billing", Name: "totals"},
		{ID: "branch", Kind: "view", Schema: "billing", Name: "revenue"},
		{ID: "caller", Kind: "function", Schema: "billing", Name: "rollup()"},
	}
	s.Columns = []Column{
		{ID: "wanted", ObjectID: "base", Name: "total", Position: 1},
		{ID: "otherSchemaCol", ObjectID: "otherSchema", Name: "total", Position: 1},
		{ID: "otherTableCol", ObjectID: "otherTable", Name: "total", Position: 1},
		{ID: "sibling", ObjectID: "base", Name: "subtotal", Position: 2},
	}
	s.Relationships = []Relationship{
		{ID: "middle-wanted", Source: "middle", Target: "wanted", Kind: "selects", Provenance: "catalog"},
		{ID: "branch-wanted", Source: "branch", Target: "wanted", Kind: "selects", Provenance: "catalog"},
		{ID: "middle-subtotal", Source: "middle", Target: "sibling", Kind: "selects", Provenance: "catalog"},
		{ID: "caller-middle", Source: "caller", Target: "middle", Kind: "reads", Provenance: "parsed"},
		{ID: "caller-branch", Source: "caller", Target: "branch", Kind: "reads", Provenance: "parsed"},
		{ID: "wanted-middle", Source: "wanted", Target: "middle", Kind: "reads", Provenance: "parsed"},
		{ID: "middle-middle", Source: "middle", Target: "middle", Kind: "selects", Provenance: "catalog"},
		{ID: "middle-caller", Source: "middle", Target: "caller", Kind: "calls", Provenance: "parsed"},
	}
	if err := s.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		depth int
		paths []string
	}{
		{1, []string{"middle-wanted", "branch-wanted"}},
		{2, []string{"middle-wanted", "middle-wanted/caller-middle", "branch-wanted", "branch-wanted/caller-branch"}},
	} {
		refs, err := s.References("BILLING.invoices.total", tc.depth)
		if err != nil || refs.Column.ID != "wanted" {
			t.Fatalf("depth %d selected column %q, error %v", tc.depth, refs.Column.ID, err)
		}
		var paths []string
		for _, path := range refs.Paths {
			var hops []string
			for _, hop := range path {
				hops = append(hops, hop.ID)
			}
			paths = append(paths, strings.Join(hops, "/"))
		}
		if !slices.Equal(paths, tc.paths) {
			t.Errorf("depth %d returned %v, want %v", tc.depth, paths, tc.paths)
		}
	}
}
