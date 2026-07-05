/**
 * Pure line scanner that turns the SQL text `fetchDdl` (src/ddl.ts) emits
 * for a pgviz: virtual document into an outline tree — no vscode imports, so it
 * can run under `pnpm smoke`. Best-effort lexical anchoring (never a real SQL
 * parser); it must never throw on weird input.
 */

export interface DdlSymbol {
  name: string;
  kind: "table" | "view" | "function" | "trigger" | "index" | "constraint" | "column" | "statement";
  line: number;
  col: number;
  endLine: number;
  children: DdlSymbol[];
  detail?: string;
}

const IDENT = String.raw`(?:"(?:""|[^"])*"|[A-Za-z_][\w$]*)`;
const QUAL = String.raw`${IDENT}(?:\s*\.\s*${IDENT})*`;

// CREATE [OR REPLACE] TABLE|VIEW|MATERIALIZED VIEW|FUNCTION|PROCEDURE|[CONSTRAINT] TRIGGER|[UNIQUE] INDEX <name>
const CREATE_RE = new RegExp(
  String.raw`^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(UNIQUE|CONSTRAINT)\s+)?(TABLE|MATERIALIZED\s+VIEW|VIEW|FUNCTION|PROCEDURE|TRIGGER|INDEX)\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${QUAL})(?=\s|\(|;|$)`,
  "i",
);

// `-- schema.name` (with optional trailing "(columns)") preamble comment
const COMMENT_RE = /^\s*--\s+(.+?)(?:\s+\(columns\))?\s*$/;

// constraint keyword first-lines (shape 6, also TABLE table-level constraints)
const CONSTRAINT_RE = new RegExp(
  String.raw`^\s*(?:CONSTRAINT\s+(${IDENT})\s+)?(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|EXCLUDE)\b`,
  "i",
);

// AS $tag$ — capture the dollar-quote tag that opens (and closes) a fn body
const DOLLAR_OPEN_RE = /\bAS\s+(\$[\w]*\$)/i;

const TARGET_BOUNDARY = String.raw`(?=\s|\(|,|;|$)`;

const SELECT_RE = /^\s*SELECT\b/i;
const VIEW_BODY_RE = /^\s*(?:WITH\b|SELECT\b)/i;
const SELECT_FROM_RE = new RegExp(
  String.raw`\bFROM\s+(?:ONLY\s+)?(${QUAL})${TARGET_BOUNDARY}`,
  "i",
);
const INSERT_RE = new RegExp(String.raw`^\s*INSERT\s+INTO\s+(${QUAL})${TARGET_BOUNDARY}`, "i");
const UPDATE_RE = new RegExp(
  String.raw`^\s*UPDATE\s+(?:ONLY\s+)?(${QUAL})${TARGET_BOUNDARY}`,
  "i",
);
const DELETE_RE = new RegExp(
  String.raw`^\s*DELETE\s+FROM\s+(?:ONLY\s+)?(${QUAL})${TARGET_BOUNDARY}`,
  "i",
);
const PERFORM_RE = new RegExp(String.raw`^\s*PERFORM\s+(${QUAL})${TARGET_BOUNDARY}`, "i");
const CALL_RE = new RegExp(String.raw`^\s*CALL\s+(${QUAL})${TARGET_BOUNDARY}`, "i");
const STATEMENT_MATCHERS: [string, RegExp][] = [
  ["INSERT INTO", INSERT_RE],
  ["UPDATE", UPDATE_RE],
  ["DELETE FROM", DELETE_RE],
  ["PERFORM", PERFORM_RE],
  ["CALL", CALL_RE],
];

const mapHeaderKind = (raw: string): DdlSymbol["kind"] => {
  const k = raw.toLowerCase().replace(/\s+/g, " ");
  if (k === "table") return "table";
  if (k === "view" || k === "materialized view") return "view";
  if (k === "function" || k === "procedure") return "function";
  if (k === "trigger") return "trigger";
  return "index";
};

function unquoteIdent(raw: string): string {
  const s = raw.trim();
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s;
}

function normalizeQualifiedName(raw: string): string {
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
  return parts.map(unquoteIdent).join(".");
}

function makeStatement(line: number, kw: string, target: string): DdlSymbol {
  const keyword = kw.toUpperCase().replace(/\s+/g, " ");
  return {
    name: `${keyword} ${normalizeQualifiedName(target)}`,
    kind: "statement",
    line,
    col: 0,
    endLine: line,
    children: [],
    detail: keyword,
  };
}

function parseStatement(line: number, raw: string): DdlSymbol | null {
  if (SELECT_RE.test(raw)) {
    const from = SELECT_FROM_RE.exec(raw);
    return from ? makeStatement(line, "SELECT", from[1]!) : null;
  }
  for (const [keyword, pattern] of STATEMENT_MATCHERS) {
    const match = pattern.exec(raw);
    if (match) return makeStatement(line, keyword, match[1]!);
  }
  return null;
}

interface ScanMaskState {
  blockComment: boolean;
  dollarTag: string | null;
}

function spaces(n: number): string {
  return " ".repeat(n);
}

function maskSqlNonCode(raw: string, state: ScanMaskState): string {
  let out = "";
  let i = 0;

  while (i < raw.length) {
    if (state.dollarTag !== null) {
      const close = raw.indexOf(state.dollarTag, i);
      if (close < 0) {
        out += spaces(raw.length - i);
        break;
      }
      out += spaces(close + state.dollarTag.length - i);
      i = close + state.dollarTag.length;
      state.dollarTag = null;
      continue;
    }

    if (state.blockComment) {
      if (raw.startsWith("*/", i)) {
        out += "  ";
        i += 2;
        state.blockComment = false;
      } else {
        out += " ";
        i++;
      }
      continue;
    }

    if (raw.startsWith("--", i)) {
      out += spaces(raw.length - i);
      break;
    }

    if (raw.startsWith("/*", i)) {
      out += "  ";
      i += 2;
      state.blockComment = true;
      continue;
    }

    if (raw[i] === "'") {
      out += " ";
      i++;
      while (i < raw.length) {
        out += " ";
        if (raw[i] === "'") {
          i++;
          if (raw[i] === "'") {
            out += " ";
            i++;
            continue;
          }
          break;
        }
        i++;
      }
      continue;
    }

    if (raw[i] === "$") {
      const tag = /^\$[\w]*\$/.exec(raw.slice(i))?.[0] ?? null;
      if (tag) {
        out += spaces(tag.length);
        i += tag.length;
        state.dollarTag = tag;
        continue;
      }
    }

    out += raw[i]!;
    i++;
  }

  return out;
}

function isDollarCloseLine(raw: string, tag: string): boolean {
  const trimmed = raw.trim();
  return trimmed === tag || trimmed === `${tag};`;
}

function findRoutineFallbackEnd(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i++) {
    if (/;\s*$/.test(lines[i] ?? "")) return i;
  }
  return start;
}

function findViewEnd(lines: string[], start: number): number {
  let end = start;
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (i > start && (COMMENT_RE.test(raw) || CREATE_RE.test(raw))) break;
    if (raw.trim() === "") {
      if (i > start) break;
      continue;
    }
    end = i;
    if (/;\s*$/.test(raw)) break;
  }
  return end;
}

// Parse the column / table-constraint lines between `CREATE TABLE … (` and `);`.
function parseTableBody(lines: string[], start: number, end: number): DdlSymbol[] {
  const out: DdlSymbol[] = [];
  for (let i = start; i < end; i++) {
    const raw = lines[i] ?? "";
    if (!raw.trim()) continue;
    const con = CONSTRAINT_RE.exec(raw);
    if (con) {
      const name = con[1] ? unquoteIdent(con[1]) : con[2]!.toUpperCase().replace(/\s+/g, " ");
      out.push({ name, kind: "constraint", line: i, col: 0, endLine: i, children: [] });
      continue;
    }
    // first token of a `  name type …` column line
    const m = new RegExp(String.raw`^\s*(${IDENT})\s+\S`, "i").exec(raw);
    if (m) {
      const name = unquoteIdent(m[1]!);
      const col = raw.indexOf(m[1]!);
      out.push({ name, kind: "column", line: i, col: col < 0 ? 0 : col, children: [], endLine: i });
    }
  }
  return out;
}

// Scan a plpgsql body for top-level DML; assignments (NEW.x := …) never match.
function parseFunctionBody(lines: string[], start: number, end: number): DdlSymbol[] {
  const out: DdlSymbol[] = [];
  const maskState: ScanMaskState = { blockComment: false, dollarTag: null };
  for (let i = start; i < end; i++) {
    const sym = parseStatement(i, maskSqlNonCode(lines[i] ?? "", maskState));
    if (sym) out.push(sym);
  }
  return out;
}

export function parseDdlSymbols(content: string): DdlSymbol[] {
  if (!content) return [];
  const out: DdlSymbol[] = [];
  const lines = content.split("\n");

  // name carried by the most recent `-- schema.name` comment line
  let pendingName: string | null = null;
  let pendingNameLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";

    const cm = COMMENT_RE.exec(raw);
    if (cm) {
      pendingName = cm[1]!;
      pendingNameLine = i;
      continue;
    }

    const pendingNameAdjacent = pendingNameLine === i - 1;

    const create = CREATE_RE.exec(raw);
    if (create) {
      const kind = mapHeaderKind(create[2]!);
      const headerName = normalizeQualifiedName(create[3]!.replace(/\($/, ""));
      const name =
        kind === "table" && pendingNameLine === i - 1 && pendingName ? pendingName : headerName;
      const col = raw.indexOf(create[3]!);
      const sym: DdlSymbol = {
        name,
        kind,
        line: i,
        col: col < 0 ? 0 : col,
        endLine: i,
        children: [],
      };

      if (kind === "table") {
        let close = i;
        for (let j = i; j < lines.length; j++) {
          if (/^\s*\)\s*;?\s*$/.test(lines[j] ?? "")) {
            close = j;
            break;
          }
        }
        sym.endLine = close;
        sym.children = parseTableBody(lines, i + 1, close);
        out.push(sym);
        i = close;
      } else if (kind === "function") {
        // find the opening AS $tag$ line, then the matching closing tag line
        let bodyStart = i;
        let tag: string | null = null;
        let close = findRoutineFallbackEnd(lines, i);
        let sameLineDollarBody = false;
        for (let j = i; j < lines.length; j++) {
          const line = lines[j] ?? "";
          const open = DOLLAR_OPEN_RE.exec(line);
          if (open) {
            tag = open[1]!;
            bodyStart = j + 1;
            const afterOpen = open.index + open[0]!.length;
            if (line.indexOf(tag, afterOpen) >= 0) {
              close = j;
              sameLineDollarBody = true;
            }
            break;
          }
        }
        if (tag && !sameLineDollarBody) {
          close = lines.length - 1;
          for (let j = bodyStart; j < lines.length; j++) {
            if (isDollarCloseLine(lines[j] ?? "", tag)) {
              close = j;
              break;
            }
          }
          sym.children = parseFunctionBody(lines, bodyStart, close);
        }
        sym.endLine = close;
        out.push(sym);
        i = close;
      } else {
        out.push(sym);
      }
      pendingName = null;
      continue;
    }

    // standalone constraint first-line (shape 6) — name from preceding comment
    const con = CONSTRAINT_RE.exec(raw);
    if (con) {
      const name =
        pendingNameAdjacent && pendingName
          ? pendingName
          : con[1]
            ? unquoteIdent(con[1])
            : con[2]!.toUpperCase().replace(/\s+/g, " ");
      out.push({ name, kind: "constraint", line: i, col: 0, endLine: i, children: [] });
      pendingName = null;
      continue;
    }

    // view / matview: pg_get_viewdef text with no CREATE header, named by the comment
    if (pendingNameAdjacent && pendingName !== null && VIEW_BODY_RE.test(raw)) {
      const endLine = findViewEnd(lines, i);
      out.push({
        name: pendingName,
        kind: "view",
        line: pendingNameLine,
        col: 0,
        endLine,
        children: [],
      });
      pendingName = null;
      i = endLine;
    }

    if (raw.trim() !== "") pendingName = null;
  }

  return out;
}
