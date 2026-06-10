import type { FuncRefs } from "./analyze";
import type { Catalog, EdgeKind, GraphEdgeData, GraphNodeData, GraphPayload } from "./types";

const relId = (oid: number): string => `r${oid}`;
const colId = (relOid: number, attnum: number): string => `c${relOid}_${attnum}`;
const fnId = (oid: number): string => `f${oid}`;
const trgId = (oid: number): string => `g${oid}`;
const conId = (oid: number): string => `k${oid}`;

const CONTYPE_LABEL: Record<string, string> = {
  c: "CHECK",
  p: "PRIMARY KEY",
  u: "UNIQUE",
  x: "EXCLUDE",
};

function triggerDesc(tgtype: number): string {
  const timing = tgtype & 2 ? "BEFORE" : tgtype & 64 ? "INSTEAD OF" : "AFTER";
  const events: string[] = [];
  if (tgtype & 4) events.push("INSERT");
  if (tgtype & 8) events.push("DELETE");
  if (tgtype & 16) events.push("UPDATE");
  if (tgtype & 32) events.push("TRUNCATE");
  return `${timing} ${events.join(" OR ")} · ${tgtype & 1 ? "ROW" : "STATEMENT"}`;
}

export function buildGraph(
  catalog: Catalog,
  analysis: Map<number, FuncRefs>,
  opts: { includeFks: boolean },
): GraphPayload {
  const relByOid = new Map(catalog.rels.map((r) => [r.oid, r]));
  const colByKey = new Map(catalog.cols.map((c) => [`${c.relOid}:${c.attnum}`, c]));
  const fnByOid = new Map(catalog.funcs.map((f) => [f.oid, f]));

  const usedCols = new Set<string>();
  const edges = new Map<string, { data: GraphEdgeData }>();

  const addEdge = (
    kind: EdgeKind,
    source: string,
    target: string,
    label?: string,
    dup?: boolean,
  ): void => {
    if (source === target) return;
    const id = `${kind}|${source}|${target}`;
    const existing = edges.get(id);
    if (existing) {
      // a real (non-dup) edge wins over a dup marker
      if (!dup) delete existing.data.dup;
      return;
    }
    const data: GraphEdgeData = { id, source, target, kind };
    if (label) data.label = label;
    if (dup) data.dup = true;
    edges.set(id, { data });
  };

  /** Register a column node (only referenced columns become nodes) and return its id. */
  const colNode = (relOid: number, attnum: number): string | null => {
    const key = `${relOid}:${attnum}`;
    if (!colByKey.has(key)) return null;
    usedCols.add(key);
    return colId(relOid, attnum);
  };

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
    addEdge("selects", relId(g.viewOid), relId(g.relOid), undefined, hasCols);
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
    kind: "reads" | "writes",
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
      addEdge(kind, fnId(funcOid), relId(relOid), undefined, hasCols);
    }
  };
  for (const [funcOid, refs] of analysis) {
    if (!fnByOid.has(funcOid)) continue;
    emitRefs(funcOid, refs.reads, "reads");
    emitRefs(funcOid, refs.writes, "writes");
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
    addEdge("reads", fnId(g.funcOid), relId(g.relOid), undefined, hasCols);
  }

  // 6. Foreign keys (column → referenced column).
  if (opts.includeFks) {
    for (const fk of catalog.fks) {
      if (!relByOid.has(fk.relOid) || !relByOid.has(fk.refRelOid)) continue;
      let hasCols = false;
      for (let i = 0; i < fk.cols.length; i++) {
        const att = fk.cols[i];
        const refAtt = fk.refCols[i] ?? fk.refCols[0];
        if (att === undefined || refAtt === undefined) continue;
        const src = colNode(fk.relOid, att);
        const tgt = colNode(fk.refRelOid, refAtt);
        if (src && tgt) {
          addEdge("fk", src, tgt);
          hasCols = true;
        }
      }
      addEdge("fk", relId(fk.relOid), relId(fk.refRelOid), fk.name, hasCols);
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
  for (const r of catalog.rels) {
    nodes.push({
      data: {
        id: relId(r.oid),
        label: r.name,
        type: r.kind,
        schema: r.schema,
        oid: r.oid,
        detail: `${r.schema}.${r.name}`,
      },
    });
  }
  for (const key of usedCols) {
    const c = colByKey.get(key)!;
    nodes.push({
      data: {
        id: colId(c.relOid, c.attnum),
        label: c.name,
        type: "column",
        parent: relId(c.relOid),
        schema: relByOid.get(c.relOid)?.schema,
        oid: c.relOid,
        detail: c.type,
      },
    });
  }
  for (const t of catalog.triggers) {
    const rel = relByOid.get(t.relOid);
    if (!rel) continue;
    nodes.push({
      data: {
        id: trgId(t.oid),
        label: t.name,
        type: "trigger",
        parent: relId(t.relOid),
        schema: rel.schema,
        oid: t.oid,
        detail: triggerDesc(t.tgtype),
      },
    });
  }
  for (const con of catalog.constraints) {
    const rel = relByOid.get(con.relOid);
    if (!rel) continue;
    nodes.push({
      data: {
        id: conId(con.oid),
        label: con.name,
        type: "constraint",
        parent: relId(con.relOid),
        schema: rel.schema,
        oid: con.oid,
        detail: con.def ?? CONTYPE_LABEL[con.contype] ?? "constraint",
      },
    });
  }
  for (const f of catalog.funcs) {
    nodes.push({
      data: {
        id: fnId(f.oid),
        label: `${f.name}()`,
        type: "function",
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

  const stats: Record<string, number> = { edges: edgeList.length };
  for (const n of nodes) stats[n.data.type] = (stats[n.data.type] ?? 0) + 1;

  return { nodes, edges: edgeList, stats };
}
