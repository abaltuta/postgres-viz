import { analyzeAll, analyzeViews } from "./analyze";
import { buildColumnUsageStore, type ColumnUsageStore } from "./column-usage";
import { ClientCancelledError, withClientPool, type CancellationLike } from "./db";
import { buildGraph } from "./graph";
import { introspect, type Log } from "./introspect";
import type { GraphPayload } from "./types";

export interface LoadServiceOptions {
  conn: string;
  schemas: readonly unknown[];
  excludeSchemas: readonly unknown[];
  includeFks: boolean;
  log?: Log;
  analysisLog?: Log;
  cancellation?: CancellationLike;
}

export interface LoadDiagnostics {
  elapsedMs: number;
  database: string;
  schemas: {
    include: string[] | null;
    exclude: string[];
  };
  catalog: {
    relations: number;
    columns: number;
    functions: number;
    triggers: number;
    constraints: number;
    indexes: number;
  };
  analysis: {
    analyzedFunctions: number;
    parserFallbacks: number;
    skippedFunctions: number;
    analyzedViews: number;
    unresolvedReferences: number;
  };
  graph: {
    nodes: number;
    edges: number;
    stats: Record<string, number>;
  };
  warnings: string[];
}

export interface NormalizedSchemaFilter {
  include: string[] | null;
  exclude: string[];
}

export interface LoadServiceResult {
  graph: GraphPayload;
  usageStore: ColumnUsageStore;
  database: string;
  diagnostics: LoadDiagnostics;
}

export class LoadCancelledError extends Error {
  constructor() {
    super("load cancelled");
    this.name = "LoadCancelledError";
  }
}

function throwIfCancelled(cancellation?: CancellationLike): void {
  if (cancellation?.isCancellationRequested) throw new LoadCancelledError();
}

export function normalizeSchemaList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const schemas = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(schemas)];
}

export function normalizeSchemaFilter(
  schemas: unknown,
  excludeSchemas: unknown,
): NormalizedSchemaFilter {
  const includeList = normalizeSchemaList(schemas);
  const include = includeList.length > 0 ? includeList : null;
  return {
    include,
    exclude: include ? [] : normalizeSchemaList(excludeSchemas),
  };
}

export async function loadGraphFromDatabase(opts: LoadServiceOptions): Promise<LoadServiceResult> {
  const log = opts.log ?? (() => {});
  const analysisLog = opts.analysisLog ?? log;
  const startedAt = Date.now();
  const { include, exclude } = normalizeSchemaFilter(opts.schemas, opts.excludeSchemas);

  throwIfCancelled(opts.cancellation);
  try {
    return await withClientPool(
      opts.conn,
      async (client) => {
        throwIfCancelled(opts.cancellation);
        log("connected; introspecting catalogs...");
        const catalog = await introspect(client, { include, exclude }, (msg) => {
          throwIfCancelled(opts.cancellation);
          log(msg);
        });

        throwIfCancelled(opts.cancellation);
        const [analysis, viewAnalysis] = await Promise.all([
          analyzeAll(catalog, (msg) => {
            throwIfCancelled(opts.cancellation);
            analysisLog(msg);
          }),
          analyzeViews(catalog, (msg) => {
            throwIfCancelled(opts.cancellation);
            analysisLog(msg);
          }),
        ]);

        throwIfCancelled(opts.cancellation);
        log("building graph...");
        const graph = buildGraph(catalog, analysis, { includeFks: opts.includeFks });
        const usageStore = buildColumnUsageStore(catalog, graph, analysis, viewAnalysis);
        throwIfCancelled(opts.cancellation);
        const database = String(
          (await client.query("SELECT current_database() AS db")).rows[0]?.db ?? "",
        );
        if (!database) throw new Error("current_database() returned no database name");
        const parserFallbacks = [...analysis.values()].filter((refs) => !refs.parsed).length;
        const unresolvedReferences = [...analysis.values(), ...viewAnalysis.values()].reduce(
          (total, refs) => total + refs.diagnostics.length,
          0,
        );
        const warnings: string[] = [];
        if (graph.nodes.length > 3000) {
          warnings.push(
            'large graph - set "postgresViz.schemas" to a subset (e.g. ["public"]) to trim it',
          );
        }
        const owners = new Map([
          ...catalog.funcs.map((fn) => [fn.oid, `${fn.schema}.${fn.name}()`] as const),
          ...catalog.rels.map((rel) => [rel.oid, `${rel.schema}.${rel.name}`] as const),
        ]);
        const diagnostics = [...analysis, ...viewAnalysis].flatMap(([oid, refs]) =>
          refs.diagnostics.map(
            (diagnostic) =>
              `${owners.get(oid) ?? oid}: ${diagnostic.reason} ${diagnostic.identifier} - ${diagnostic.snippet}`,
          ),
        );
        warnings.push(...diagnostics.slice(0, 20));
        if (diagnostics.length > 20) {
          warnings.push(`${diagnostics.length - 20} additional unresolved references omitted`);
        }

        return {
          graph,
          usageStore,
          database,
          diagnostics: {
            elapsedMs: Date.now() - startedAt,
            database,
            schemas: { include, exclude },
            catalog: {
              relations: catalog.rels.length,
              columns: catalog.cols.length,
              functions: catalog.funcs.length,
              triggers: catalog.triggers.length,
              constraints: catalog.constraints.length,
              indexes: catalog.indexes.length,
            },
            analysis: {
              analyzedFunctions: analysis.size,
              parserFallbacks,
              skippedFunctions: catalog.funcs.length - analysis.size,
              analyzedViews: viewAnalysis.size,
              unresolvedReferences,
            },
            graph: {
              nodes: graph.nodes.length,
              edges: graph.edges.length,
              stats: graph.stats,
            },
            warnings,
          },
        };
      },
      opts.cancellation,
    );
  } catch (error) {
    if (error instanceof ClientCancelledError) throw new LoadCancelledError();
    throw error;
  }
}
