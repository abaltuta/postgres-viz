import type { AnalysisKind, FuncRefs } from "./analyze";
import type { Catalog, EdgeKind, GraphPayload } from "./types";
import type {
  ColumnUsageGroup,
  ColumnUsageResult,
  UsageOccurrencePage,
  UsageOwner,
} from "./protocol";

export interface UsageNavigation {
  owner: UsageOwner;
  snippet: string;
  definition?: string;
  start?: number;
  end?: number;
}

interface StoredGroup extends Omit<ColumnUsageGroup, "count" | "occurrences"> {
  relationCount: number;
  occurrenceIds: string[];
}

export interface ColumnUsageStore {
  groupsByColumn: Map<string, StoredGroup[]>;
  groupsById: Map<string, StoredGroup>;
  navigationById: Map<string, UsageNavigation>;
}

const SQL_KINDS = new Set<EdgeKind>([
  "reads",
  "selects",
  "inserts",
  "updates",
  "deletes",
  "writes",
  "modifies",
]);

export function buildColumnUsageStore(
  catalog: Catalog,
  graph: GraphPayload,
  functionAnalysis: ReadonlyMap<number, FuncRefs>,
  viewAnalysis: ReadonlyMap<number, FuncRefs>,
): ColumnUsageStore {
  const store: ColumnUsageStore = {
    groupsByColumn: new Map(),
    groupsById: new Map(),
    navigationById: new Map(),
  };
  const nodes = new Map(graph.nodes.map(({ data }) => [data.id, data]));
  const definitions = new Map<string, string>();
  const ownerNames = new Map<string, string>();
  for (const fn of catalog.funcs) {
    const definition = fn.def ?? fn.src;
    if (definition) definitions.set(`f${fn.oid}`, definition);
    ownerNames.set(`f${fn.oid}`, fn.name);
  }
  for (const rel of catalog.rels) {
    if (rel.definition) definitions.set(`r${rel.oid}`, rel.definition);
    ownerNames.set(`r${rel.oid}`, rel.name);
  }

  const ensureGroup = (
    column: string,
    ownerId: string,
    kind: EdgeKind,
  ): StoredGroup | undefined => {
    const ownerNode = nodes.get(ownerId);
    if (!ownerNode) return undefined;
    const id = `${column}|${ownerId}|${kind}`;
    let group = store.groupsById.get(id);
    if (!group) {
      group = {
        id,
        kind,
        section: SQL_KINDS.has(kind) ? "sql" : "structural",
        owner: {
          id: ownerNode.id,
          type: ownerNode.type,
          oid: ownerNode.oid,
          schema: ownerNode.schema,
          name: ownerNames.get(ownerId) ?? ownerNode.label,
          owner: ownerNode.parent ? nodes.get(ownerNode.parent)?.label : undefined,
          label: ownerNode.label,
          detail: ownerNode.detail,
        },
        relationCount: 0,
        occurrenceIds: [],
      };
      store.groupsById.set(id, group);
      const groups = store.groupsByColumn.get(column) ?? [];
      groups.push(group);
      store.groupsByColumn.set(column, groups);
    }
    return group;
  };

  for (const { data: edge } of graph.edges) {
    const sourceColumn = nodes.get(edge.source)?.type === "column";
    const targetColumn = nodes.get(edge.target)?.type === "column";
    if (sourceColumn) {
      const group = ensureGroup(edge.source, edge.target, edge.kind);
      if (group) group.relationCount++;
    }
    if (targetColumn) {
      const group = ensureGroup(edge.target, edge.source, edge.kind);
      if (group) group.relationCount++;
    }
  }

  const addAnalysis = (
    ownerId: string,
    refs: FuncRefs,
    kindMap: (kind: AnalysisKind) => EdgeKind,
  ): void => {
    refs.occurrences.forEach((occurrence, index) => {
      const column = `c${occurrence.relOid}_${occurrence.attnum}`;
      const kind = kindMap(occurrence.kind);
      const group = ensureGroup(column, ownerId, kind);
      if (!group) return;
      const id = `${ownerId}:${index}`;
      group.occurrenceIds.push(id);
      store.navigationById.set(id, {
        owner: group.owner,
        snippet: occurrence.snippet,
        definition: definitions.get(ownerId),
        start: occurrence.start,
        end: occurrence.end,
      });
    });
  };
  for (const [oid, refs] of functionAnalysis) addAnalysis(`f${oid}`, refs, (kind) => kind);
  for (const [oid, refs] of viewAnalysis) addAnalysis(`r${oid}`, refs, () => "selects");

  for (const groups of store.groupsByColumn.values()) {
    groups.sort(
      (a, b) =>
        (a.section === b.section ? 0 : a.section === "sql" ? -1 : 1) ||
        a.owner.name.localeCompare(b.owner.name) ||
        a.kind.localeCompare(b.kind),
    );
  }
  return store;
}

export function columnUsageResult(store: ColumnUsageStore, column: string): ColumnUsageResult {
  return {
    columnId: column,
    groups: (store.groupsByColumn.get(column) ?? []).map((group) => ({
      id: group.id,
      kind: group.kind,
      section: group.section,
      owner: group.owner,
      count: Math.max(group.relationCount, group.occurrenceIds.length),
      occurrences: group.occurrenceIds.slice(0, 3).flatMap((id) => {
        const navigation = store.navigationById.get(id);
        return navigation
          ? [{ id, snippet: navigation.snippet, exact: navigation.start !== undefined }]
          : [];
      }),
    })),
  };
}

export function usageOccurrencePage(
  store: ColumnUsageStore,
  id: string,
  offset: number,
  limit = 50,
): UsageOccurrencePage | undefined {
  const group = store.groupsById.get(id);
  if (!group) return undefined;
  const safeOffset = Math.max(0, Math.trunc(offset));
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  return {
    groupId: id,
    offset: safeOffset,
    total: group.occurrenceIds.length,
    occurrences: group.occurrenceIds
      .slice(safeOffset, safeOffset + safeLimit)
      .flatMap((occurrenceId) => {
        const navigation = store.navigationById.get(occurrenceId);
        return navigation
          ? [
              {
                id: occurrenceId,
                snippet: navigation.snippet,
                exact: navigation.start !== undefined,
              },
            ]
          : [];
      }),
  };
}
