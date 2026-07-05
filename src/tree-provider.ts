import * as vscode from "vscode";
import { buildTreeModel, type TreeNode } from "./tree-model";
import type { GraphPayload } from "./types";

export type { TreeNode } from "./tree-model";

const TREE_ICONS: Record<string, string> = {
  schema: "database",
  table: "symbol-structure",
  view: "eye",
  matview: "symbol-interface",
  foreign: "link-external",
  function: "symbol-method",
  column: "symbol-field",
  trigger: "zap",
  constraint: "lock",
  index: "key",
};

function childrenOf(n: TreeNode): TreeNode[] {
  return Array.isArray(n.children) ? n.children : [];
}

export class DbTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private roots: TreeNode[] = [];
  private byGraphId = new Map<string, TreeNode>();
  private currentNodes = new Set<TreeNode>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  dispose(): void {
    this.emitter.dispose();
  }

  setGraph(graph: GraphPayload | null): void {
    this.roots = [];
    this.byGraphId.clear();
    this.currentNodes.clear();
    if (graph) {
      const model = buildTreeModel(graph);
      this.roots = model.roots;
      this.byGraphId = model.byGraphId;
      this.indexCurrentNodes(this.roots);
    }
    this.emitter.fire();
  }

  find(graphId: string): TreeNode | undefined {
    return this.byGraphId.get(graphId);
  }

  getTreeItem(n: TreeNode): vscode.TreeItem {
    const isCurrent = this.currentNodes.has(n);
    const isActionable = isCurrent && n.type !== "group";
    const item = new vscode.TreeItem(
      n.label,
      isCurrent && childrenOf(n).length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = n.id;
    item.description = n.description;
    // contextValue drives the view/item/context menus — the node type, except
    // groups (which carry no actions)
    if (isActionable) {
      item.contextValue = n.type;
      item.iconPath = new vscode.ThemeIcon(TREE_ICONS[n.type] ?? "circle");
    }
    if (isCurrent && n.graphId) {
      item.command = {
        command: "postgresViz.revealNode",
        title: "Reveal in graph",
        arguments: [n.graphId],
      };
    }
    return item;
  }

  getChildren(n?: TreeNode): TreeNode[] {
    if (n && !this.currentNodes.has(n)) return [];
    return n ? childrenOf(n) : this.roots;
  }

  getParent(n: TreeNode): TreeNode | undefined {
    if (!this.currentNodes.has(n)) return undefined;
    return n.parent && this.currentNodes.has(n.parent) ? n.parent : undefined;
  }

  private indexCurrentNodes(roots: TreeNode[]): void {
    const pending = [...roots];
    while (pending.length) {
      const n = pending.pop()!;
      if (this.currentNodes.has(n)) continue;
      this.currentNodes.add(n);
      pending.push(...childrenOf(n));
    }
  }
}
