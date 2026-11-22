import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";

// Resolve every file-local identifier, including constraint and evidence
// owners. Preserve multiplicity, argument signatures, provenance and offsets.
function semantic(s) {
  const owners = new Map(s.objects.map(o => [o.id,o]));
  const names = new Map();
  for(const o of s.objects) names.set(o.id,JSON.stringify([o.schema,o.kind,o.parentId ? owners.get(o.parentId).name : null,o.name]));
  for(const c of s.columns) names.set(c.id,JSON.stringify([names.get(c.objectId),c.name]));
  const name=id=> { if(!names.has(id)) throw Error("Unknown snapshot endpoint "+id); return names.get(id); };
  const edges=new Map(s.relationships.map(e=>[e.id,[name(e.source),e.kind,name(e.target),e.constraintId?name(e.constraintId):null,e.position??null,e.provenance]]));
  const sorted=rows=>rows.map(r=>JSON.stringify(r)).sort();
  return {
    schemaFilters: s.schemas,
    objects:sorted(s.objects.map(o=>[name(o.id),o.detail??null])),
    columns:sorted(s.columns.map(c=>[name(c.id),c.position,c.type])),
    definitions:sorted(s.definitions.map(d=>[name(d.ownerId),d.sql])),
    relationships:sorted([...edges.values()]),
    evidence:sorted(s.evidence.map(e=>[edges.get(e.relationshipId),name(e.ownerId),e.provenance,e.snippet,e.start??null,e.end??null])),
    warnings:[...s.diagnostics.warnings].sort(),
    unresolved:sorted(s.diagnostics.unresolved.map(d=>[name(d.ownerId),d.reason,d.identifier,d.snippet,(d.candidateIds??[]).map(name).sort()])),
  };
}
export function compare(before,after) {
  assert.deepEqual(semantic(after),semantic(before));
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [a,b]=process.argv.slice(2).map(f=>JSON.parse(readFileSync(f,"utf8")));
  compare(a,b);
  console.log("Matched objects, columns, definitions, relationships, evidence and diagnostics");
}
