import type { Snapshot, SnapshotObject } from "./snapshot";

function identifier(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : '"' + name.replaceAll('"', '""') + '"';
}

function routineName(name: string): string {
  // Only the identity argument suffix is SQL-formatted. The raw name can contain parentheses.
  if (!name.endsWith(")")) return identifier(name);
  let depth = 1;
  let quoted = false;
  for (let i = name.length - 2; i >= 0; i--) {
    if (name[i] === '"') quoted = !quoted;
    else if (!quoted && name[i] === ")") depth++;
    else if (!quoted && name[i] === "(") {
      depth--;
      if (depth === 0) return identifier(name.slice(0, i)) + name.slice(i);
    }
  }
  return identifier(name);
}

export function objectLabel(
  obj: SnapshotObject,
  objects: ReadonlyMap<string, SnapshotObject>,
  qualified: boolean,
): string {
  const parent =
    obj.parentId && (obj.kind === "trigger" || obj.kind === "constraint" || obj.kind === "policy")
      ? objects.get(obj.parentId)
      : undefined;
  const parts = qualified ? [identifier(parent?.schema ?? obj.schema)] : [];
  if (parent) parts.push(identifier(parent.name));
  parts.push(
    obj.kind === "function" || obj.kind === "procedure"
      ? routineName(obj.name)
      : identifier(obj.name),
  );
  return parts.join(".");
}

export function referenceLabel(
  id: string,
  objects: ReadonlyMap<string, SnapshotObject>,
  columns: ReadonlyMap<string, Snapshot["columns"][number]>,
): string {
  const col = columns.get(id);
  if (col) return referenceLabel(col.objectId, objects, columns) + "." + identifier(col.name);
  const obj = objects.get(id);
  return obj ? objectLabel(obj, objects, true) : id;
}
