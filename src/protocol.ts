import type { EdgeKind, GraphPayload, NodeType } from "./types";

export interface UsageOwner {
  id: string;
  type: NodeType;
  oid: number;
  schema?: string;
  name: string;
  owner?: string;
  label?: string;
  detail?: string;
}

export interface UsageOccurrenceItem {
  id: string;
  snippet: string;
  exact: boolean;
}

export interface ColumnUsageGroup {
  id: string;
  kind: EdgeKind;
  section: "sql" | "structural";
  owner: UsageOwner;
  count: number;
  occurrences: UsageOccurrenceItem[];
}

export interface ColumnUsageResult {
  columnId: string;
  groups: ColumnUsageGroup[];
}

export interface UsageOccurrencePage {
  groupId: string;
  offset: number;
  total: number;
  occurrences: UsageOccurrenceItem[];
}

export interface Prefs {
  layout: "grid" | "tree";
  edgeMode: "off" | "cards" | "all";
  schemaGroup: boolean;
  route: boolean;
  hideIsolated: boolean;
  /** Add a subtle halo to the most connected visible objects. */
  emphasizeConnections: boolean;
  /** Tree/call-graph layout engine. */
  engine: "v1" | "v2";
  /** Empty = all schemas/types/kinds. */
  filterSchemas: string[];
  filterNodeTypes: NodeType[];
  filterEdgeKinds: EdgeKind[];
}

export const DEFAULT_PREFS: Prefs = {
  layout: "grid",
  edgeMode: "off",
  schemaGroup: true,
  route: false,
  hideIsolated: false,
  emphasizeConnections: false,
  engine: "v1",
  filterSchemas: [],
  filterNodeTypes: [],
  filterEdgeKinds: [],
};

const LAYOUTS = ["grid", "tree"] as const satisfies readonly Prefs["layout"][];
const EDGE_MODES = ["off", "cards", "all"] as const satisfies readonly Prefs["edgeMode"][];
const ENGINES = ["v1", "v2"] as const satisfies readonly Prefs["engine"][];
const FILTER_NODE_TYPES = [
  "table",
  "view",
  "matview",
  "foreign",
  "column",
  "function",
  "trigger",
  "constraint",
  "index",
] as const satisfies readonly Exclude<NodeType, "schema">[];
const EDGE_KINDS = [
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
] as const satisfies readonly EdgeKind[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringList(value: unknown, opts: { trim: boolean } = { trim: true }): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((item) => {
        if (typeof item !== "string") return [];
        const trimmed = item.trim();
        return trimmed ? [opts.trim ? trimmed : item] : [];
      }),
    ),
  ];
}

function enumList<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  const allowedSet = new Set<string>(allowed);
  return stringList(value).filter((item): item is T => allowedSet.has(item));
}

export function normalizePrefs(value: unknown): Prefs {
  const raw = isRecord(value) ? value : {};
  return {
    layout: oneOf(raw.layout, LAYOUTS, DEFAULT_PREFS.layout),
    edgeMode: oneOf(raw.edgeMode, EDGE_MODES, DEFAULT_PREFS.edgeMode),
    schemaGroup: boolOr(raw.schemaGroup, DEFAULT_PREFS.schemaGroup),
    route: boolOr(raw.route, DEFAULT_PREFS.route),
    hideIsolated: boolOr(raw.hideIsolated, DEFAULT_PREFS.hideIsolated),
    emphasizeConnections: boolOr(raw.emphasizeConnections, DEFAULT_PREFS.emphasizeConnections),
    engine: oneOf(raw.engine, ENGINES, DEFAULT_PREFS.engine),
    filterSchemas: stringList(raw.filterSchemas, { trim: false }),
    filterNodeTypes: enumList(raw.filterNodeTypes, FILTER_NODE_TYPES),
    filterEdgeKinds: enumList(raw.filterEdgeKinds, EDGE_KINDS),
  };
}

export const PREFS_KEY = "postgresViz.prefs";
export const HIDE_ISOLATED_TOUCHED_KEY = "postgresViz.userTouchedHideIsolated";

export type HostToWebviewMessage =
  | { type: "graph"; graph: GraphPayload; database: string; revision: number }
  | {
      type: "columnUsages";
      revision: number;
      requestId: number;
      result: ColumnUsageResult;
    }
  | {
      type: "usageOccurrences";
      revision: number;
      requestId: number;
      page: UsageOccurrencePage;
    }
  | { type: "clear"; message: string }
  | { type: "prefs"; prefs: Prefs }
  | { type: "reveal"; id: string }
  | { type: "searchSelect"; id: string }
  | { type: "callTreeById"; id: string }
  | { type: "fit" }
  | { type: "relayout" }
  | { type: "exitView" }
  | { type: "exportPng" }
  | { type: "exportSvg" }
  | { type: "status"; message: string }
  | { type: "error"; message: string };

export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "resetFilters" }
  | { type: "pngExport"; dataUri: string }
  | { type: "svgExport"; svg: string }
  | { type: "stats"; text?: string }
  | { type: "nodeSelected"; id?: string }
  | { type: "requestColumnUsages"; revision: number; requestId: number; columnId: string }
  | {
      type: "requestUsageOccurrences";
      revision: number;
      requestId: number;
      groupId: string;
      offset: number;
    }
  | { type: "openUsage"; revision: number; occurrenceId: string }
  | {
      type: "openDdl";
      nodeType: NodeType;
      oid: number;
      schema?: string;
      name?: string;
      label?: string;
    }
  | {
      type: "openDefinition";
      nodeType: NodeType;
      oid: number;
      schema?: string;
      name?: string;
      owner?: string;
      label?: string;
    };
