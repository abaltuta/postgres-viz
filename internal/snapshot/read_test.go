package snapshot

import (
	"bytes"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestReadRejectsInvalidUTF8(t *testing.T) {
	raw, err := json.Marshal(New("test-database", nil, nil))
	if err != nil {
		t.Fatal(err)
	}
	raw = bytes.Replace(raw, []byte("test-database"), []byte("test-\xff-database"), 1)
	if _, err := Read(raw); err == nil {
		t.Fatal("accepted invalid UTF-8 in database name")
	}
}

func TestSnapshotReaderCases(t *testing.T) {
	fixture, err := os.ReadFile("../../test/fixtures/commerce.pgviz.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Path   string
		Value  json.RawMessage
		Rename string
		Valid  bool
	}
	b, err := os.ReadFile("../../test/fixtures/snapshot-reader-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Path, func(t *testing.T) {
			var root map[string]any
			if err := json.Unmarshal(fixture, &root); err != nil {
				t.Fatal(err)
			}
			root["diagnostics"].(map[string]any)["unresolved"] = []any{
				map[string]any{"ownerId": "f", "identifier": "x", "reason": "unknown", "snippet": "x"},
			}
			var current any = root
			parts := strings.Split(tc.Path, ".")
			for _, part := range parts[:len(parts)-1] {
				switch container := current.(type) {
				case map[string]any:
					current = container[part]
				case []any:
					i, err := strconv.Atoi(part)
					if err != nil {
						t.Fatal(err)
					}
					current = container[i]
				}
			}
			parent := current.(map[string]any)
			key := parts[len(parts)-1]
			if tc.Value != nil {
				parent[key] = tc.Value
			} else {
				if tc.Rename != "" {
					parent[tc.Rename] = parent[key]
				}
				delete(parent, key)
			}
			raw, err := json.Marshal(root)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Read(raw); (err == nil) != tc.Valid {
				t.Fatalf("valid = %t, Read returned %v", tc.Valid, err)
			}
		})
	}
}
