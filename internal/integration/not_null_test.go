package integration

import (
	"strings"
	"testing"

	"postgres-viz/internal/snapshot"
)

type fixtureColumn struct{ schema, table, column string }

var explicitNotNull = map[string][]fixtureColumn{
	"commerce": {{"identity", "tenants", "name"}},
	"regression": {
		{"public", "customers", "name"},
		{"public", "orders", "customer_id"},
		{"public", "orders", "total"},
		{"payroll", "paycode", "paycode_type"},
		{"payroll", "paycode", "currency"},
		{"payroll", "report_entry", "payroll_report_id"},
		{"payroll", "report_entry", "employee_id"},
		{"payroll", "report_entry", "amount"},
	},
}

// PostgreSQL 18 stores NOT NULL constraints, including those implied by
// primary keys, in pg_constraint. All these fixtures use generated names.
func expectNotNullConstraints(t *testing.T, fixture string, want *snapshot.Snapshot) {
	t.Helper()
	objects := make(map[string]snapshot.Object, len(want.Objects))
	for _, object := range want.Objects {
		objects[object.ID] = object
	}
	columns := make(map[string]snapshot.Column, len(want.Columns))
	namedColumns := make(map[fixtureColumn]snapshot.Column, len(want.Columns))
	for _, column := range want.Columns {
		columns[column.ID] = column
		parent := objects[column.ObjectID]
		namedColumns[fixtureColumn{parent.Schema, parent.Name, column.Name}] = column
	}
	add := func(column snapshot.Column) {
		parent := objects[column.ObjectID]
		id := "not-null|" + column.ID
		want.Objects = append(want.Objects, snapshot.Object{
			ID: id, Schema: parent.Schema, ParentID: parent.ID, Kind: "constraint",
			Name: parent.Name + "_" + column.Name + "_not_null", Detail: "NOT NULL " + column.Name,
		})
		want.Relationships = append(want.Relationships, snapshot.Relationship{
			ID: "constrains|" + id, Source: id, Target: column.ID, Kind: "constrains", Provenance: "catalog",
		})
	}
	for _, relationship := range want.Relationships {
		source := objects[relationship.Source]
		if relationship.Kind == "constrains" && source.Kind == "constraint" && strings.HasPrefix(source.Detail, "PRIMARY KEY (") {
			add(columns[relationship.Target])
		}
	}
	for _, name := range explicitNotNull[fixture] {
		column, ok := namedColumns[name]
		if !ok {
			t.Fatalf("fixture lacks NOT NULL column %s.%s.%s", name.schema, name.table, name.column)
		}
		add(column)
	}
}
