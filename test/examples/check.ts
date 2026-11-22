import assert from "node:assert/strict";
import { SnapshotIndex } from "../../viewer/snapshot-index";
import type { Snapshot } from "../../viewer/snapshot";

export const examples = ["simple", "commerce", "routines"] as const;

export function checkExample(name: (typeof examples)[number], snapshot: Snapshot) {
  const index = new SnapshotIndex(snapshot);
  function object(schema: string, name: string) {
    const matches = snapshot.objects.filter((o) => o.schema === schema && o.name === name);
    assert.equal(matches.length, 1, `expected one ${schema}.${name}`);
    return matches[0]!.id;
  }
  function column(schema: string, relation: string, name: string) {
    const result = index.findColumn(schema, relation, name);
    assert.ok(result, `missing ${schema}.${relation}.${name}`);
    return result.id;
  }
  if (name === "routines") {
    const procedure = snapshot.objects.find(
      (o) => o.kind === "procedure" && o.name.startsWith("post_deltas("),
    );
    const callee = snapshot.objects.find(
      (o) => o.kind === "function" && o.name.startsWith("account_deltas("),
    );
    assert.ok(procedure && callee, "expected both routine identities");
    const paths = index.neighborhood(column("ledger", "entries", "account_id"), "incoming", 2);
    assert.ok(
      paths.some(([read, call]) => read?.source === callee.id && call?.source === procedure.id),
      "aliased column must trace through the SQL function to the PL/pgSQL caller",
    );
    assert.ok(
      snapshot.relationships.some(
        (e) =>
          e.source === procedure.id &&
          e.kind === "inserts" &&
          e.target === column("ledger", "journal", "previous_balance"),
      ),
      "constant EXECUTE target",
    );
    assert.equal(
      index.columnReferences(column("ledger", "pending", "delta")).length,
      0,
      "local record is unrelated to the table with the same name",
    );
    assert.deepEqual(
      snapshot.diagnostics.unresolved.map((d) => [d.ownerId, d.identifier]),
      [[procedure.id, "EXECUTE"]],
    );
    return;
  }
  const simple = name === "simple";
  const schema = simple ? "ledger" : "billing";
  const total = column(schema, "invoices", "total");
  const routine = object(
    schema,
    simple ? "invoice_total(bigint)" : "invoice_total(bigint, bigint)",
  );
  const view = simple ? object(schema, "invoice_summary") : object("reporting", "open_invoices");
  const path = index
    .neighborhood(total, "incoming", 2)
    .find(
      ([first, second]) =>
        first?.source === routine && second?.source === view && second.target === routine,
    );
  assert.ok(path, "invoice column -> function -> view");
  assert.deepEqual(
    path.map((e) => e.kind),
    ["reads", "calls"],
  );
  for (const edge of path) {
    const evidence = snapshot.evidence.find((e) => e.relationshipId === edge.id);
    assert.ok(evidence, "missing SQL evidence for " + edge.id);
    const def = snapshot.definitions.find((d) => d.ownerId === evidence.ownerId);
    assert.match(def?.sql ?? "", edge.source === routine ? /i\.total/ : /invoice_total\(/);
  }
  assert.deepEqual(
    index.columnReferences(column(schema, "invoices", simple ? "private_note" : "Internal.Note")),
    [],
  );
  if (simple) {
    assert.equal(snapshot.columns.length, 4);
    assert.equal(snapshot.objects.length, 4);
    assert.deepEqual(snapshot.diagnostics.unresolved, []);
    return;
  }
  const tables = snapshot.objects.filter((o) => o.kind === "table");
  assert.equal(new Set(tables.map((o) => o.schema)).size, 10);
  assert.equal(tables.length, 50);
  const fk = snapshot.relationships.filter(
    (e) => e.kind === "fk" && e.source === column("billing", "invoices", "order_id"),
  );
  assert.equal(fk.length, 1);
  assert.deepEqual(
    snapshot.relationships
      .filter((e) => e.constraintId === fk[0]!.constraintId)
      .sort((a, b) => a.position! - b.position!)
      .map((e) => [e.source, e.target]),
    [
      [column("billing", "invoices", "tenant_id"), column("sales", "orders", "tenant_id")],
      [column("billing", "invoices", "order_id"), column("sales", "orders", "id")],
    ],
  );
  const net = object("billing", "net(numeric)");
  const closeRun = object("reporting", "close_run(IN bigint)");
  assert.ok(
    snapshot.relationships.some(
      (e) =>
        e.source === closeRun &&
        e.kind === "inserts" &&
        e.target === column("reporting", "checkpoints", "run_id"),
    ),
    "Procedure writes its checkpoint column",
  );
  assert.equal(
    snapshot.objects.find((o) => o.id === closeRun)?.kind,
    "procedure",
    "Procedures must retain their PostgreSQL object type",
  );
  const indexId = object("billing", "invoice_open_amount");
  const targets = (source: string, kind: string) =>
    snapshot.relationships
      .filter((e) => e.source === source && e.kind === kind)
      .map((e) => e.target)
      .sort();
  assert.deepEqual(
    targets(routine, "calls"),
    [net],
    "SQL-standard routine must call only the numeric overload",
  );
  assert.deepEqual(
    targets(indexId, "calls"),
    [net],
    "expression index must call only the numeric overload",
  );
  assert.deepEqual(
    targets(indexId, "reads"),
    [total, column("billing", "invoices", "paid")].sort(),
    "index expression and predicate must retain both column dependencies",
  );
  const indexCall = snapshot.relationships.find((e) => e.source === indexId && e.target === net)!;
  const indexProof = snapshot.evidence.find((e) => e.relationshipId === indexCall.id);
  assert.equal(indexProof?.ownerId, indexId);
  assert.match(
    snapshot.definitions.find((d) => d.ownerId === indexId)?.sql ?? "",
    /WHERE.*paid.*total/i,
  );
  assert.deepEqual(targets(object("billing", "credit_added"), "executes"), [
    object("reporting", "record_credit()"),
  ]);
  const triggerFunction = object("reporting", "record_credit()");
  assert.ok(
    snapshot.relationships.some(
      (e) =>
        e.source === triggerFunction &&
        e.kind === "inserts" &&
        e.target === column("reporting", "adjustments", "credit_id") &&
        e.provenance === "parsed",
    ),
  );
  assert.ok(targets(triggerFunction, "reads").includes(column("billing", "credits", "id")));
  assert.deepEqual(
    snapshot.diagnostics.unresolved,
    [],
    "RETURN NEW is a trigger record, not an unresolved column",
  );
  assert.ok(
    targets(object("reporting", "receivables"), "selects").includes(
      column("reporting", "open_invoices", "amount"),
    ),
  );
}
