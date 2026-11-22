import type { Relationship, Snapshot, SnapshotColumn, SnapshotObject } from "./snapshot";

export class SnapshotIndex {
  private objects = new Set<string>();
  private owners = new Map<string, string>();
  private incoming = new Map<string, Relationship[]>();
  private outgoing = new Map<string, Relationship[]>();
  constructor(private snapshot: Snapshot) {
    for (const o of snapshot.objects) {
      this.objects.add(o.id);
      this.owners.set(o.id, o.parentId ?? o.id);
    }
    for (const c of snapshot.columns) this.owners.set(c.id, c.objectId);
    for (const edge of snapshot.relationships) {
      for (const [index, id] of [
        [this.incoming, edge.target],
        [this.outgoing, edge.source],
      ] as const) {
        const group = index.get(id);
        if (group) group.push(edge);
        else index.set(id, [edge]);
      }
    }
  }
  owner(id: string): string {
    return this.owners.get(id) ?? id;
  }
  inventory(schema?: string): SnapshotObject[] {
    return this.snapshot.objects.filter((o) => schema === undefined || o.schema === schema);
  }
  findColumn(schema: string, objectName: string, columnName: string): SnapshotColumn | undefined {
    const object = this.snapshot.objects.find(
      (o) =>
        o.schema === schema &&
        o.name === objectName &&
        ["table", "view", "matview", "foreign"].includes(o.kind),
    );
    return this.snapshot.columns.find((c) => c.objectId === object?.id && c.name === columnName);
  }
  objectPairs({ groupNested = true } = {}) {
    const pairs = new Map<
      string,
      { source: string; target: string; relationships: Relationship[] }
    >();
    for (const edge of this.snapshot.relationships) {
      const source =
          !groupNested && this.objects.has(edge.source) ? edge.source : this.owner(edge.source),
        target =
          !groupNested && this.objects.has(edge.target) ? edge.target : this.owner(edge.target);
      if (source === target) continue;
      const key = JSON.stringify([source, target]);
      const pair = pairs.get(key);
      if (pair) pair.relationships.push(edge);
      else pairs.set(key, { source, target, relationships: [edge] });
    }
    return [...pairs.values()];
  }
  columnReferences(id: string): Relationship[] {
    return [...new Set([...(this.incoming.get(id) ?? []), ...(this.outgoing.get(id) ?? [])])];
  }
  neighborhood(id: string, direction: "incoming" | "outgoing", depth: 1 | 2): Relationship[][] {
    const index = direction === "incoming" ? this.incoming : this.outgoing;
    const next = direction === "incoming" ? "source" : "target";
    const paths: Relationship[][] = [];
    for (const first of index.get(id) ?? []) {
      paths.push([first]);
      if (depth === 2 && first[next] !== id)
        for (const second of index.get(first[next]) ?? []) {
          if (second[next] !== id && second[next] !== first[next]) paths.push([first, second]);
        }
    }
    return paths;
  }
}
