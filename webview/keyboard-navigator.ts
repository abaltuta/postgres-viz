import type { Core, NodeSingular } from "cytoscape";

const NAVIGATION_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

export interface KeyboardSurface {
  addEventListener(
    type: string,
    listener: (event: { key: string; preventDefault(): void }) => void,
  ): void;
  setAttribute(name: string, value: string): void;
}

export interface GraphKeyboardNavigatorOptions {
  surface: KeyboardSurface;
  graph: () => Core | null;
  units: () => NodeSingular[];
  onFocus: (node: NodeSingular) => void;
  onOpen: (node: NodeSingular) => void;
}

export class GraphKeyboardNavigator {
  private nodeId = "";

  constructor(options: GraphKeyboardNavigatorOptions) {
    options.surface.addEventListener("keydown", (event) => {
      const graph = options.graph();
      if (!graph) return;
      if (event.key === "Enter") {
        const node = graph.getElementById(this.nodeId);
        if (node.nonempty()) options.onOpen(node as unknown as NodeSingular);
        return;
      }
      if (!NAVIGATION_KEYS.has(event.key)) return;
      const units = options
        .units()
        .sort((a, b) =>
          `${a.data("schema") ?? ""}.${a.data("label")}`.localeCompare(
            `${b.data("schema") ?? ""}.${b.data("label")}`,
          ),
        );
      if (units.length === 0) return;
      const current = units.findIndex((unit) => unit.id() === this.nodeId);
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? units.length - 1
            : current < 0
              ? forward
                ? 0
                : units.length - 1
              : (current + (forward ? 1 : -1) + units.length) % units.length;
      const next = units[nextIndex]!;
      this.nodeId = next.id();
      options.onFocus(next);
      const schema = String(next.data("schema") ?? "");
      const qualified = schema ? `${schema}.${next.data("label")}` : String(next.data("label"));
      options.surface.setAttribute(
        "aria-label",
        `Database graph. ${qualified}, ${next.data("type")}. Press Enter to open details.`,
      );
      event.preventDefault();
    });
  }
}
