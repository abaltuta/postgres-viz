declare module "pg-query-emscripten" {
  export interface PgQueryError {
    message: string;
    funcname?: string;
    filename?: string;
    lineno?: number;
    cursorpos?: number;
  }
  export interface PgQueryInstance {
    parse(sql: string): { parse_tree: unknown; stderr_buffer: string; error?: PgQueryError | null };
    parsePlpgsql(sql: string): { plpgsql_funcs: unknown[]; error?: PgQueryError | null };
  }
  const factory: () => Promise<PgQueryInstance>;
  export default factory;
}
