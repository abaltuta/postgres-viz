export interface RoutingBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface RankedCandidate<T> {
  value: T;
  distance: number;
}

const MAX_BUS_LANES = 32;
const BUS_LANE_GAP = 9;

class BoundedCandidateHeap<T> {
  private readonly heap: RankedCandidate<T>[] = [];

  constructor(private readonly limit: number) {}

  add(value: T, distance: number): void {
    if (this.limit <= 0) return;
    const candidate = { value, distance };
    if (this.heap.length < this.limit) {
      this.heap.push(candidate);
      let index = this.heap.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (this.heap[parent]!.distance >= this.heap[index]!.distance) break;
        [this.heap[parent], this.heap[index]] = [this.heap[index]!, this.heap[parent]!];
        index = parent;
      }
      return;
    }
    if (distance >= this.heap[0]!.distance) return;
    this.heap[0] = candidate;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let largest = index;
      if (left < this.heap.length && this.heap[left]!.distance > this.heap[largest]!.distance) {
        largest = left;
      }
      if (right < this.heap.length && this.heap[right]!.distance > this.heap[largest]!.distance) {
        largest = right;
      }
      if (largest === index) break;
      [this.heap[index], this.heap[largest]] = [this.heap[largest]!, this.heap[index]!];
      index = largest;
    }
  }

  sorted(): T[] {
    return [...this.heap]
      .sort((a, b) => a.distance - b.distance)
      .map((candidate) => candidate.value);
  }
}

export class RoutingCandidateSet<T> {
  private readonly groups: BoundedCandidateHeap<T>[];
  private total = 0;

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new Error("routing limit must be non-negative");
    this.groups = Array.from({ length: 3 }, () => new BoundedCandidateHeap<T>(limit));
  }

  add(value: T, priority: 0 | 1 | 2, distance: number): void {
    this.total++;
    this.groups[priority]!.add(value, Number.isFinite(distance) ? distance : Number.MAX_VALUE);
  }

  selected(): T[] {
    return this.groups.flatMap((group) => group.sorted()).slice(0, this.limit);
  }

  get omitted(): number {
    return Math.max(0, this.total - this.limit);
  }
}

export class ObstacleIndex {
  private readonly boxes = new Map<string, RoutingBox>();
  private readonly grid = new Map<string, { id: string; box: RoutingBox }[]>();
  readonly busX: number;

  constructor(
    entries: { id: string; box: RoutingBox }[],
    private readonly cellSize = 320,
  ) {
    this.busX = Math.min(...entries.map((entry) => entry.box.x1)) - 60;
    for (const entry of entries) {
      this.boxes.set(entry.id, entry.box);
      for (
        let x = Math.floor(entry.box.x1 / cellSize);
        x <= Math.floor(entry.box.x2 / cellSize);
        x++
      ) {
        for (
          let y = Math.floor(entry.box.y1 / cellSize);
          y <= Math.floor(entry.box.y2 / cellSize);
          y++
        ) {
          const key = `${x}:${y}`;
          const cell = this.grid.get(key);
          if (cell) cell.push(entry);
          else this.grid.set(key, [entry]);
        }
      }
    }
  }

  box(id: string): RoutingBox | undefined {
    return this.boxes.get(id);
  }

  intersects(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    sourceId: string,
    targetId: string,
  ): boolean {
    const candidates = new Map<string, RoutingBox>();
    for (
      let x = Math.floor(Math.min(ax, bx) / this.cellSize);
      x <= Math.floor(Math.max(ax, bx) / this.cellSize);
      x++
    ) {
      for (
        let y = Math.floor(Math.min(ay, by) / this.cellSize);
        y <= Math.floor(Math.max(ay, by) / this.cellSize);
        y++
      ) {
        for (const candidate of this.grid.get(`${x}:${y}`) ?? []) {
          if (candidate.id !== sourceId && candidate.id !== targetId) {
            candidates.set(candidate.id, candidate.box);
          }
        }
      }
    }
    for (const box of candidates.values()) {
      let t0 = 0;
      let t1 = 1;
      const dx = bx - ax;
      const dy = by - ay;
      for (const [p, q] of [
        [-dx, ax - box.x1],
        [dx, box.x2 - ax],
        [-dy, ay - box.y1],
        [dy, box.y2 - ay],
      ] as const) {
        if (p === 0) {
          if (q < 0) {
            t0 = 1;
            t1 = 0;
            break;
          }
          continue;
        }
        const t = q / p;
        if (p < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
      }
      if (t0 <= t1) return true;
    }
    return false;
  }
}

export interface RoutingPoint {
  x: number;
  y: number;
}

export interface PlannedRoute<T> {
  value: T;
  source: RoutingPoint;
  target: RoutingPoint;
  waypoints: RoutingPoint[];
}

export class EdgeRoutingPlanner<T> {
  private readonly index: ObstacleIndex;
  private readonly candidates: RoutingCandidateSet<PlannedRoute<T>>;

  constructor(entries: { id: string; box: RoutingBox }[], limit: number) {
    this.index = new ObstacleIndex(entries);
    this.candidates = new RoutingCandidateSet(limit);
  }

  add(
    value: T,
    sourceUnit: string,
    targetUnit: string,
    source: RoutingPoint,
    target: RoutingPoint,
    priority: 0 | 1 | 2,
    distance: number,
  ): void {
    if (sourceUnit === targetUnit) return;
    if (!this.index.intersects(source.x, source.y, target.x, target.y, sourceUnit, targetUnit)) {
      return;
    }
    const sourceBox = this.index.box(sourceUnit);
    const targetBox = this.index.box(targetUnit);
    const down = target.y >= source.y;
    const outY = down ? (sourceBox?.y2 ?? source.y) + 6 : (sourceBox?.y1 ?? source.y) - 6;
    const inY = down ? (targetBox?.y1 ?? target.y) - 6 : (targetBox?.y2 ?? target.y) + 6;
    this.candidates.add(
      {
        value,
        source,
        target,
        waypoints: [
          { x: source.x, y: outY },
          { x: this.index.busX, y: outY },
          { x: this.index.busX, y: inY },
          { x: target.x, y: inY },
        ],
      },
      priority,
      distance,
    );
  }

  result(): { routes: PlannedRoute<T>[]; omitted: number } {
    const routes = this.candidates.selected();
    const laneEnds: number[] = [];
    const separated = routes.map((route) => {
      const outY = route.waypoints[0]!.y;
      const inY = route.waypoints[3]!.y;
      const start = Math.min(outY, inY);
      const end = Math.max(outY, inY);
      let lane = laneEnds.findIndex((laneEnd) => laneEnd + BUS_LANE_GAP <= start);
      if (lane < 0) {
        lane =
          laneEnds.length < MAX_BUS_LANES
            ? laneEnds.length
            : laneEnds.reduce(
                (best, laneEnd, index) => (laneEnd < laneEnds[best]! ? index : best),
                0,
              );
      }
      laneEnds[lane] = end;
      const busX = this.index.busX - lane * BUS_LANE_GAP;
      return {
        ...route,
        waypoints: [
          route.waypoints[0]!,
          { x: busX, y: outY },
          { x: busX, y: inY },
          route.waypoints[3]!,
        ],
      };
    });
    return { routes: separated, omitted: this.candidates.omitted };
  }
}
