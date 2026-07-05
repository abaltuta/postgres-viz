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

const HCL_STRING = String.raw`"((?:\\.|[^"\\])*)"`;
const TOP_BLOCK = new RegExp(
  String.raw`^\s*(schema|table|view|materialized|function|procedure|trigger)\s+${HCL_STRING}(?:\s+${HCL_STRING})?\s*\{`,
);
const CHILD_BLOCK = new RegExp(
  String.raw`^\s*(column|index|check|unique|foreign_key|trigger)\s+${HCL_STRING}\s*\{`,
);
const SCHEMA_ATTR = new RegExp(String.raw`^\s*schema\s*=\s*schema(?:\.([\w$]+)|\[${HCL_STRING}\])`);
const ON_ATTR = new RegExp(String.raw`^\s*on\s*=\s*table((?:\.[\w$]+|\[${HCL_STRING}\])+)`);

interface BraceState {
  blockComment: boolean;
}

/** Brace depth must ignore braces inside strings (jsonb defaults!) and comments. */
function braceDelta(raw: string, state: BraceState): number {
  let d = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (state.blockComment) {
      if (ch === "*" && next === "/") {
        state.blockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "#" || (ch === "/" && next === "/")) break;
    if (ch === "/" && next === "*") {
      state.blockComment = true;
      i++;
      continue;
    }
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
  const braceState: BraceState = { blockComment: false };

  const labelCol = (raw: string, labelIndex: number): number => {
    let seen = 0;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] !== '"') continue;
      if (seen === labelIndex) return i + 1;
      seen++;
      for (i++; i < raw.length; i++) {
        if (raw[i] === "\\") i++;
        else if (raw[i] === '"') break;
      }
    }
    return 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!braceState.blockComment) {
      if (depth === 0) {
        const m = TOP_BLOCK.exec(raw);
        if (m) {
          const [, kind, a, b] = m;
          const name = unescapeHclString(b ?? a!);
          top = { kind: kind!, name, line: i, col: labelCol(raw, b ? 1 : 0) };
          if (b) top.schema = unescapeHclString(a!); // two-label form: first label is the schema
          applyTopAttributes(raw, top, true);
          children = [];
        }
      } else if (depth === 1 && top) {
        const c = CHILD_BLOCK.exec(raw);
        if (c) {
          children.push({
            kind: c[1]!,
            name: unescapeHclString(c[2]!),
            owner: top.name,
            line: i,
            col: labelCol(raw, 0),
          });
        }
        applyTopAttributes(raw, top);
      }
    }
    depth += braceDelta(raw, braceState);
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

function applyTopAttributes(raw: string, top: HclEntry, afterOpeningBrace = false): void {
  const line = afterOpeningBrace ? raw.slice(raw.indexOf("{") + 1) : raw;
  const s = SCHEMA_ATTR.exec(line);
  if (s) top.schema ??= s[1] ?? unescapeHclString(s[2] ?? "");
  const o = ON_ATTR.exec(line);
  if (o) {
    const ref = tableRef(o[1]!);
    top.owner ??= ref.owner;
    top.schema ??= ref.schema;
  }
}

function tableRef(raw: string): { schema?: string; owner?: string } {
  const parts: string[] = [];
  for (let i = 0; i < raw.length; ) {
    if (raw[i] === ".") {
      const m = /^[\w$]+/.exec(raw.slice(i + 1));
      if (!m) break;
      parts.push(m[0]);
      i += m[0].length + 1;
      continue;
    }
    if (raw.startsWith('["', i)) {
      const start = i + 2;
      let value = "";
      i = start;
      for (; i < raw.length; i++) {
        const ch = raw[i]!;
        if (ch === "\\" && i + 1 < raw.length) {
          value += raw[i + 1]!;
          i++;
          continue;
        }
        if (ch === '"' && raw[i + 1] === "]") {
          i += 2;
          break;
        }
        value += ch;
      }
      if (value) parts.push(value);
      continue;
    }
    break;
  }
  return {
    schema: parts.length > 1 ? parts[parts.length - 2] : undefined,
    owner: parts[parts.length - 1],
  };
}

function unescapeHclString(raw: string): string {
  return raw.replace(/\\(["\\])/g, "$1");
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

function ambiguousVariant(i: number, prev: LocatedEntry, entry: LocatedEntry): boolean {
  const omitsSchema = i >= 2;
  const omitsOwner = i === 1 || i === 3;
  return (
    (omitsSchema && (prev.schema ?? "") !== (entry.schema ?? "")) ||
    (omitsOwner && (prev.owner ?? "") !== (entry.owner ?? ""))
  );
}

/**
 * Index entries under their key variants. Functions and tables regularly
 * share a name across schemas (set_updated_at!), and child objects share names
 * across owners (id!), so variants that omit a differing schema or owner are
 * dropped entirely — a lookup must never land on the wrong definition.
 * Fully-qualified collisions keep the first occurrence.
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
      if (ambiguousVariant(i, prev, e)) {
        map.delete(key);
        dropped.add(key);
      }
    });
  }
  return map;
}
