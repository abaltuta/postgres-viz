import type { ColumnUsageGroup, UsageOwner } from "../src/protocol";

export type UsageCategory = "reads" | "writes" | "structural";

export interface UsageMatrixRow {
  owner: UsageOwner;
  groups: ColumnUsageGroup[];
  counts: Record<UsageCategory, number>;
  total: number;
  primary: UsageCategory;
  qualifiedName: string;
}

export interface RadialPlan {
  capacity: number;
  visible: Record<UsageCategory, UsageMatrixRow[]>;
  hidden: Record<UsageCategory, number>;
}

export interface RadialItem {
  id: string;
  category: UsageCategory;
  width: number;
  height: number;
}

const CATEGORIES: readonly UsageCategory[] = ["reads", "writes", "structural"];
const PRIMARY_PRIORITY: readonly UsageCategory[] = ["writes", "reads", "structural"];

export function usageCategory(kind: ColumnUsageGroup["kind"]): UsageCategory {
  if (kind === "reads" || kind === "selects") return "reads";
  if (
    kind === "inserts" ||
    kind === "updates" ||
    kind === "deletes" ||
    kind === "writes" ||
    kind === "modifies"
  ) {
    return "writes";
  }
  return "structural";
}

export function aggregateUsageRows(groups: readonly ColumnUsageGroup[]): UsageMatrixRow[] {
  const rows = new Map<string, UsageMatrixRow>();
  for (const group of groups) {
    let row = rows.get(group.owner.id);
    if (!row) {
      const qualifiedName = [
        group.owner.schema,
        group.owner.owner,
        group.owner.label ?? group.owner.name,
      ]
        .filter(Boolean)
        .join(".");
      row = {
        owner: group.owner,
        groups: [],
        counts: { reads: 0, writes: 0, structural: 0 },
        total: 0,
        primary: "structural",
        qualifiedName,
      };
      rows.set(group.owner.id, row);
    }
    const category = usageCategory(group.kind);
    row.groups.push(group);
    row.counts[category] += group.count;
    row.total += group.count;
  }
  for (const row of rows.values()) {
    row.primary = [...PRIMARY_PRIORITY].sort(
      (a, b) =>
        row.counts[b] - row.counts[a] || PRIMARY_PRIORITY.indexOf(a) - PRIMARY_PRIORITY.indexOf(b),
    )[0]!;
  }
  return [...rows.values()].sort(
    (a, b) => b.total - a.total || a.qualifiedName.localeCompare(b.qualifiedName),
  );
}

export function buildRadialPlan(
  rows: readonly UsageMatrixRow[],
  canvasWidth: number,
  canvasHeight: number,
): RadialPlan {
  const capacity = Math.max(
    9,
    Math.min(18, Math.floor((Math.max(1, canvasWidth) * Math.max(1, canvasHeight)) / 45_000)),
  );
  const pending: Record<UsageCategory, UsageMatrixRow[]> = {
    reads: rows.filter((row) => row.primary === "reads"),
    writes: rows.filter((row) => row.primary === "writes"),
    structural: rows.filter((row) => row.primary === "structural"),
  };
  const visible: Record<UsageCategory, UsageMatrixRow[]> = {
    reads: [],
    writes: [],
    structural: [],
  };
  let added = 0;
  while (added < capacity && CATEGORIES.some((category) => pending[category].length > 0)) {
    for (const category of CATEGORIES) {
      const row = pending[category].shift();
      if (!row) continue;
      visible[category].push(row);
      added++;
      if (added === capacity) break;
    }
  }
  return {
    capacity,
    visible,
    hidden: {
      reads: pending.reads.length,
      writes: pending.writes.length,
      structural: pending.structural.length,
    },
  };
}

export function radialPositions(
  items: readonly RadialItem[],
  centerWidth: number,
  centerHeight: number,
): Map<string, { x: number; y: number }> {
  const sectors: Record<UsageCategory, [number, number]> = {
    reads: [(120 * Math.PI) / 180, (240 * Math.PI) / 180],
    writes: [(-60 * Math.PI) / 180, (60 * Math.PI) / 180],
    structural: [(60 * Math.PI) / 180, (120 * Math.PI) / 180],
  };
  const maxDiagonal = Math.max(90, ...items.map((item) => Math.hypot(item.width, item.height)));
  const baseRadius = Math.max(centerWidth, centerHeight) / 2 + maxDiagonal / 2 + 48;
  const positions = new Map<string, { x: number; y: number }>();
  for (const category of CATEGORIES) {
    const categoryItems = items.filter((item) => item.category === category);
    const [start, end] = sectors[category];
    const span = end - start;
    let index = 0;
    let ring = 0;
    while (index < categoryItems.length) {
      const radius = baseRadius + ring * (maxDiagonal + 48);
      const capacity = Math.max(1, Math.min(6, Math.floor((span * radius) / (maxDiagonal + 40))));
      const ringItems = categoryItems.slice(index, index + capacity);
      const angularPadding = Math.min(span / 4, (maxDiagonal / 2 + 20) / radius);
      const paddedStart = start + angularPadding;
      const paddedEnd = end - angularPadding;
      ringItems.forEach((item, slot) => {
        const angle =
          ringItems.length === 1
            ? (start + end) / 2
            : paddedStart + ((paddedEnd - paddedStart) * slot) / (ringItems.length - 1);
        positions.set(item.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
      });
      index += ringItems.length;
      ring++;
    }
  }
  return positions;
}
