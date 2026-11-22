export type RelKind = "table" | "view" | "matview" | "foreign";

export type EdgeKind =
  | "selects"
  | "reads"
  | "inserts"
  | "updates"
  | "deletes"
  | "writes"
  | "modifies"
  | "calls"
  | "executes"
  | "update-of"
  | "fk"
  | "constrains"
  | "indexes"
  | "default";

export type Provenance = "catalog" | "parsed" | "fallback";
export interface SnapshotObject {
  id: string;
  schema: string;
  name: string;
  kind: RelKind | "function" | "procedure" | "trigger" | "constraint" | "index";
  parentId?: string;
  detail?: string;
}
export interface SnapshotColumn {
  id: string;
  objectId: string;
  name: string;
  type: string;
  position: number;
}
export interface Relationship {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  provenance: Provenance;
  constraintId?: string;
  position?: number;
}
export interface Definition {
  ownerId: string;
  sql: string;
}
export interface Evidence {
  id: string;
  relationshipId: string;
  ownerId: string;
  provenance: Provenance;
  snippet: string;
  start?: number;
  end?: number;
}
export interface Snapshot {
  format: "postgres-viz";
  version: 1;
  capturedAt: string;
  database: string;
  schemas: { include: string[] | null; exclude: string[] };
  objects: SnapshotObject[];
  columns: SnapshotColumn[];
  relationships: Relationship[];
  definitions: Definition[];
  evidence: Evidence[];
  diagnostics: {
    warnings: string[];
    unresolved: {
      ownerId: string;
      identifier: string;
      reason: string;
      snippet: string;
      candidateIds?: string[];
    }[];
  };
}

const kinds = [
  "table",
  "view",
  "matview",
  "foreign",
  "function",
  "procedure",
  "trigger",
  "constraint",
  "index",
];
const relationKinds = ["table", "view", "matview", "foreign"];
const edges = [
  "selects",
  "reads",
  "inserts",
  "updates",
  "deletes",
  "writes",
  "modifies",
  "calls",
  "executes",
  "update-of",
  "fk",
  "constrains",
  "indexes",
  "default",
];
const provenance = ["catalog", "fallback", "parsed"];

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error("Invalid snapshot: " + message);
}
function record(value: unknown, field: string): Record<string, unknown> {
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    field + " must be an object",
  );
  return value as Record<string, unknown>;
}
function string(obj: Record<string, unknown>, field: string, allowed?: string[]): string {
  const value = obj[field];
  check(typeof value === "string", "invalid " + field);
  if (allowed) check(allowed.includes(value), "invalid " + field + ": " + value);
  return value;
}
function rows(obj: Record<string, unknown>, field: string) {
  const value = obj[field];
  check(Array.isArray(value), field + " must be an array");
  return value.map((item, i) => record(item, field + "[" + i + "]"));
}
function strings(value: unknown, field: string): asserts value is string[] {
  check(
    Array.isArray(value) && value.every((item) => typeof item === "string"),
    field + " must be a string array",
  );
}
function unique(value: string, seen: Set<string>) {
  check(value.length && !seen.has(value), "empty or duplicate ID " + value);
  seen.add(value);
}
function ref(obj: Record<string, unknown>, field: string, seen: { has(id: string): boolean }) {
  const id = string(obj, field);
  check(seen.has(id), field + " references unknown ID " + id);
  return id;
}
function position(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function validCaptureTimestamp(value: string): boolean {
  const timestamp = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
  if (!timestamp.test(value)) return false;
  const date = value.slice(0, 10);
  const parsed = new Date(date);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}
export function readSnapshot(value: unknown): Snapshot {
  const root = record(value, "snapshot");
  if (root.graph && !root.format)
    throw new Error(
      "Legacy graph-only export lacks SQL evidence, analysis diagnostics and constraint mappings. Scan the database again to create a v1 snapshot.",
    );
  check(root.format === "postgres-viz", "expected postgres-viz format");
  check(typeof root.version === "number", "version must be a number");
  check(root.version === 1, "unsupported version " + root.version + " (supported: 1)");
  string(root, "database");
  check(validCaptureTimestamp(string(root, "capturedAt")), "invalid capturedAt");
  const schemas = record(root.schemas, "schemas");
  if (schemas.include !== null) strings(schemas.include, "schemas.include");
  strings(schemas.exclude, "schemas.exclude");
  const ids = new Set<string>();
  const objects = new Map<string, string>();
  const parents = new Map<string, string>();
  const objectRows = rows(root, "objects");
  for (const o of objectRows) {
    const id = string(o, "id");
    unique(id, ids);
    objects.set(id, string(o, "kind", kinds));
    string(o, "schema");
    string(o, "name");
    if (o.detail !== undefined) string(o, "detail");
  }
  for (const o of objectRows)
    if (o.parentId !== undefined) {
      const parent = ref(o, "parentId", objects);
      parents.set(String(o.id), parent);
      check(
        relationKinds.includes(objects.get(parent)!) &&
          ["constraint", "index", "trigger"].includes(String(o.kind)),
        "invalid object parent " + parent,
      );
    }
  const columns = new Map<string, string>();
  const positions = new Set<string>();
  for (const c of rows(root, "columns")) {
    const id = string(c, "id");
    unique(id, ids);
    const owner = ref(c, "objectId", objects);
    check(relationKinds.includes(objects.get(owner)!), "column owner must be a relation: " + owner);
    columns.set(id, owner);
    string(c, "type");
    string(c, "name");
    check(position(c.position), "invalid column position");
    const key = JSON.stringify([owner, c.position]);
    check(!positions.has(key), "duplicate column position " + c.position + " on " + owner);
    positions.add(key);
  }
  const endpoints = new Set(ids);
  const relationships = new Map<string, string>();
  const fks = new Map<string, { target: string; positions: Set<number> }>();
  for (const r of rows(root, "relationships")) {
    const id = string(r, "id");
    unique(id, ids);
    relationships.set(id, ref(r, "source", endpoints));
    ref(r, "target", endpoints);
    string(r, "kind", edges);
    string(r, "provenance", provenance);
    if (r.constraintId !== undefined) string(r, "constraintId");
    if (r.position !== undefined)
      check(Number.isSafeInteger(r.position), "invalid relationship position");
    if (r.kind === "fk") {
      const constraint = ref(r, "constraintId", objects);
      check(objects.get(constraint) === "constraint", "invalid FK constraint");
      check(
        position(r.position) && columns.has(String(r.source)) && columns.has(String(r.target)),
        "FK requires ordered column endpoints",
      );
      const target = columns.get(String(r.target))!;
      check(
        parents.get(constraint) === columns.get(String(r.source)),
        "FK source and constraint have different owners",
      );
      const group = fks.get(constraint) ?? { target, positions: new Set<number>() };
      check(
        group.target === target && !group.positions.has(r.position),
        "invalid FK target or repeated position on " + constraint,
      );
      group.positions.add(r.position);
      fks.set(constraint, group);
    }
  }
  for (const [id, group] of fks)
    for (const ordinal of group.positions)
      check(ordinal <= group.positions.size, "missing FK position on " + id);
  const definitions = new Map<string, string>();
  for (const d of rows(root, "definitions")) {
    const owner = ref(d, "ownerId", objects);
    check(!definitions.has(owner), "duplicate definition for " + owner);
    definitions.set(owner, string(d, "sql"));
  }
  for (const e of rows(root, "evidence")) {
    unique(string(e, "id"), ids);
    const owner = ref(e, "ownerId", definitions);
    const relationship = ref(e, "relationshipId", relationships);
    check(
      owner === relationships.get(relationship),
      "evidence owner does not match relationship source",
    );
    string(e, "snippet");
    string(e, "provenance", provenance);
    if (e.start !== undefined || e.end !== undefined) {
      check(
        typeof e.start === "number" &&
          typeof e.end === "number" &&
          Number.isSafeInteger(e.start) &&
          Number.isSafeInteger(e.end) &&
          e.start >= 0 &&
          e.end >= e.start &&
          e.end <= definitions.get(owner)!.length,
        "invalid evidence range",
      );
    }
  }
  const diagnostics = record(root.diagnostics, "diagnostics");
  strings(diagnostics.warnings, "diagnostics.warnings");
  for (const d of rows(diagnostics, "unresolved")) {
    ref(d, "ownerId", objects);
    string(d, "reason");
    string(d, "identifier");
    string(d, "snippet");
    if (d.candidateIds !== undefined) {
      strings(d.candidateIds, "candidateIds");
      for (const id of d.candidateIds)
        check(endpoints.has(id), "diagnostic references unknown candidate " + id);
    }
  }
  const snapshot = value as Snapshot;
  // Early v1 captures labeled procedures as functions. PostgreSQL's captured
  // CREATE statement distinguishes them even when the original DB is offline.
  const procedures = new Set<string>();
  for (const [id, sql] of definitions)
    if (objects.get(id) === "function" && /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s/i.test(sql))
      procedures.add(id);
  if (!procedures.size) return snapshot;
  return {
    ...snapshot,
    objects: snapshot.objects.map((o) => (procedures.has(o.id) ? { ...o, kind: "procedure" } : o)),
  };
}
