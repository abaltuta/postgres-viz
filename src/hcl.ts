/**
 * Minimal Atlas-HCL symbol scanner. Finds where database objects are DEFINED
 * in `.hcl` schema files so the extension can jump to source instead of
 * showing generated DDL. This is a line scanner, not an HCL parser — it only
 * needs block headers, two attributes, and brace depth.
 *
 * Shapes handled (verified against real Atlas schemas):
 *   schema "payroll" { … }
 *   table "client" { schema = schema.public … }          ← schema via attribute
 *   table "analytics" "employment_cost_group" { … }      ← two-label form
 *   function "set_updated_at" { schema = schema.payroll }
 *   trigger "sync_x" { on = table.workspace … }          ← owner via `on =`
 *   nested in a table: column / index / check / unique / foreign_key "name"
 *   (primary_key blocks are unnamed and skipped)
 */

export interface HclEntry {
  /** block keyword: table | view | materialized | function | … | column | index */
  kind: string;
  name: string;
  /** postgres schema, from the first label (two-label form) or `schema = schema.X` */
  schema?: string;
  /** owning table: the enclosing block for nested entries, `on = table.X` for triggers */
  owner?: string;
  /** 0-based position of the name label */
  line: number;
  col: number;
}

const TOP_BLOCK =
  /^(schema|table|view|materialized|function|procedure|trigger)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/;
const CHILD_BLOCK = /^\s*(column|index|check|unique|foreign_key|trigger)\s+"([^"]+)"\s*\{/;
const SCHEMA_ATTR = /^\s*schema\s*=\s*schema(?:\.([\w$]+)|\["([^"]+)"\])/;
const ON_ATTR = /^\s*on\s*=\s*table(?:\.([\w$]+)|\["([^"]+)"\])/;

/** Brace depth must ignore braces inside strings (jsonb defaults!) and comments. */
function braceDelta(raw: string): number {
  const clean = raw.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/(#|\/\/).*$/, "");
  let d = 0;
  for (const ch of clean) {
    if (ch === "{") d++;
    else if (ch === "}") d--;
  }
  return d;
}

export function parseHclSymbols(text: string): HclEntry[] {
  const out: HclEntry[] = [];
  const lines = text.split("\n");
  let depth = 0;
  let top: HclEntry | null = null;
  let children: HclEntry[] = [];

  const colOf = (raw: string, name: string): number => {
    const i = raw.indexOf(`"${name}"`);
    return i >= 0 ? i + 1 : 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (depth === 0) {
      const m = TOP_BLOCK.exec(raw);
      if (m) {
        const [, kind, a, b] = m;
        const name = b ?? a!;
        top = { kind: kind!, name, line: i, col: colOf(raw, name) };
        if (b) top.schema = a; // two-label form: first label is the schema
        children = [];
      }
    } else if (depth === 1 && top) {
      const c = CHILD_BLOCK.exec(raw);
      if (c) {
        children.push({
          kind: c[1]!,
          name: c[2]!,
          owner: top.name,
          line: i,
          col: colOf(raw, c[2]!),
        });
      }
      const s = SCHEMA_ATTR.exec(raw);
      if (s) top.schema ??= s[1] ?? s[2];
      const o = ON_ATTR.exec(raw);
      if (o) top.owner ??= o[1] ?? o[2];
    }
    depth += braceDelta(raw);
    if (depth <= 0 && top) {
      // schema may be declared after the children — backfill at block close
      for (const ch of children) ch.schema = top.schema;
      out.push(top, ...children);
      top = null;
      children = [];
      depth = 0;
    }
  }
  return out;
}

/** An entry tagged with the file it came from (the extension supplies URIs). */
export interface LocatedEntry extends HclEntry {
  file: string;
}

/** Lookup keys from most to least specific — loose names still resolve. */
export function keyVariants(
  kind: string,
  schema: string | undefined,
  owner: string | undefined,
  name: string,
): string[] {
  return [
    `${kind}|${schema ?? ""}|${owner ?? ""}|${name}`,
    `${kind}|${schema ?? ""}||${name}`,
    `${kind}||${owner ?? ""}|${name}`,
    `${kind}|||${name}`,
  ];
}

/**
 * Index entries under their key variants. Functions and tables regularly
 * share a name across schemas (set_updated_at!), so a schema-LESS variant
 * claimed by entries from different schemas is dropped entirely — a lookup
 * must never land on the wrong schema's definition. Schema-qualified
 * collisions keep the first occurrence.
 */
export function indexEntries(entries: LocatedEntry[]): Map<string, LocatedEntry> {
  const map = new Map<string, LocatedEntry>();
  const dropped = new Set<string>();
  for (const e of entries) {
    keyVariants(e.kind, e.schema, e.owner, e.name).forEach((key, i) => {
      if (dropped.has(key)) return;
      const prev = map.get(key);
      if (!prev) {
        map.set(key, e);
        return;
      }
      const schemaQualified = i <= 1;
      if (!schemaQualified && (prev.schema ?? "") !== (e.schema ?? "")) {
        map.delete(key);
        dropped.add(key);
      }
    });
  }
  return map;
}
