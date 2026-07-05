import { keyVariants } from "./hcl";

export interface SqlMigrationEntry {
  kind: string;
  name: string;
  schema?: string;
  owner?: string;
  line: number;
  col: number;
}

export interface LocatedSqlMigrationEntry extends SqlMigrationEntry {
  file: string;
  /** Sortable migration identity; later values win for duplicate objects. */
  migrationKey: string;
}

const IDENT = String.raw`(?:"(?:""|[^"])*"|[A-Za-z_][\w$]*)`;
const QUAL = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;
const IDENT_END = String.raw`(?=\s|;|\(|\)|,|$)`;

const ROUTINE_RE = new RegExp(
  String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\s+(${QUAL})\s*\(`,
  "id",
);
const VIEW_RE = new RegExp(
  String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(MATERIALIZED)\s+)?(?:RECURSIVE\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUAL})(?=\s|;|\(|$)`,
  "id",
);
const TABLE_RE = new RegExp(
  String.raw`\bCREATE\s+(?:(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMPORARY|TEMP)\s+|UNLOGGED\s+)?(FOREIGN\s+TABLE|TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUAL})(?=\s|;|\(|$)`,
  "id",
);
const INDEX_RE = new RegExp(
  String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${QUAL})\s+ON\s+(?:ONLY\s+)?(${QUAL})${IDENT_END}`,
  "id",
);
const TRIGGER_RE = new RegExp(
  String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+(${IDENT})[\s\S]*?\bON\s+(?:ONLY\s+)?(${QUAL})(?=\s+(?:FROM|NOT\s+DEFERRABLE|DEFERRABLE|INITIALLY|REFERENCING|FOR|WHEN|EXECUTE)\b|\s*;|\s*$)`,
  "id",
);
const ALTER_TABLE_RE = new RegExp(
  String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUAL})(?=\s)`,
  "id",
);
const ADD_COLUMN_ACTION_RE = new RegExp(
  String.raw`^\s*ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})${IDENT_END}`,
  "id",
);
const ADD_ACTION_RE = /^\s*ADD\b/iu;
const CONSTRAINT_NAME_RE = new RegExp(String.raw`^CONSTRAINT\s+(${IDENT})${IDENT_END}`, "id");
const TABLE_COLUMN_RE = new RegExp(String.raw`^(\s*)(${IDENT})(?=\s)`, "id");
const TABLE_CONSTRAINT_WORDS = new Set([
  "CONSTRAINT",
  "PRIMARY",
  "FOREIGN",
  "UNIQUE",
  "CHECK",
  "EXCLUDE",
  "LIKE",
]);

interface Statement {
  text: string;
  code: string;
  start: number;
}

export function parseSqlMigrationSymbols(text: string): SqlMigrationEntry[] {
  const out: SqlMigrationEntry[] = [];
  const lineStarts = lineStartOffsets(text);
  for (const stmt of statements(text)) {
    const table = tableEntry(stmt);
    const entries = [
      routineEntry(stmt),
      viewEntry(stmt),
      table,
      indexEntry(stmt),
      triggerEntry(stmt),
      ...constraintEntries(stmt),
      ...columnEntries(stmt),
      ...tableConstraintEntries(stmt, table),
      ...tableColumnEntries(stmt, table),
    ];
    for (const entry of entries) {
      if (!entry) continue;
      const pos = lineCol(lineStarts, stmt.start + entry.offset);
      out.push({ ...entry.data, line: pos.line, col: pos.col });
    }
  }
  return out;
}

export function indexSqlMigrationEntries(
  entries: LocatedSqlMigrationEntry[],
): Map<string, LocatedSqlMigrationEntry> {
  const sorted = [...entries].sort(
    (a, b) =>
      naturalCompare(a.migrationKey, b.migrationKey) ||
      migrationFileRank(a.file) - migrationFileRank(b.file) ||
      naturalCompare(a.file, b.file) ||
      a.line - b.line ||
      a.col - b.col,
  );
  const map = new Map<string, LocatedSqlMigrationEntry>();
  const dropped = new Set<string>();
  for (const e of sorted) {
    keyVariants(e.kind, e.schema, e.owner, e.name).forEach((key, i) => {
      if (dropped.has(key)) return;
      const prev = map.get(key);
      if (!prev) {
        map.set(key, e);
        return;
      }
      if (ambiguousFallback(prev, e, i)) {
        map.delete(key);
        dropped.add(key);
        return;
      }
      map.set(key, e);
    });
  }
  return map;
}

export function sqlMigrationKeyFromPath(file: string): string {
  const clean = file
    .replace(/[?#].*$/, "")
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/+/u, "")
    .replace(/\\/g, "/");
  const parts = clean.split("/").filter(Boolean);
  if (parts.length > 0) parts.pop();
  return parts.join("/") || clean || file;
}

function routineEntry(stmt: Statement): PendingEntry | undefined {
  const m = ROUTINE_RE.exec(stmt.code);
  if (!m) return undefined;
  const qual = splitQualified(rawGroup(stmt.text, m, 2));
  return pendingAt(
    {
      kind: m[1]!.toLowerCase() === "procedure" ? "procedure" : "function",
      name: qual.name,
      schema: qual.schema,
    },
    groupSpan(m, 2),
  );
}

function viewEntry(stmt: Statement): PendingEntry | undefined {
  const m = VIEW_RE.exec(stmt.code);
  if (!m) return undefined;
  const qual = splitQualified(rawGroup(stmt.text, m, 2));
  return pendingAt(
    {
      kind: m[1] ? "materialized" : "view",
      name: qual.name,
      schema: qual.schema,
    },
    groupSpan(m, 2),
  );
}

function tableEntry(stmt: Statement): PendingEntry | undefined {
  const m = TABLE_RE.exec(stmt.code);
  if (!m) return undefined;
  const qual = splitQualified(rawGroup(stmt.text, m, 2));
  return pendingAt(
    {
      kind: "table",
      name: qual.name,
      schema: qual.schema,
    },
    groupSpan(m, 2),
  );
}

function indexEntry(stmt: Statement): PendingEntry | undefined {
  const m = INDEX_RE.exec(stmt.code);
  if (!m) return undefined;
  const name = splitQualified(rawGroup(stmt.text, m, 1));
  const owner = splitQualified(rawGroup(stmt.text, m, 2));
  return pendingAt(
    {
      kind: "index",
      name: name.name,
      schema: owner.schema ?? name.schema,
      owner: owner.name,
    },
    groupSpan(m, 1),
  );
}

function triggerEntry(stmt: Statement): PendingEntry | undefined {
  const m = TRIGGER_RE.exec(stmt.code);
  if (!m) return undefined;
  const rawName = rawGroup(stmt.text, m, 1);
  const owner = splitQualified(rawGroup(stmt.text, m, 2));
  return pendingAt(
    {
      kind: "trigger",
      name: stripIdent(rawName),
      schema: owner.schema,
      owner: owner.name,
    },
    groupSpan(m, 1),
  );
}

function constraintEntries(stmt: Statement): PendingEntry[] {
  const actions = alterTableActionItems(stmt);
  if (!actions) return [];
  const out: PendingEntry[] = [];
  for (const item of actions.items) {
    const code = maskSql(item.text, true);
    if (!ADD_ACTION_RE.test(code)) continue;
    for (const span of topLevelConstraintNameSpans(item.text)) {
      out.push({
        data: {
          kind: "constraint",
          name: stripIdent(item.text.slice(span.start, span.end)),
          schema: actions.owner.schema,
          owner: actions.owner.name,
        },
        offset: item.start + span.start,
        endOffset: item.start + span.end,
      });
    }
  }
  return out;
}

function columnEntries(stmt: Statement): PendingEntry[] {
  const actions = alterTableActionItems(stmt);
  if (!actions) return [];
  const out: PendingEntry[] = [];
  for (const item of actions.items) {
    const code = maskSql(item.text, true);
    const m = ADD_COLUMN_ACTION_RE.exec(code);
    if (!m) continue;
    const span = groupSpan(m, 1);
    const raw = item.text.slice(span.start, span.end);
    const name = stripIdent(raw);
    if (isUnquotedTableConstraintWord(raw)) continue;
    out.push({
      data: {
        kind: "column",
        name,
        schema: actions.owner.schema,
        owner: actions.owner.name,
      },
      offset: item.start + span.start,
      endOffset: item.start + span.end,
    });
  }
  return out;
}

function tableConstraintEntries(stmt: Statement, table: PendingEntry | undefined): PendingEntry[] {
  if (!table) return [];
  const range = tableBodyRange(stmt, table);
  if (!range) return [];
  const out: PendingEntry[] = [];
  for (const item of topLevelCommaItems(stmt.text, range.open + 1, range.close)) {
    for (const span of topLevelConstraintNameSpans(item.text)) {
      out.push({
        data: {
          kind: "constraint",
          name: stripIdent(item.text.slice(span.start, span.end)),
          schema: table.data.schema,
          owner: table.data.name,
        },
        offset: item.start + span.start,
        endOffset: item.start + span.end,
      });
    }
  }
  return out;
}

function tableColumnEntries(stmt: Statement, table: PendingEntry | undefined): PendingEntry[] {
  if (!table) return [];
  const range = tableBodyRange(stmt, table);
  if (!range) return [];
  const out: PendingEntry[] = [];
  for (const item of topLevelCommaItems(stmt.text, range.open + 1, range.close)) {
    const code = maskSql(item.text, true);
    const m = TABLE_COLUMN_RE.exec(code);
    if (m) {
      const span = groupSpan(m, 2);
      const raw = item.text.slice(span.start, span.end);
      if (!isUnquotedTableConstraintWord(raw)) {
        out.push({
          data: {
            kind: "column",
            name: stripIdent(raw),
            schema: table.data.schema,
            owner: table.data.name,
          },
          offset: item.start + span.start,
          endOffset: item.start + span.end,
        });
      }
    }
  }
  return out;
}

function tableBodyRange(
  stmt: Statement,
  table: PendingEntry,
): { open: number; close: number } | undefined {
  if (table.data.kind !== "table") return undefined;
  const afterName = skipWhitespace(stmt.code, table.endOffset);
  if (stmt.code[afterName] !== "(") return undefined;
  const open = afterName;
  const close = findMatchingParen(stmt.text, open);
  if (open < 0 || close <= open) return undefined;
  return { open, close };
}

function topLevelConstraintNameSpans(text: string): Array<{ start: number; end: number }> {
  const code = maskSql(text, true);
  const out: Array<{ start: number; end: number }> = [];
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || !identifierBoundaryBefore(code, i)) continue;
    const m = CONSTRAINT_NAME_RE.exec(code.slice(i));
    if (!m) continue;
    const span = groupSpan(m, 1);
    out.push({ start: i + span.start, end: i + span.end });
    i += m[0]!.length - 1;
  }
  return out;
}

function alterTableActionItems(
  stmt: Statement,
):
  | { owner: { schema?: string; name: string }; items: Array<{ text: string; start: number }> }
  | undefined {
  const m = ALTER_TABLE_RE.exec(stmt.code);
  if (!m) return undefined;
  const owner = splitQualified(rawGroup(stmt.text, m, 1));
  const actionsStart = groupSpan(m, 1).end;
  const actionsEnd = stmt.text.endsWith(";") ? stmt.text.length - 1 : stmt.text.length;
  return {
    owner,
    items: topLevelCommaItems(stmt.text, actionsStart, actionsEnd),
  };
}

interface PendingEntry {
  data: Omit<SqlMigrationEntry, "line" | "col">;
  offset: number;
  endOffset: number;
}

function pendingAt(
  data: Omit<SqlMigrationEntry, "line" | "col">,
  span: { start: number; end: number },
): PendingEntry {
  return { data, offset: span.start, endOffset: span.end };
}

function splitQualified(raw: string): { schema?: string; name: string } {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '"') {
      if (quoted && raw[i + 1] === '"') {
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "." && !quoted) {
      parts.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(raw.slice(start));
  const names = parts.map(stripIdent).filter(Boolean);
  const name = names[names.length - 1] ?? stripIdent(raw);
  const schema = names.length > 1 ? names[names.length - 2] : undefined;
  return { schema, name };
}

function stripIdent(raw: string): string {
  const s = raw.trim();
  return s.startsWith('"') && s.endsWith('"')
    ? s.slice(1, -1).replace(/""/g, '"')
    : s.toLowerCase();
}

function isUnquotedTableConstraintWord(raw: string): boolean {
  const s = raw.trim();
  return !s.startsWith('"') && TABLE_CONSTRAINT_WORDS.has(s.toUpperCase());
}

function identifierBoundaryBefore(text: string, offset: number): boolean {
  return offset <= 0 || !/[A-Za-z0-9_$]/.test(text[offset - 1]!);
}

function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineCol(starts: number[], offset: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (starts[mid]! <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  const line = Math.max(0, hi);
  return { line, col: offset - starts[line]! };
}

function* statements(text: string): Iterable<Statement> {
  let start = 0;
  let quote: "'" | '"' | null = null;
  let backslashEscapes = false;
  let dollar: string | null = null;
  let lineComment = false;
  let blockCommentDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (ch === "/" && next === "*") {
        blockCommentDepth++;
        i++;
        continue;
      }
      if (ch === "*" && next === "/") {
        blockCommentDepth--;
        i++;
      }
      continue;
    }
    if (dollar) {
      if (text.startsWith(dollar, i)) {
        i += dollar.length - 1;
        dollar = null;
      }
      continue;
    }
    if (quote) {
      if (quote === "'" && backslashEscapes && ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) {
        if (quote === "'" && next === "'") i++;
        else if (quote === '"' && next === '"') i++;
        else {
          quote = null;
          backslashEscapes = false;
        }
      }
      continue;
    }
    if (ch === "-" && next === "-") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockCommentDepth = 1;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      backslashEscapes = ch === "'" && singleQuoteBackslashEscapes(text, i);
      continue;
    }
    if (ch === "$") {
      const m = /^\$[\w]*\$/.exec(text.slice(i));
      if (m) {
        dollar = m[0];
        i += dollar.length - 1;
        continue;
      }
    }
    if (ch === ";") {
      const raw = text.slice(start, i + 1);
      yield { text: raw, code: maskSql(raw, true), start };
      start = i + 1;
    }
  }
  const raw = text.slice(start);
  if (raw.trim()) yield { text: raw, code: maskSql(raw, true), start };
}

function migrationFileRank(file: string): number {
  return /[\\/]up\.sql(?:$|[?#])/.test(file) ? 1 : 0;
}

function naturalCompare(a: string, b: string): number {
  const ac = a.match(/\d+|\D+/g) ?? [a];
  const bc = b.match(/\d+|\D+/g) ?? [b];
  const len = Math.min(ac.length, bc.length);
  for (let i = 0; i < len; i++) {
    const partA = ac[i]!;
    const partB = bc[i]!;
    const digitsA = /^\d+$/u.test(partA);
    const digitsB = /^\d+$/u.test(partB);
    if (digitsA && digitsB) {
      const numA = partA.replace(/^0+/u, "") || "0";
      const numB = partB.replace(/^0+/u, "") || "0";
      if (numA.length !== numB.length) return numA.length - numB.length;
      const cmp = numA.localeCompare(numB);
      if (cmp !== 0) return cmp;
      if (partA.length !== partB.length) return partA.length - partB.length;
    } else {
      const cmp = partA.localeCompare(partB);
      if (cmp !== 0) return cmp;
    }
  }
  return ac.length - bc.length;
}

function ambiguousFallback(
  prev: LocatedSqlMigrationEntry,
  next: LocatedSqlMigrationEntry,
  variantIndex: number,
): boolean {
  const missingSchema = variantIndex >= 2;
  const missingOwner = variantIndex === 1 || variantIndex === 3;
  return (
    (missingSchema && (prev.schema ?? "") !== (next.schema ?? "")) ||
    (missingOwner && (prev.owner ?? "") !== (next.owner ?? ""))
  );
}

function groupSpan(match: RegExpExecArray, group: number): { start: number; end: number } {
  const indices = (
    match as RegExpExecArray & {
      indices?: Array<[number, number] | undefined>;
    }
  ).indices;
  const span = indices?.[group];
  if (span) return { start: span[0], end: span[1] };
  const text = match[group] ?? "";
  const start = match.index + Math.max(0, match[0].lastIndexOf(text));
  return { start, end: start + text.length };
}

function rawGroup(source: string, match: RegExpExecArray, group: number): string {
  const span = groupSpan(match, group);
  return source.slice(span.start, span.end);
}

function skipWhitespace(text: string, offset: number): number {
  let i = offset;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

function findMatchingParen(text: string, open: number): number {
  const code = maskSql(text, false);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function topLevelCommaItems(
  text: string,
  start: number,
  end: number,
): Array<{ text: string; start: number }> {
  const code = maskSql(text, false);
  const out: Array<{ text: string; start: number }> = [];
  let itemStart = start;
  let depth = 0;
  for (let i = start; i < end; i++) {
    const ch = code[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      out.push({ text: text.slice(itemStart, i), start: itemStart });
      itemStart = i + 1;
    }
  }
  out.push({ text: text.slice(itemStart, end), start: itemStart });
  return out;
}

function maskSql(text: string, preserveQuotedIdentifiers: boolean): string {
  const chars = text.split("");
  const mask = (start: number, end: number): void => {
    for (let i = start; i < end; i++) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "-" && next === "-") {
      const start = i;
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      mask(start, i);
      continue;
    }
    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      let depth = 1;
      while (i < text.length && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++;
          i += 2;
          continue;
        }
        if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          i += 2;
          continue;
        }
        i++;
      }
      mask(start, i);
      i--;
      continue;
    }
    if (ch === "'") {
      const start = i;
      const backslashEscapes = singleQuoteBackslashEscapes(text, i);
      i++;
      while (i < text.length) {
        if (backslashEscapes && text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "'" && text[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      mask(start, i);
      i--;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[\w]*\$/.exec(text.slice(i))?.[0];
      if (tag) {
        const start = i;
        const close = text.indexOf(tag, i + tag.length);
        i = close >= 0 ? close + tag.length : text.length;
        mask(start, i);
        i--;
        continue;
      }
    }
    if (ch === '"') {
      const start = i;
      i++;
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      if (preserveQuotedIdentifiers) {
        for (let j = start + 1; j < i - 1; j++) {
          if (chars[j] !== "\n") chars[j] = "_";
        }
      } else {
        mask(start, i);
      }
      i--;
    }
  }
  return chars.join("");
}

function singleQuoteBackslashEscapes(text: string, quoteOffset: number): boolean {
  const prefix = text[quoteOffset - 1];
  return (prefix === "E" || prefix === "e") && identifierBoundaryBefore(text, quoteOffset - 1);
}
