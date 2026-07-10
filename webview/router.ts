export interface RoutingBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
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
