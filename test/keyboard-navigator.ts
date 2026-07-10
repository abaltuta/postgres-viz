import assert from "node:assert/strict";
import cytoscape, { type NodeSingular } from "cytoscape";
import { GraphKeyboardNavigator, type KeyboardSurface } from "../webview/keyboard-navigator";

class FakeSurface implements KeyboardSurface {
  readonly attributes = new Map<string, string>();
  private listener: ((event: { key: string; preventDefault(): void }) => void) | undefined;

  addEventListener(
    type: string,
    listener: (event: { key: string; preventDefault(): void }) => void,
  ): void {
    if (type === "keydown") this.listener = listener;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  press(key: string): boolean {
    let prevented = false;
    this.listener?.({
      key,
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  }
}

async function main(): Promise<void> {
  const graph = cytoscape({
    headless: true,
    elements: {
      nodes: [
        { data: { id: "z", label: "Zebra", type: "table", schema: "public" } },
        { data: { id: "a", label: "Alpha", type: "view", schema: "public" } },
        { data: { id: "b", label: "Beta", type: "function" } },
      ],
      edges: [],
    },
  });
  const surface = new FakeSurface();
  const focused: string[] = [];
  const opened: string[] = [];
  new GraphKeyboardNavigator({
    surface,
    graph: () => graph,
    units: () => graph.nodes().toArray() as NodeSingular[],
    onFocus: (node) => focused.push(node.id()),
    onOpen: (node) => opened.push(node.id()),
  });

  assert.equal(surface.press("ArrowRight"), true);
  assert.deepEqual(focused, ["b"], "navigation starts at the first sorted object");
  assert.match(surface.attributes.get("aria-label") ?? "", /Beta, function/);
  surface.press("ArrowLeft");
  assert.deepEqual(focused, ["b", "z"], "backward navigation wraps");
  surface.press("Home");
  surface.press("Enter");
  assert.deepEqual(opened, ["b"], "Enter opens the keyboard-focused object");
  assert.equal(surface.press("x"), false, "unrelated keys are ignored");

  console.log("keyboard-navigator OK - sorted navigation, wrapping, labels, and activation");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
