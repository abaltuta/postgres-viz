package snapshot

import "slices"

// Structure retains the graph and capture metadata for offline exploration.
func (s *Snapshot) Structure() *Snapshot {
	graph := New(s.Database, s.Schemas.Include, s.Schemas.Exclude)
	graph.CapturedAt = s.CapturedAt
	graph.Objects = slices.Clone(s.Objects)
	for i := range graph.Objects {
		graph.Objects[i].Detail = ""
	}
	graph.Columns = s.Columns
	graph.Relationships = s.Relationships
	return graph
}
