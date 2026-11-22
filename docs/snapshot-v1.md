# Snapshot v1

A `.pgviz.json` file is UTF-8 JSON. The root object has `format` set to `"postgres-viz"`, numeric `version` set to `1`, the capture timestamp in `capturedAt`, and the database name in `database`. The effective schema filters are in `schemas.include` (an array or `null` for all eligible schemas) and `schemas.exclude`.

Use the RFC 3339 form `YYYY-MM-DDTHH:mm:ssZ` for `capturedAt`. A signed `+HH:mm` or `-HH:mm` offset can replace `Z`, and a decimal point followed by one or more digits can follow the seconds. Dates must exist in the Gregorian calendar, and seconds range from `00` through `59`. Readers preserve the original timestamp string.

| Collection | Fields and meaning |
| --- | --- |
| `objects` | `id`, `schema`, `name`, and `kind`. Kinds include table, foreign, view, matview, function, procedure, trigger, constraint, and index. Routine names include identity arguments. A nested object's `parentId` identifies its relation. Optional `detail` describes the object. |
| `columns` | `id`, `objectId`, `name`, `type`, and positive catalog `position`. Positions retain PostgreSQL attribute order, including gaps left by dropped columns. |
| `relationships` | `id`, `kind`, `source`, `target`, and `provenance`. Source and target identify an object or column. For example, a view that calls a function points to the function. Foreign-key pairs point from referencing to referenced column and carry `constraintId` plus a one-based `position` within that constraint. |
| `definitions` | One captured SQL `sql` string per `ownerId`. |
| `evidence` | Each record has an `id`, `relationshipId`, `ownerId`, `provenance`, and `snippet`. Optional `start` and `end` are zero-based, half-open UTF-16 offsets into the owner's definition. An empty snippet with omitted offsets points to the complete owner definition. |
| `diagnostics` | `warnings` contains scan notes. Each entry in `unresolved` gives the analysis owner's ID, the identifier, reason and SQL snippet. |

IDs are opaque and scoped to the file. Preserve identifiers exactly, including case, spaces, periods and embedded quotes. Capture includes SQL definitions and snippets, which can contain literals and comments. The connection string is never serialized.

`catalog` identifies PostgreSQL catalog facts. `parsed` identifies SQL syntax analysis. `fallback` identifies lexical matches or conservative relation-level references. A catalog relationship can also have parsed evidence for a particular occurrence. A view's call to a routine identifies the view as its source. PostgreSQL's routine dependency alone does not identify an output column. For SQL-standard function bodies, the catalog records dependencies without distinguishing reads and writes. Capture represents relation dependencies for those bodies with the `reads` kind.

Queries follow relationships in the selected direction and join on exact endpoint IDs. Maps group column endpoints under their relation and draw triggers, indexes and constraints as distinct objects. Same-table column links remain available in details. Visibility filters apply to the diagrams. Catalog browsing, SQL and detailed reference queries use the full snapshot.

The [round-trip fixture](../test/fixtures/commerce.pgviz.json) includes a SQL function, a view that calls it, a self-referencing foreign key and an unused column.
