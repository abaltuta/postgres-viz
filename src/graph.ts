import type { FuncRefs } from "./analyze";
import { routineLabel } from "./routine-label";
import type { Catalog, EdgeKind, GraphEdgeData, GraphNodeData, GraphPayload } from "./types";

const relId = (oid: number): string => `r${oid}`;
const colId = (relOid: number, attnum: number): string => `c${relOid}_${attnum}`;
const fnId = (oid: number): string => `f${oid}`;
const trgId = (oid: number): string => `g${oid}`;
const conId = (oid: number): string => `k${oid}`;
const idxId = (oid: number): string => `i${oid}`;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const edgeKey = (kind: EdgeKind, source: string, target: string): string =>
  `${kind}|${source}|${target}`;

function cmpNums(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

const CONTYPE_LABEL: Record<string, string> = {
  c: "CHECK",
  p: "PRIMARY KEY",
  u: "UNIQUE",
  x: "EXCLUDE",
};

export function buildGraph(
  catalog: Catalog,
  analysis: Map<number, FuncRefs>,
  opts: { includeFks: boolean },
): GraphPayload {
  const relByOid = new Map(catalog.rels.map((r) => [r.oid, r]));
  const colByKey = new Map(catalog.cols.map((c) => [`${c.relOid}:${c.attnum}`, c]));
  const fnByOid = new Map(catalog.funcs.map((f) => [f.oid, f]));

  const edges = new Map<string, { data: GraphEdgeData }>();

  const addEdge = (kind: EdgeKind, source: string, target: string, label?: string): void => {
    if (source === target) return;
    const id = edgeKey(kind, source, target);
    if (edges.has(id)) return;
    const data: GraphEdgeData = { id, source, target, kind };
    if (label) data.label = label;
    edges.set(id, { data });
  };

  /** Column edge endpoint — every catalog column is a node (ERD rows). */
  const colNode = (relOid: number, attnum: number): string | null =>
    colByKey.has(`${relOid}:${attnum}`) ? colId(relOid, attnum) : null;

  // 1. Views → columns/tables they select from (exact, from pg_depend).
  const viewGroups = new Map<string, { viewOid: number; relOid: number; atts: Set<number> }>();
  for (const d of catalog.viewDeps) {
    if (!relByOid.has(d.viewOid) || !relByOid.has(d.relOid)) continue;
    const key = `${d.viewOid}:${d.relOid}`;
    let g = viewGroups.get(key);
    if (!g) viewGroups.set(key, (g = { viewOid: d.viewOid, relOid: d.relOid, atts: new Set() }));
    if (d.attnum > 0) g.atts.add(d.attnum);
  }
  for (const g of viewGroups.values()) {
    let hasCols = false;
    for (const att of g.atts) {
      const cid = colNode(g.relOid, att);
      if (cid) {
        addEdge("selects", relId(g.viewOid), cid);
        hasCols = true;
      }
    }
    // whole-table dependency only when no column detail exists (aggregation
    // synthesizes the card-level edge otherwise)
    if (!hasCols) addEdge("selects", relId(g.viewOid), relId(g.relOid));
  }

  // 2. Views → functions they call.
  for (const d of catalog.viewFuncDeps) {
    if (relByOid.has(d.viewOid) && fnByOid.has(d.funcOid)) {
      addEdge("calls", relId(d.viewOid), fnId(d.funcOid));
    }
  }

  // 3. Triggers: nested under their table; edge to the function they execute.
  for (const t of catalog.triggers) {
    if (!relByOid.has(t.relOid)) continue;
    if (fnByOid.has(t.funcOid)) addEdge("executes", trgId(t.oid), fnId(t.funcOid));
    for (const att of t.updateCols) {
      const cid = colNode(t.relOid, att);
      if (cid) addEdge("update-of", trgId(t.oid), cid);
    }
  }

  // 4. Function bodies → reads/writes/calls (parsed PL/pgSQL & SQL).
  const emitRefs = (
    funcOid: number,
    map: Map<number, Set<number>>,
    kind: "reads" | "inserts" | "updates" | "deletes" | "writes" | "modifies",
  ): void => {
    for (const [relOid, atts] of map) {
      if (!relByOid.has(relOid)) continue;
      let hasCols = false;
      for (const att of atts) {
        if (att <= 0) continue;
        const cid = colNode(relOid, att);
        if (cid) {
          addEdge(kind, fnId(funcOid), cid);
          hasCols = true;
        }
      }
      if (!hasCols) addEdge(kind, fnId(funcOid), relId(relOid));
    }
  };
  for (const [funcOid, refs] of analysis) {
    if (!fnByOid.has(funcOid)) continue;
    emitRefs(funcOid, refs.reads, "reads");
    emitRefs(funcOid, refs.inserts, "inserts");
    emitRefs(funcOid, refs.updates, "updates");
    emitRefs(funcOid, refs.deletes, "deletes");
    emitRefs(funcOid, refs.writes, "writes");
    emitRefs(funcOid, refs.modifies, "modifies");
    for (const callee of refs.calls) {
      if (fnByOid.has(callee)) addEdge("calls", fnId(funcOid), fnId(callee));
    }
  }

  // 5. BEGIN ATOMIC SQL functions: exact deps from pg_depend (direction unknown → 'reads').
  const bodyGroups = new Map<string, { funcOid: number; relOid: number; atts: Set<number> }>();
  for (const d of catalog.sqlBodyDeps) {
    const fn = fnByOid.get(d.funcOid);
    if (!fn || !fn.hasSqlBody || !relByOid.has(d.relOid)) continue;
    const key = `${d.funcOid}:${d.relOid}`;
    let g = bodyGroups.get(key);
    if (!g) bodyGroups.set(key, (g = { funcOid: d.funcOid, relOid: d.relOid, atts: new Set() }));
    if (d.attnum > 0) g.atts.add(d.attnum);
  }
  for (const g of bodyGroups.values()) {
    let hasCols = false;
    for (const att of g.atts) {
      const cid = colNode(g.relOid, att);
      if (cid) {
        addEdge("reads", fnId(g.funcOid), cid);
        hasCols = true;
      }
    }
    if (!hasCols) addEdge("reads", fnId(g.funcOid), relId(g.relOid));
  }

  // 6. Foreign keys (column → referenced column).
  const fkLabelHint = new Map<string, string>();
  if (opts.includeFks) {
    const fks = [...catalog.fks].sort(
      (a, b) =>
        a.relOid - b.relOid ||
        a.refRelOid - b.refRelOid ||
        cmp(a.name, b.name) ||
        cmpNums(a.cols, b.cols) ||
        cmpNums(a.refCols, b.refCols),
    );
    for (const fk of fks) {
      if (!relByOid.has(fk.relOid) || !relByOid.has(fk.refRelOid)) continue;
      let hasCols = false;
      for (let i = 0; i < fk.cols.length; i++) {
        const att = fk.cols[i];
        const refAtt = fk.refCols[i];
        if (att === undefined || refAtt === undefined) continue;
        const src = colNode(fk.relOid, att);
        const tgt = colNode(fk.refRelOid, refAtt);
        if (src && tgt) {
          addEdge("fk", src, tgt);
          hasCols = true;
        }
      }
      const pairKey = `${relId(fk.relOid)}|${relId(fk.refRelOid)}`;
      if (!fkLabelHint.has(pairKey)) fkLabelHint.set(pairKey, fk.name);
      if (!hasCols) addEdge("fk", relId(fk.relOid), relId(fk.refRelOid), fk.name);
    }
  }

  // 7. CHECK / PK / UNIQUE / EXCLUDE constraints → their columns; CHECKs → functions they call.
  const conByOid = new Map(catalog.constraints.map((c) => [c.oid, c]));
  for (const con of catalog.constraints) {
    if (!relByOid.has(con.relOid)) continue;
    for (const att of con.cols) {
      const cid = colNode(con.relOid, att);
      if (cid) addEdge("constrains", conId(con.oid), cid);
    }
  }
  for (const d of catalog.constraintFuncDeps) {
    const con = conByOid.get(d.conOid);
    if (con && relByOid.has(con.relOid) && fnByOid.has(d.funcOid)) {
      addEdge("calls", conId(d.conOid), fnId(d.funcOid));
    }
  }

  // 7b. Indexes → the key columns they cover (intra-card detail, like constrains).
  for (const ix of catalog.indexes) {
    if (!relByOid.has(ix.relOid)) continue;
    for (const att of ix.cols) {
      const cid = colNode(ix.relOid, att);
      if (cid) addEdge("indexes", idxId(ix.oid), cid);
    }
  }

  // 8. Column defaults / generated columns.
  for (const d of catalog.defaultDeps) {
    const src = relByOid.has(d.relOid) ? colNode(d.relOid, d.attnum) : null;
    if (!src) continue;
    if (d.refFuncOid !== null && fnByOid.has(d.refFuncOid)) {
      addEdge("default", src, fnId(d.refFuncOid));
    }
    if (d.refRelOid !== null && relByOid.has(d.refRelOid)) {
      const tgt =
        d.refAttnum !== null && d.refAttnum > 0
          ? colNode(d.refRelOid, d.refAttnum)
          : relId(d.refRelOid);
      if (tgt) addEdge("default", src, tgt);
    }
  }

  // ── Nodes ──
  const nodes: { data: GraphNodeData }[] = [];
  /** node id → its card id (rows map to their relation; cards/functions to themselves) */
  const unitOfId = new Map<string, string>();
  const edgeUnits = (edge: GraphEdgeData): [string, string] => [
    unitOfId.get(edge.source) ?? edge.source,
    unitOfId.get(edge.target) ?? edge.target,
  ];

  // schema compounds: tables/views/functions nest inside their schema
  const schemaId = (name: string): string => `s_${name}`;
  const schemas = new Set<string>([
    ...catalog.rels.map((r) => r.schema),
    ...catalog.funcs.map((f) => f.schema),
  ]);
  for (const name of schemas) {
    nodes.push({
      data: { id: schemaId(name), label: name, type: "schema", schema: name, oid: 0 },
    });
  }

  for (const r of catalog.rels) {
    unitOfId.set(relId(r.oid), relId(r.oid));
    nodes.push({
      data: {
        id: relId(r.oid),
        label: r.name,
        type: r.kind,
        parent: schemaId(r.schema),
        schemaParent: schemaId(r.schema),
        schema: r.schema,
        oid: r.oid,
        detail: `${r.schema}.${r.name}`,
      },
    });
  }
  for (const c of catalog.cols) {
    if (!relByOid.has(c.relOid)) continue;
    unitOfId.set(colId(c.relOid, c.attnum), relId(c.relOid));
    nodes.push({
      data: {
        id: colId(c.relOid, c.attnum),
        label: c.name,
        type: "column",
        parent: relId(c.relOid),
        schema: relByOid.get(c.relOid)?.schema,
        oid: c.relOid,
        detail: c.type,
        ord: c.attnum,
      },
    });
  }
  for (const t of catalog.triggers) {
    const rel = relByOid.get(t.relOid);
    if (!rel) continue;
    unitOfId.set(trgId(t.oid), relId(t.relOid));
    const timing = t.tgtype & 2 ? "BEFORE" : t.tgtype & 64 ? "INSTEAD OF" : "AFTER";
    const events = [
      t.tgtype & 4 ? "INSERT" : "",
      t.tgtype & 8 ? "DELETE" : "",
      t.tgtype & 16 ? "UPDATE" : "",
      t.tgtype & 32 ? "TRUNCATE" : "",
    ]
      .filter(Boolean)
      .join(" OR ");
    nodes.push({
      data: {
        id: trgId(t.oid),
        label: t.name,
        type: "trigger",
        parent: relId(t.relOid),
        schema: rel.schema,
        oid: t.oid,
        detail: `${timing} ${events} · ${t.tgtype & 1 ? "ROW" : "STATEMENT"}`,
        ord: 10_000,
      },
    });
  }
  for (const con of catalog.constraints) {
    const rel = relByOid.get(con.relOid);
    if (!rel) continue;
    unitOfId.set(conId(con.oid), relId(con.relOid));
    nodes.push({
      data: {
        id: conId(con.oid),
        label: con.name,
        type: "constraint",
        parent: relId(con.relOid),
        schema: rel.schema,
        oid: con.oid,
        detail: con.def ?? CONTYPE_LABEL[con.contype] ?? "constraint",
        ord: 20_000,
      },
    });
  }
  for (const ix of catalog.indexes) {
    const rel = relByOid.get(ix.relOid);
    if (!rel) continue;
    unitOfId.set(idxId(ix.oid), relId(ix.relOid));
    // "CREATE [UNIQUE] INDEX … USING btree (col)" → "[UNIQUE] btree (col)"
    const using = ix.def?.match(/USING\s+(.+)$/is)?.[1];
    const unique = /^CREATE\s+UNIQUE/i.test(ix.def ?? "") ? "UNIQUE " : "";
    nodes.push({
      data: {
        id: idxId(ix.oid),
        label: ix.name,
        type: "index",
        parent: relId(ix.relOid),
        schema: rel.schema,
        oid: ix.oid,
        detail: using ? `${unique}${using}` : "index",
        ord: 30_000,
      },
    });
  }
  for (const f of catalog.funcs) {
    unitOfId.set(fnId(f.oid), fnId(f.oid));
    nodes.push({
      data: {
        id: fnId(f.oid),
        label: routineLabel(f.name, f.args),
        type: "function",
        parent: schemaId(f.schema),
        schemaParent: schemaId(f.schema),
        schema: f.schema,
        oid: f.oid,
        detail: `${f.language} · returns ${f.returns}`,
      },
    });
  }

  // Drop any edge whose endpoint didn't materialize.
  const nodeIds = new Set(nodes.map((n) => n.data.id));
  const edgeList = [...edges.values()].filter(
    (e) => nodeIds.has(e.data.source) && nodeIds.has(e.data.target),
  );

  // ── Aggregation: roll row-level (detail) edges up to one card-level edge per
  // (kind, source card, target card) with a count, so the overview shows a few
  // hundred card edges instead of thousands of column edges.
  //
  // Invariants the webview relies on:
  //  - `detail: true` ⟺ at least one endpoint is a row (column/trigger/
  //    constraint); these are the edges hidden by default and materialized
  //    lazily.
  //  - intra-card pairs (constrains, update-of) never aggregate — containment
  //    already shows them.
  //  - if a REAL unit-level edge with the same (kind, src, tgt) exists (e.g. a
  //    whole-table read with no column info, or fn→fn calls), no aggregate is
  //    emitted: one pair, one card-level edge, never both. ──
  const unitLevelKeys = new Set<string>();
  for (const e of edgeList) {
    const [su, tu] = edgeUnits(e.data);
    if (su === e.data.source && tu === e.data.target) {
      unitLevelKeys.add(edgeKey(e.data.kind, su, tu));
    } else {
      e.data.detail = true;
    }
  }
  const aggCounts = new Map<string, number>();
  for (const e of edgeList) {
    if (!e.data.detail) continue;
    const [su, tu] = edgeUnits(e.data);
    if (su === tu) continue; // intra-card (constrains, update-of, …)
    const key = edgeKey(e.data.kind, su, tu);
    aggCounts.set(key, (aggCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of aggCounts) {
    if (unitLevelKeys.has(key)) continue; // a real card-level edge already covers the pair
    const [kind, source, target] = key.split("|") as [EdgeKind, string, string];
    const data: GraphEdgeData = { id: `agg|${key}`, source, target, kind, agg: true, count };
    const hint = kind === "fk" ? fkLabelHint.get(`${source}|${target}`) : undefined;
    const suffix = count > 1 ? `×${count}` : "";
    const label = [hint, suffix].filter(Boolean).join(" ");
    if (label) data.label = label;
    edgeList.push({ data });
  }

  const nodeTypeRank: Record<string, number> = {
    schema: 0,
    table: 1,
    view: 1,
    matview: 1,
    foreign: 1,
    column: 2,
    trigger: 3,
    constraint: 4,
    index: 5,
    function: 6,
  };
  nodes.sort((a, b) => {
    const ad = a.data;
    const bd = b.data;
    return (
      (nodeTypeRank[ad.type] ?? 99) - (nodeTypeRank[bd.type] ?? 99) ||
      cmp(ad.parent ?? "", bd.parent ?? "") ||
      (ad.ord ?? 0) - (bd.ord ?? 0) ||
      cmp(ad.schema ?? "", bd.schema ?? "") ||
      cmp(ad.label, bd.label) ||
      ad.oid - bd.oid ||
      cmp(ad.id, bd.id)
    );
  });
  edgeList.sort((a, b) => cmp(a.data.id, b.data.id));

  const detailCount = edgeList.filter((e) => e.data.detail).length;
  const stats: Record<string, number> = {
    edges: edgeList.length,
    cardEdges: edgeList.length - detailCount,
    detailEdges: detailCount,
  };
  for (const n of nodes) stats[n.data.type] = (stats[n.data.type] ?? 0) + 1;

  return { nodes, edges: edgeList, stats };
}
