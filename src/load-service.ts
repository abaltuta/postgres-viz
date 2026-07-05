import { analyzeAll } from "./analyze";
import { withClient } from "./db";
import { buildGraph } from "./graph";
import { introspect, type Log } from "./introspect";
import type { GraphPayload } from "./types";

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
}

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
  return withClient(opts.conn, async (client) => {
    throwIfCancelled(opts.cancellation);
    log("connected; introspecting catalogs...");
    const catalog = await introspect(
      client,
      { include, exclude },
      (msg) => {
        throwIfCancelled(opts.cancellation);
        log(msg);
      },
    );

    throwIfCancelled(opts.cancellation);
    const analysis = await analyzeAll(catalog, (msg) => {
      throwIfCancelled(opts.cancellation);
      analysisLog(msg);
    });

    throwIfCancelled(opts.cancellation);
    log("building graph...");
    const graph = buildGraph(catalog, analysis, { includeFks: opts.includeFks });
    throwIfCancelled(opts.cancellation);
    const database: string = (await client.query("SELECT current_database() AS db")).rows[0].db;
    const parserFallbacks = [...analysis.values()].filter((refs) => !refs.parsed).length;
    const warnings =
      graph.nodes.length > 3000
        ? ['large graph - set "postgresViz.schemas" to a subset (e.g. ["public"]) to trim it']
        : [];

    return {
      graph,
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
        },
        graph: {
          nodes: graph.nodes.length,
          edges: graph.edges.length,
          stats: graph.stats,
        },
        warnings,
      },
    };
  });
}
