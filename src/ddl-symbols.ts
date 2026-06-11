/**
 * Pure line scanner that turns the SQL text `fetchDdl` (src/extension.ts) emits
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

// CREATE [OR REPLACE] TABLE|VIEW|MATERIALIZED VIEW|FUNCTION|TRIGGER|[UNIQUE] INDEX <name>
const CREATE_RE =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(UNIQUE)\s+)?(TABLE|MATERIALIZED\s+VIEW|VIEW|FUNCTION|TRIGGER|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/i;

// `-- schema.name` (with optional trailing "(columns)") preamble comment
const COMMENT_RE = /^\s*--\s+(\S+?)(?:\s+\(columns\))?\s*$/;

// constraint keyword first-lines (shape 6, also TABLE table-level constraints)
const CONSTRAINT_RE =
  /^\s*(?:CONSTRAINT\s+("?[\w$]+"?)\s+)?(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|EXCLUDE)\b/i;

// AS $tag$ — capture the dollar-quote tag that opens (and closes) a fn body
const DOLLAR_OPEN_RE = /\bAS\s+(\$[\w]*\$)/i;

// statement starts inside a plpgsql body, anchored after ; BEGIN THEN ELSE LOOP
// or the start of a line. Captures the keyword and the first identifier target.
const STMT_RE = /^\s*(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|PERFORM)\s+([A-Za-z_][\w$.]*)/i;

const mapHeaderKind = (raw: string): DdlSymbol["kind"] => {
  const k = raw.toLowerCase().replace(/\s+/g, " ");
  if (k === "table") return "table";
  if (k === "view" || k === "materialized view") return "view";
  if (k === "function") return "function";
  if (k === "trigger") return "trigger";
  return "index";
};

const stripQuotes = (s: string): string => s.replace(/^"|"$/g, "");

function makeStatement(line: number, kw: string, target: string): DdlSymbol {
  const keyword = kw.toUpperCase().replace(/\s+/g, " ");
  return {
    name: `${keyword} ${target}`,
    kind: "statement",
    line,
    col: 0,
    endLine: line,
    children: [],
    detail: keyword,
  };
}

// Parse the column / table-constraint lines between `CREATE TABLE … (` and `);`.
function parseTableBody(lines: string[], start: number, end: number): DdlSymbol[] {
  const out: DdlSymbol[] = [];
  for (let i = start; i < end; i++) {
    const raw = lines[i] ?? "";
    if (!raw.trim()) continue;
    const con = CONSTRAINT_RE.exec(raw);
    if (con) {
      const name = con[1] ? stripQuotes(con[1]) : con[2]!.toUpperCase().replace(/\s+/g, " ");
      out.push({ name, kind: "constraint", line: i, col: 0, endLine: i, children: [] });
      continue;
    }
    // first token of a `  name type …` column line
    const m = /^\s*("?[\w$]+"?)\s+\S/.exec(raw);
    if (m) {
      const name = stripQuotes(m[1]!);
      const col = raw.indexOf(m[1]!);
      out.push({ name, kind: "column", line: i, col: col < 0 ? 0 : col, children: [], endLine: i });
    }
  }
  return out;
}

// Scan a plpgsql body for top-level DML; assignments (NEW.x := …) never match.
function parseFunctionBody(lines: string[], start: number, end: number): DdlSymbol[] {
  const out: DdlSymbol[] = [];
  for (let i = start; i < end; i++) {
    const m = STMT_RE.exec(lines[i] ?? "");
    if (m) out.push(makeStatement(i, m[1]!, m[2]!));
  }
  return out;
}

export function parseDdlSymbols(content: string): DdlSymbol[] {
  const out: DdlSymbol[] = [];
  if (!content) return out;
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

    const create = CREATE_RE.exec(raw);
    if (create) {
      const kind = mapHeaderKind(create[2]!);
      const name = stripQuotes(create[3]!.replace(/\($/, ""));
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
        for (let j = i; j < lines.length; j++) {
          const open = DOLLAR_OPEN_RE.exec(lines[j] ?? "");
          if (open) {
            tag = open[1]!;
            bodyStart = j + 1;
            break;
          }
        }
        let close = lines.length - 1;
        if (tag) {
          for (let j = bodyStart; j < lines.length; j++) {
            if ((lines[j] ?? "").includes(tag)) {
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
        pendingName ?? (con[1] ? stripQuotes(con[1]) : con[2]!.toUpperCase().replace(/\s+/g, " "));
      out.push({ name, kind: "constraint", line: i, col: 0, endLine: i, children: [] });
      pendingName = null;
      continue;
    }

    // view / matview: a SELECT body with no CREATE header, named by the comment
    if (pendingName !== null && /^\s*SELECT\b/i.test(raw)) {
      out.push({
        name: pendingName,
        kind: "view",
        line: pendingNameLine,
        col: 0,
        endLine: i,
        children: [],
      });
      pendingName = null;
    }
  }

  return out;
}
