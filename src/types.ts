export type RelKind = "table" | "view" | "matview" | "foreign";

export interface CatalogRel {
  oid: number;
  schema: string;
  name: string;
  kind: RelKind;
}

export interface CatalogCol {
  relOid: number;
  attnum: number;
  name: string;
  type: string;
}

export interface CatalogTrigger {
  oid: number;
  name: string;
  relOid: number;
  funcOid: number;
  tgtype: number;
  /** attnums of an `UPDATE OF col, …` column list (empty otherwise) */
  updateCols: number[];
}

export interface CatalogFunc {
  oid: number;
  schema: string;
  name: string;
  language: string;
  kind: string;
  args: string;
  returns: string;
  src: string | null;
  /** full `CREATE FUNCTION` statement (plpgsql/sql only) */
  def: string | null;
  /** true for SQL-standard-body functions (PG14+); their deps come from pg_depend */
  hasSqlBody: boolean;
}

/** View → relation dependency from pg_rewrite/pg_depend. attnum 0 = whole-table. */
export interface ViewDep {
  viewOid: number;
  relOid: number;
  attnum: number;
}

export interface ViewFuncDep {
  viewOid: number;
  funcOid: number;
}

export interface Fk {
  name: string;
  relOid: number;
  refRelOid: number;
  cols: number[];
  refCols: number[];
}

/** CHECK / PRIMARY KEY / UNIQUE / EXCLUDE constraint (FKs are modelled as edges). */
export interface CatalogConstraint {
  oid: number;
  name: string;
  relOid: number;
  contype: string;
  cols: number[];
  def: string | null;
}

/** Function referenced by a constraint expression (CHECK …), from pg_depend. */
export interface ConstraintFuncDep {
  conOid: number;
  funcOid: number;
}

/** Function → relation dependency recorded by Postgres for BEGIN ATOMIC SQL bodies. */
export interface SqlBodyDep {
  funcOid: number;
  relOid: number;
  attnum: number;
}

/** Column default / generated-column expression dependency. */
export interface DefaultDep {
  relOid: number;
  attnum: number;
  refRelOid: number | null;
  refAttnum: number | null;
  refFuncOid: number | null;
}

export interface Catalog {
  rels: CatalogRel[];
  cols: CatalogCol[];
  triggers: CatalogTrigger[];
  funcs: CatalogFunc[];
  viewDeps: ViewDep[];
  viewFuncDeps: ViewFuncDep[];
  fks: Fk[];
  constraints: CatalogConstraint[];
  constraintFuncDeps: ConstraintFuncDep[];
  sqlBodyDeps: SqlBodyDep[];
  defaultDeps: DefaultDep[];
}

export type NodeType = RelKind | "column" | "function" | "trigger" | "constraint" | "schema";

export type EdgeKind =
  | "selects"
  | "reads"
  | "writes"
  | "calls"
  | "executes"
  | "update-of"
  | "fk"
  | "constrains"
  | "default";

export interface GraphNodeData {
  id: string;
  label: string;
  type: NodeType;
  parent?: string;
  schema?: string;
  detail?: string;
  /** pg oid used for DDL lookups (for columns: the parent relation's oid) */
  oid: number;
  /** the schema compound this node belongs in (so grouping can be toggled) */
  schemaParent?: string;
  /** row order inside an ERD card (columns by attnum, then triggers, constraints) */
  ord?: number;
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
  /** table-level duplicate of column-level edges; shown only when columns are hidden */
  dup?: boolean;
}

export interface GraphPayload {
  nodes: { data: GraphNodeData }[];
  edges: { data: GraphEdgeData }[];
  stats: Record<string, number>;
}
