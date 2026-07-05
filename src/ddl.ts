import { withClient } from "./db";
import type { NodeType } from "./types";

export interface TableColumnDdl {
  name: string;
  type: string;
  notnull?: boolean;
  def?: string | null;
}

export interface SqlObjectName {
  schema?: string;
  name: string;
  display?: string;
}

export function quoteSqlIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function splitQualifiedSqlName(label: string): string[] {
  let dot = -1;
  let quoted = false;
  for (let i = 0; i < label.length; i++) {
    const ch = label[i];
    if (ch === '"') {
      if (quoted && label[i + 1] === '"') {
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "." && !quoted) {
      dot = i;
      break;
    }
  }
  if (dot < 0) return label.length > 0 ? [label] : [];
  const schema = label.slice(0, dot);
  const objectName = label.slice(dot + 1);
  if (!schema) return objectName ? [objectName] : [];
  return objectName ? [schema, objectName] : [schema];
}

function unquoteSqlIdent(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replace(/""/g, '"')
    : name;
}

export function quoteQualifiedSqlName(label: string): string {
  return splitQualifiedSqlName(label)
    .map((part) => quoteSqlIdent(unquoteSqlIdent(part)))
    .join(".");
}

export function quoteSqlObjectName(name: SqlObjectName): string {
  return (name.schema ? [name.schema, name.name] : [name.name]).map(quoteSqlIdent).join(".");
}

function lineCommentText(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

export function renderTableDdl(
  label: string,
  columns: TableColumnDdl[],
  objectName?: SqlObjectName,
): string {
  const body = columns
    .map((r) => {
      const defaultSql = r.def ? ` DEFAULT ${r.def}` : "";
      return `  ${quoteSqlIdent(String(r.name))} ${r.type}${r.notnull ? " NOT NULL" : ""}${defaultSql}`;
    })
    .join(",\n");
  const display = objectName?.display ?? label;
  const qualifiedName = objectName ? quoteSqlObjectName(objectName) : quoteQualifiedSqlName(label);
  return `-- ${lineCommentText(display)} (columns)\nCREATE TABLE ${qualifiedName} (\n${body}\n);`;
}

export async function fetchDdl(
  conn: string | undefined,
  nodeType: NodeType,
  oid: number,
  label: string,
  objectName?: SqlObjectName,
): Promise<string> {
  if (nodeType === "schema") {
    return `-- ${lineCommentText(label)}: schemas do not have generated DDL documents`;
  }
  if (!conn || !Number.isFinite(oid)) {
    return `-- ${lineCommentText(label)}: connect in the Postgres Viz panel first`;
  }
  return withClient(conn, async (client) => {
    switch (nodeType) {
      case "view":
      case "matview": {
        const def = (await client.query("SELECT pg_get_viewdef($1::oid, true) AS def", [oid]))
          .rows[0]?.def;
        return `-- ${lineCommentText(label)}\n${def ?? ""}`;
      }
      case "function":
        return (
          (await client.query("SELECT pg_get_functiondef($1::oid) AS def", [oid])).rows[0]?.def ??
          ""
        );
      case "trigger": {
        const def = (await client.query("SELECT pg_get_triggerdef($1::oid, true) AS def", [oid]))
          .rows[0]?.def;
        return `${def ?? ""};`;
      }
      case "constraint": {
        const def = (await client.query("SELECT pg_get_constraintdef($1::oid, true) AS def", [oid]))
          .rows[0]?.def;
        return `-- ${lineCommentText(label)}\n${def ?? ""}`;
      }
      case "index": {
        const def = (await client.query("SELECT pg_get_indexdef($1::oid, 0, true) AS def", [oid]))
          .rows[0]?.def;
        return `${def ?? ""};`;
      }
      default: {
        const rows = (
          await client.query(
            `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
                    a.attnotnull AS notnull, pg_get_expr(ad.adbin, ad.adrelid) AS def
             FROM pg_attribute a
             LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
             WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY a.attnum`,
            [oid],
          )
        ).rows;
        return renderTableDdl(label, rows as TableColumnDdl[], objectName);
      }
    }
  });
}
