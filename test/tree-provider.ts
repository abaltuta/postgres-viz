import assert from "node:assert/strict";
import Module from "node:module";
import type { TreeNode } from "../src/tree-provider";
import type { GraphPayload } from "../src/types";

type LoadModule = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
};

class ThemeIcon {
  constructor(readonly id: string) {}
}

interface Command {
  title: string;
  command: string;
  arguments?: unknown[];
}

class TreeItem {
  id?: string;
  description?: string;
  contextValue?: string;
  iconPath?: ThemeIcon;
  command?: Command;

  constructor(
    readonly label: string,
    readonly collapsibleState: number,
  ) {}
}

class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  private disposed = false;

  readonly event = (listener: (value: T) => void): { dispose(): void } => {
    if (!this.disposed) this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener),
    };
  };

  fire(value: T): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener(value);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

const fakeVscode = { EventEmitter, ThemeIcon, TreeItem, TreeItemCollapsibleState };
const moduleWithLoad = Module as unknown as { _load: LoadModule };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function load(this: unknown, request, parent, isMain) {
  if (request === "vscode") return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};

const graph: GraphPayload = {
  nodes: [
    { data: { id: "schema:public", label: "public", type: "schema", oid: 0 } },
    {
      data: {
        id: "table:public.orders",
        label: "orders",
        type: "table",
        schema: "public",
        oid: 1,
      },
    },
    {
      data: {
        id: "column:public.orders.id",
        label: "id",
        type: "column",
        parent: "table:public.orders",
        schema: "public",
        detail: "integer",
        oid: 1,
      },
    },
  ],
  edges: [],
  stats: {},
};

async function main(): Promise<void> {
  const { DbTreeProvider } = await import("../src/tree-provider");
  const provider = new DbTreeProvider();
  let refreshes = 0;
  const subscription = provider.onDidChangeTreeData(() => {
    refreshes += 1;
  });

  provider.setGraph(graph);
  assert.equal(refreshes, 1, "setGraph refreshes the tree");

  const schema = provider.getChildren()[0];
  assert.equal(schema?.label, "public");
  assert.equal(provider.getTreeItem(schema).collapsibleState, TreeItemCollapsibleState.Collapsed);

  const table = provider.find("table:public.orders");
  assert.ok(table, "table node is indexed by graph id");
  const tableItem = provider.getTreeItem(table);
  assert.equal(tableItem.contextValue, "table");
  assert.equal((tableItem.iconPath as { id?: string } | undefined)?.id, "symbol-structure");
  assert.equal(tableItem.command?.command, "postgresViz.revealNode");
  assert.deepEqual(tableItem.command?.arguments, ["table:public.orders"]);
  assert.equal(provider.getParent(table)?.label, "tables");

  provider.setGraph(null);
  assert.equal(refreshes, 2, "clearing the graph refreshes the tree");
  assert.deepEqual(provider.getChildren(table), [], "stale nodes expose no children");
  const staleItem = provider.getTreeItem(table);
  assert.equal(staleItem.collapsibleState, TreeItemCollapsibleState.None);
  assert.equal(staleItem.contextValue, undefined);
  assert.equal(staleItem.iconPath, undefined);
  assert.equal(staleItem.command, undefined);
  assert.equal(provider.getParent(table), undefined);

  const malformed = {
    id: "bad",
    label: "bad",
    type: "table",
    graphId: "bad",
    children: undefined as unknown as TreeNode[],
  } as TreeNode;
  (provider as unknown as { currentNodes: Set<TreeNode> }).currentNodes.add(malformed);
  assert.equal(
    provider.getTreeItem(malformed).collapsibleState,
    TreeItemCollapsibleState.None,
    "malformed current nodes are non-collapsible",
  );
  assert.deepEqual(
    provider.getChildren(malformed),
    [],
    "malformed current nodes expose an empty child list",
  );

  subscription.dispose();
  provider.dispose();
}

void main()
  .then(() => {
    console.log("tree-provider OK");
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    moduleWithLoad._load = originalLoad;
  });
