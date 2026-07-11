import cytoscape, { Core, EdgeSingular, NodeSingular } from "cytoscape";
import {
  DEFAULT_PREFS,
  type ColumnUsageGroup,
  type ColumnUsageResult,
  type HostToWebviewMessage,
  normalizePrefs,
  type Prefs,
  type UsageOccurrenceItem,
  type UsageOccurrencePage,
  type WebviewToHostMessage,
} from "../src/protocol";
import type { EdgeKind, GraphNodeData, GraphPayload } from "../src/types";
import {
  allCardUnits as coreCardUnits,
  callTreeClosure,
  connectionEmphasis,
  fitTarget,
  isShownByClasses,
  type PositionSnapshot,
  snapshotPositions,
  unitTopology,
  unitOf,
} from "./core";
import {
  addRadialSummary,
  applyConnectionEmphasis,
  applyCallTreeColumnFilter as adapterApplyCallTreeColumnFilter,
  applyEdgeSegments,
  applyFilterClasses,
  applyFocusedRowFilter,
  applyKeepMask,
  applySchemaGrouping as adapterApplySchemaGrouping,
  applySelectionClasses,
  clearEdgeRouting as adapterClearEdgeRouting,
  clearHotEdges,
  clearHoverReveal,
  clearSelectionClasses,
  collectCallTreeTouchedRows,
  DATA_KINDS,
  dematerializeAll as adapterDematerializeAll,
  dematerializeCardsWithoutTouchedRows,
  edgeHidden,
  edgeShownByClasses,
  initializeVirtualCards,
  materializeCard as adapterMaterializeCard,
  materializeNeighborhood as adapterMaterializeNeighborhood,
  materializationRowCounts,
  materializeWithinBudget,
  type EdgeDef,
  markCallTreeHot,
  markSingleCardEdgesOrthogonal,
  moveUnitTo,
  type NodeDef,
  primarySelectedNode,
  resetViewState,
  restackRows as adapterRestackRows,
  revealOwnedRadialElements,
  removeOwnedElements,
  restoreViewPositions,
  revealCallTreeEdges,
  ROW_TYPES,
  setHoverReveal,
} from "./cytoscape-adapter";
import { EdgeRoutingPlanner } from "./router";
import { GraphExporter } from "./graph-exporter";
import { ConnectionList, type ConnectionListOptions } from "./connection-list";
import { GraphKeyboardNavigator, type GraphKeyboardNavigatorOptions } from "./keyboard-navigator";
import { layoutTreeV2Positions } from "./layout";
import { BASE_ACTIVE_MODE, transitionActiveMode, type ActiveViewMode } from "./view-mode";
import {
  aggregateUsageRows,
  buildRadialPlan,
  radialPositions,
  usageCategory,
  type UsageCategory,
  type UsageMatrixRow,
} from "./usage-views";

const vscode = acquireVsCodeApi();

function postToHost(message: WebviewToHostMessage): void {
  vscode.postMessage(message);
}

const NODE_COLORS: Record<string, string> = {
  table: "#4C9AFF",
  view: "#57D9A3",
  matview: "#00C7E6",
  foreign: "#998DD9",
  column: "#7A869A",
  function: "#FFAB00",
  trigger: "#FF5630",
  constraint: "#6554C0",
  index: "#84CC16",
  schema: "#57606A",
};

const EDGE_COLORS: Record<string, string> = {
  selects: "#36B37E",
  reads: "#4C9AFF",
  inserts: "#4CC38A",
  updates: "#FFA657",
  deletes: "#F85149",
  writes: "#FF5630",
  modifies: "#C792EA",
  calls: "#FFAB00",
  executes: "#FF7452",
  "update-of": "#FF8F73",
  fk: "#8993A4",
  constrains: "#6554C0",
  indexes: "#84CC16",
  default: "#998DD9",
};

let cy: Core | null = null;
let database = "";
let graphRevision = 0;
let usageRequestId = 0;
let activeColumnUsageRequest = 0;
let panelRenderGeneration = 0;
const usageGroups = new Map<string, ColumnUsageGroup>();
const occurrenceRequestGroups = new Map<number, string>();
const occurrencePages = new Map<string, UsageOccurrenceItem[]>();
let selectedColumnUsage: ColumnUsageResult | null = null;

interface UsageMatrixState {
  result: ColumnUsageResult;
  rows: UsageMatrixRow[];
  category: UsageCategory | "all";
  search: string;
  limit: number;
  expanded?: { ownerId: string; category: UsageCategory };
}

type ActiveMode = ActiveViewMode<UsageMatrixState, ViewSpec>;

let activeMode: ActiveMode = BASE_ACTIVE_MODE;
const activeMatrix = (): UsageMatrixState | null =>
  activeMode.kind === "matrix" ? activeMode.matrix : null;
const activeView = (): ViewSpec | null => (activeMode.kind === "isolated" ? activeMode.view : null);

/**
 * Virtual rows: the full row set lives in these maps; column/trigger/constraint
 * row nodes (and their detail edges) are added to cytoscape only when a card is
 * interacted with. Idle cards draw their column list as an SVG background.
 */
const rowsByCard = new Map<string, NodeDef[]>();
const detailEdgesByCard = new Map<string, EdgeDef[]>();
const cardOfNode = new Map<string, string>(); // row id → card id
const nodeDefById = new Map<string, NodeDef>();
const materialized = new Set<string>();
const limitedCards = new Set<string>();
const MATERIALIZE_CAP = 30;
const MATERIALIZE_ALL_ROWS_CAP = 4_000;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function hidePanel(): void {
  const panelCy = cy;
  const generation = ++panelRenderGeneration;
  el("panel").classList.add("hidden");
  requestAnimationFrame(() => {
    if (panelCy && cy === panelCy && generation === panelRenderGeneration) panelCy.resize();
  });
}

function materializationState() {
  return {
    rowsByCard,
    detailEdgesByCard,
    cardOfNode,
    materialized,
    limited: limitedCards,
    rowTypeFilter:
      prefs.filterNodeTypes.length === 0
        ? undefined
        : new Set(prefs.filterNodeTypes.filter((type) => ROW_TYPES.has(type))),
    materializeCap: MATERIALIZE_CAP,
    materializeAllRowsCap: MATERIALIZE_ALL_ROWS_CAP,
  };
}

/** Mirrored from the extension host; native chrome owns preference changes. */
let prefs: Prefs = { ...DEFAULT_PREFS };
const edgeMode = (): Prefs["edgeMode"] => prefs.edgeMode;

const isDark = (): boolean =>
  document.body.classList.contains("vscode-dark") ||
  document.body.classList.contains("vscode-high-contrast");

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function occurrenceRows(items: readonly UsageOccurrenceItem[]): string {
  return items
    .map(
      (
        item,
      ) => `<li><button class="usage-occurrence" data-occurrence-id="${esc(item.id)}" title="Open ${item.exact ? "exact occurrence" : "definition"}">
        <span class="usage-marker">${item.exact ? "@" : "-"}</span>
        <span>${esc(item.snippet)}</span>
      </button></li>`,
    )
    .join("");
}

function usageGroupHtml(group: ColumnUsageGroup): string {
  const more = group.count > group.occurrences.length && group.occurrences.length > 0;
  return `<li class="usage-group" data-group-id="${esc(group.id)}">
    <div class="usage-owner-row">
      <button class="usage-owner" data-owner-id="${esc(group.id)}">
        <span class="kind" style="color:${EDGE_COLORS[group.kind] ?? "#888"}">${esc(group.kind)}</span>
        <span class="name">${esc([group.owner.schema, group.owner.owner, group.owner.label ?? group.owner.name].filter(Boolean).join("."))}</span>
        <small>${group.count}</small>
      </button>
    </div>
    ${group.occurrences.length ? `<ul class="usage-occurrences">${occurrenceRows(group.occurrences)}</ul>` : ""}
    ${more ? `<button class="usage-more" data-usage-group="${esc(group.id)}" data-offset="0">Show occurrences</button>` : ""}
  </li>`;
}

function renderColumnUsages(result: ColumnUsageResult): void {
  selectedColumnUsage = result;
  usageGroups.clear();
  occurrencePages.clear();
  for (const group of result.groups) usageGroups.set(group.id, group);
  document
    .querySelectorAll<HTMLButtonElement>("#neighborhood-btn, #matrix-btn")
    .forEach((button) => {
      button.disabled = false;
    });
  const root = document.getElementById("column-usages");
  if (!root || root.dataset.columnId !== result.columnId) return;
  const sql = result.groups.filter((group) => group.section === "sql");
  const structural = result.groups.filter((group) => group.section === "structural");
  root.innerHTML = result.groups.length
    ? `${sql.length ? `<details open><summary>Used in definitions (${sql.length})</summary><ul class="usage-list">${sql.map(usageGroupHtml).join("")}</ul></details>` : ""}
       ${structural.length ? `<details><summary>Structural relationships (${structural.length})</summary><ul class="usage-list">${structural.map(usageGroupHtml).join("")}</ul></details>` : ""}`
    : '<p class="usage-empty">No loaded definitions use this column.</p>';
  root.addEventListener("click", handleUsageClick);
}

function openUsageOwner(group: ColumnUsageGroup): void {
  const { owner } = group;
  postToHost({
    type: "openDefinition",
    nodeType: owner.type,
    oid: owner.oid,
    schema: owner.schema,
    name: owner.label ?? owner.name,
    owner: owner.owner,
    label: owner.schema ? `${owner.schema}.${owner.name}` : owner.name,
  });
}

function requestUsageGroup(groupId: string, offset: number): void {
  const requestId = ++usageRequestId;
  occurrenceRequestGroups.set(requestId, groupId);
  postToHost({
    type: "requestUsageOccurrences",
    revision: graphRevision,
    requestId,
    groupId,
    offset,
  });
}

function handleUsageClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  const occurrence = target.closest<HTMLButtonElement>("button[data-occurrence-id]");
  if (occurrence?.dataset.occurrenceId) {
    postToHost({
      type: "openUsage",
      revision: graphRevision,
      occurrenceId: occurrence.dataset.occurrenceId,
    });
    return;
  }
  const ownerButton = target.closest<HTMLButtonElement>("button[data-owner-id]");
  const ownerGroup = ownerButton?.dataset.ownerId
    ? usageGroups.get(ownerButton.dataset.ownerId)
    : undefined;
  if (ownerGroup) {
    openUsageOwner(ownerGroup);
    return;
  }
  const more = target.closest<HTMLButtonElement>("button[data-usage-group]");
  if (!more?.dataset.usageGroup) return;
  more.disabled = true;
  requestUsageGroup(more.dataset.usageGroup, Number(more.dataset.offset ?? 0));
}

function renderUsageOccurrencePage(page: UsageOccurrencePage, requestId: number): void {
  if (occurrenceRequestGroups.get(requestId) !== page.groupId) return;
  occurrenceRequestGroups.delete(requestId);
  const previous = page.offset === 0 ? [] : (occurrencePages.get(page.groupId) ?? []);
  occurrencePages.set(page.groupId, [...previous, ...page.occurrences]);
  document
    .querySelectorAll<HTMLElement>(`.usage-group[data-group-id="${CSS.escape(page.groupId)}"]`)
    .forEach((item) => {
      let list = item.querySelector<HTMLUListElement>(".usage-occurrences");
      if (!list) {
        list = document.createElement("ul");
        list.className = "usage-occurrences";
        item.append(list);
      }
      list.innerHTML = occurrenceRows(occurrencePages.get(page.groupId) ?? []);
      const more = item.querySelector<HTMLButtonElement>("button[data-usage-group]");
      const next = page.offset + page.occurrences.length;
      if (more && next < page.total) {
        more.disabled = false;
        more.dataset.offset = String(next);
        more.textContent = `Show ${Math.min(50, page.total - next)} more`;
      } else more?.remove();
    });
  if (activeMode.kind === "matrix") renderUsageMatrix();
}

function matrixGroupHtml(group: ColumnUsageGroup): string {
  const occurrences = occurrencePages.get(group.id) ?? group.occurrences;
  const more = group.count > occurrences.length && occurrences.length > 0;
  return `<div class="usage-group matrix-group" data-group-id="${esc(group.id)}">
    <div><span class="kind" style="color:${EDGE_COLORS[group.kind] ?? "#888"}">${esc(group.kind)}</span><small>${group.count}</small></div>
    ${occurrences.length ? `<ul class="usage-occurrences">${occurrenceRows(occurrences)}</ul>` : ""}
    ${more ? `<button class="usage-more" data-usage-group="${esc(group.id)}" data-offset="${occurrences.length > 3 ? occurrences.length : 0}">Show occurrences</button>` : ""}
  </div>`;
}

function renderUsageMatrix(): void {
  const matrix = activeMatrix();
  if (!matrix) return;
  const categories: (UsageCategory | "all")[] = ["all", "reads", "writes", "structural"];
  const selectedCategory = matrix.category;
  el("matrix-categories").innerHTML = categories
    .map(
      (category) =>
        `<button data-matrix-category="${category}" class="${selectedCategory === category ? "active" : ""}">${category === "all" ? "All" : category[0]!.toUpperCase() + category.slice(1)}</button>`,
    )
    .join("");
  const query = matrix.search.trim().toLowerCase();
  const filtered = matrix.rows.filter(
    (row) =>
      (!query || row.qualifiedName.toLowerCase().includes(query)) &&
      (selectedCategory === "all" || row.counts[selectedCategory] > 0),
  );
  const visible = filtered.slice(0, matrix.limit);
  const rows = visible
    .map((row) => {
      const cells = (["reads", "writes", "structural"] as const)
        .map(
          (category) =>
            `<td><button data-matrix-owner="${esc(row.owner.id)}" data-matrix-cell="${category}" ${row.counts[category] === 0 ? "disabled" : ""}>${row.counts[category]}</button></td>`,
        )
        .join("");
      const expanded = matrix.expanded;
      const details =
        expanded?.ownerId === row.owner.id
          ? row.groups
              .filter((group) => usageCategory(group.kind) === expanded.category)
              .map(matrixGroupHtml)
              .join("")
          : "";
      return `<tr>
        <th scope="row"><button class="matrix-owner" data-matrix-owner-definition="${esc(row.owner.id)}">${esc(row.qualifiedName)}</button></th>
        ${cells}<td class="matrix-total">${row.total}</td>
      </tr>${details ? `<tr class="matrix-detail"><td colspan="5">${details}</td></tr>` : ""}`;
    })
    .join("");
  el("matrix-scroll").innerHTML = `<table>
      <thead><tr><th>Object</th><th>Reads</th><th>Writes</th><th>Structural</th><th>Total</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="matrix-empty">No matching usages.</td></tr>'}</tbody>
    </table>
    ${visible.length < filtered.length ? `<button id="matrix-more">Show ${Math.min(100, filtered.length - visible.length)} more</button>` : ""}`;
}

function showUsageMatrix(result: ColumnUsageResult, category: UsageCategory | "all" = "all"): void {
  const matrix = {
    result,
    rows: aggregateUsageRows(result.groups),
    category,
    search: "",
    limit: 100,
  };
  const transition = transitionActiveMode(activeMode, { type: "enter-matrix", matrix });
  if (transition.leave === "isolated") leaveToBase();
  activeMode = transition.state;
  el("content").classList.add("view-matrix");
  el("cy").classList.add("hidden");
  el("canvas-footer").classList.add("hidden");
  el("reset-filters").classList.add("hidden");
  el("usage-matrix").classList.remove("hidden");
  document.querySelector("#matrix-btn")?.classList.add("active-matrix");
  const column = nodeDefById.get(result.columnId)?.data;
  const table = column?.parent ? nodeDefById.get(column.parent)?.data.label : undefined;
  const title = column
    ? [column.schema, table, column.label].filter(Boolean).join(".")
    : result.columnId;
  const crumb = el("crumb");
  crumb.classList.remove("hidden");
  crumb.innerHTML = `<span>Usage matrix: ${esc(title)}</span><button id="crumb-back">back</button>`;
  crumb.querySelector("#crumb-back")?.addEventListener("click", closeUsageMatrix);
  const search = el<HTMLInputElement>("matrix-search");
  search.value = "";
  renderUsageMatrix();
  search.focus();
}

function closeUsageMatrix(): void {
  if (activeMode.kind !== "matrix") return;
  const matrixCy = cy;
  activeMode = transitionActiveMode(activeMode, { type: "exit" }).state;
  el("content").classList.remove("view-matrix");
  el("usage-matrix").classList.add("hidden");
  document.querySelector("#matrix-btn")?.classList.remove("active-matrix");
  el("cy").classList.remove("hidden");
  el("canvas-footer").classList.remove("hidden");
  hideCrumb();
  buildLegend();
  requestAnimationFrame(() => {
    if (matrixCy && cy === matrixCy) matrixCy.resize();
  });
}

// ── card art: the column list of an idle card, rendered as one SVG image ──

const ROW_H = 15;
const HEADER_H = 22;
/** Art is a preview, not the ERD — a 200-column table must not dwarf the graph. */
const MAX_ART_ROWS = 30;

function buildCardArt(card: NodeDef): void {
  const rowTypeFilter = new Set(prefs.filterNodeTypes);
  const all = (rowsByCard.get(card.data.id) ?? []).filter(
    (row) => rowTypeFilter.size === 0 || rowTypeFilter.has(row.data.type),
  );
  const rows = all.slice(0, MAX_ART_ROWS);
  const extra = all.length - rows.length;
  let maxLabelLength = card.data.label.length;
  for (const row of rows) maxLabelLength = Math.max(maxLabelLength, String(row.data.label).length);
  const w = Math.max(90, maxLabelLength * 6.2 + 24);
  const h = HEADER_H + (rows.length + (extra > 0 ? 1 : 0)) * ROW_H + 8;
  const dark = isDark();
  const textColor = dark ? "#9fadbc" : "#57606a";
  const stripe = dark ? "#ffffff" : "#000000";
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h - HEADER_H}">`,
  ];
  rows.forEach((r, i) => {
    const y = i * ROW_H;
    const accent = NODE_COLORS[r.data.type] ?? textColor;
    if (i % 2 === 1) {
      parts.push(
        `<rect x="2" y="${y}" width="${w - 4}" height="${ROW_H}" fill="${stripe}" opacity="0.04"/>`,
      );
    }
    if (r.data.type !== "column") {
      parts.push(
        `<rect x="2" y="${y}" width="3" height="${ROW_H}" fill="${accent}" opacity="0.9"/>`,
      );
    }
    parts.push(
      `<text x="10" y="${y + 11}" font-family="Helvetica,Arial,sans-serif" font-size="9" fill="${r.data.type === "column" ? textColor : accent}">${esc(r.data.label)}</text>`,
    );
  });
  if (extra > 0) {
    parts.push(
      `<text x="10" y="${rows.length * ROW_H + 11}" font-family="Helvetica,Arial,sans-serif" font-size="9" font-style="italic" fill="${textColor}" opacity="0.75">… +${extra} more</text>`,
    );
  }
  parts.push("</svg>");
  card.data.svg = `data:image/svg+xml;utf8,${encodeURIComponent(parts.join(""))}`;
  card.data.cardW = w;
  card.data.cardH = h;
}

// ── materialization: swap a card's SVG rows for real nodes + detail edges ──

function materializeCard(cardId: string): void {
  if (!cy) return;
  adapterMaterializeCard(cy, materializationState(), cardId);
}

/** Materialize a card plus the counterpart cards of its detail edges (capped). */
function materializeNeighborhood(unitId: string): void {
  if (!cy) return;
  adapterMaterializeNeighborhood(cy, materializationState(), unitId);
}

function dematerializeAll(): void {
  if (!cy) return;
  adapterDematerializeAll(cy, materializationState());
  limitedCards.clear();
}

// ── styles ──

function buildStyle(): cytoscape.StylesheetJson {
  const dark = isDark();
  const text = dark ? "#d8dee9" : "#24292f";
  const chipBg = dark ? "#1c2128" : "#f6f8fa";
  const cardBorders = ["table", "view", "matview", "foreign"].map((t) => ({
    selector: `node.virtual-card[type="${t}"], node:parent[type="${t}"]`,
    style: { "border-color": NODE_COLORS[t]!, color: NODE_COLORS[t]! },
  }));
  const styles: { selector: string; style: Record<string, unknown> }[] = [
    {
      selector: "node",
      style: {
        label: "data(label)",
        "font-size": 9,
        "min-zoomed-font-size": 7,
        color: text,
        "text-valign": "center",
        "text-halign": "center",
        shape: "round-rectangle",
        width: "label",
        height: 18,
        padding: "6px",
        "background-color": "#888888",
        "background-opacity": 0.9,
        "border-width": 0.5,
        "border-color": dark ? "#0d1117" : "#d0d7de",
      },
    },
    ...Object.entries(NODE_COLORS).map(([type, color]) => ({
      selector: `node[type="${type}"]`,
      style: { "background-color": color },
    })),
    // ERD rows (only exist while their card is materialized)
    {
      selector: 'node[type="column"]',
      style: {
        "font-size": 9,
        "min-zoomed-font-size": 8,
        height: 14,
        shape: "rectangle",
        "background-opacity": 0.18,
        "border-width": 0,
        padding: "1px",
      },
    },
    {
      selector: 'node[type="trigger"], node[type="constraint"], node[type="index"]',
      style: {
        "font-size": 8,
        "min-zoomed-font-size": 8,
        height: 14,
        shape: "rectangle",
        "background-opacity": 0.35,
        "border-width": 0,
        padding: "1px",
      },
    },
    // materialized ERD card (compound)
    {
      selector: ":parent",
      style: {
        shape: "round-rectangle",
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": 14,
        "font-weight": "bold",
        "font-size": 10,
        "min-zoomed-font-size": 5,
        "background-opacity": 0.92,
        "background-color": chipBg,
        "border-width": 1.5,
        padding: "12px",
        "min-width": "70px",
        "min-height": "20px",
      },
    },
    // idle ERD card: plain node, column list painted as an SVG background
    {
      selector: "node.virtual-card",
      style: {
        shape: "round-rectangle",
        width: "data(cardW)",
        height: "data(cardH)",
        "background-image": "data(svg)",
        "background-fit": "none",
        "background-position-x": "0px",
        "background-position-y": `${HEADER_H}px`,
        "background-color": chipBg,
        "background-opacity": 0.92,
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": 14,
        "font-weight": "bold",
        "font-size": 10,
        "min-zoomed-font-size": 5,
        "border-width": 1.5,
        padding: "0px",
      },
    },
    ...cardBorders,
    {
      selector: 'node[type="schema"]',
      style: {
        // fully click-through: drags pan, clicks land on the cards beneath —
        // a schema box spans most of the viewport and must never eat input
        events: "no",
        "background-opacity": 0.02,
        "background-color": "#57606A",
        "border-width": 2,
        "border-style": "dashed",
        "border-color": "#57606A",
        color: text,
        "font-size": 14,
        "min-zoomed-font-size": 5,
        "text-margin-y": -6,
        padding: "28px",
      },
    },
    {
      selector: 'node[type="function"]',
      style: { "font-size": 8.5, height: 14, "background-opacity": 0.8 },
    },
    {
      selector: "node.radial-summary",
      style: {
        label: "data(label)",
        shape: "round-rectangle",
        width: 92,
        height: 26,
        "font-size": 9,
        "min-zoomed-font-size": 0,
        "font-weight": "bold",
        color: text,
        "text-opacity": 1,
        "z-index": 999,
        "background-opacity": 0.9,
        "border-width": 1.5,
        "border-style": "dashed",
      },
    },
    {
      selector: 'node.radial-summary[category="reads"]',
      style: { "background-color": EDGE_COLORS.reads, "border-color": EDGE_COLORS.reads },
    },
    {
      selector: 'node.radial-summary[category="writes"]',
      style: { "background-color": EDGE_COLORS.updates, "border-color": EDGE_COLORS.updates },
    },
    {
      selector: 'node.radial-summary[category="structural"]',
      style: { "background-color": EDGE_COLORS.fk, "border-color": EDGE_COLORS.fk },
    },
    {
      selector: "edge",
      style: {
        width: 1,
        "curve-style": "bezier",
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.6,
        "line-color": "#8993A4",
        "target-arrow-color": "#8993A4",
        opacity: 0.35,
      },
    },
    ...Object.entries(EDGE_COLORS).map(([kind, color]) => ({
      selector: `edge[kind="${kind}"]`,
      style: { "line-color": color, "target-arrow-color": color },
    })),
    { selector: 'edge[kind="fk"]', style: { "line-style": "dashed" } },
    { selector: 'edge[kind="calls"]', style: { "line-style": "dashed" } },
    { selector: 'edge[kind="default"]', style: { "line-style": "dotted" } },
    {
      selector: "edge.radial-summary-edge",
      style: { "line-style": "dashed", opacity: 0.65, "target-arrow-shape": "none" },
    },
    {
      selector: "edge[?agg]",
      style: {
        width: 1.4,
        opacity: 0.55,
        label: "data(displayLabel)",
        "line-color": "#8993A4",
        "target-arrow-color": "#8993A4",
        "font-size": 8,
        "min-zoomed-font-size": 7,
        color: text,
        "text-rotation": "autorotate",
        "text-background-color": chipBg,
        "text-background-opacity": 0.85,
        "text-background-padding": "1px",
        "text-background-shape": "round-rectangle",
      },
    },
    {
      selector: "edge.ortho",
      style: {
        "curve-style": "round-taxi",
        "taxi-direction": "vertical",
        "taxi-turn": "50%",
        "taxi-turn-min-distance": "12px",
        "taxi-radius": "8px",
      },
    },
    { selector: ".dimmed", style: { opacity: 0.15, "text-opacity": 0 } },
    {
      selector: "node.connection-medium",
      style: {
        "underlay-color": "#FFAB00",
        "underlay-opacity": 0.12,
        "underlay-padding": 4,
      },
    },
    {
      selector: "node.connection-high",
      style: {
        "underlay-color": "#FFAB00",
        "underlay-opacity": 0.24,
        "underlay-padding": 7,
      },
    },
    { selector: "edge.hot", style: { opacity: 0.95, width: 1.8, "z-index": 9 } },
    { selector: "edge.edge-off", style: { display: "none" } },
    { selector: "edge.revealed", style: { display: "element" } },
    { selector: "edge.hover-reveal", style: { display: "element", opacity: 0.8, width: 1.5 } },
    { selector: "edge.agg-suppressed", style: { display: "none" } },
    { selector: ".hidden-el", style: { display: "none" } },
    { selector: ".facet-hidden", style: { display: "none" } },
    { selector: ".isolated-hidden", style: { display: "none" } },
    { selector: ".focus-hidden", style: { display: "none" } },
    { selector: ".untouched-hidden", style: { display: "none" } },
    {
      selector: ".matched",
      style: { "border-width": 2, "border-color": "#FFD700", "background-opacity": 1 },
    },
    { selector: "node:selected", style: { "border-width": 2.5, "border-color": "#FFD700" } },
  ];
  return styles as unknown as cytoscape.StylesheetJson;
}

// ── render ──

function render(graph: GraphPayload): void {
  activeMode = BASE_ACTIVE_MODE;
  selectedColumnUsage = null;
  usageGroups.clear();
  occurrencePages.clear();
  occurrenceRequestGroups.clear();
  el("content").classList.remove("view-matrix");
  el("usage-matrix").classList.add("hidden");
  el("cy").classList.remove("hidden");
  el("canvas-footer").classList.remove("hidden");
  el("empty").style.display = "none";
  hideCrumb();
  rowsByCard.clear();
  detailEdgesByCard.clear();
  cardOfNode.clear();
  nodeDefById.clear();
  materialized.clear();
  limitedCards.clear();

  const liveNodes: NodeDef[] = [];
  for (const n of graph.nodes) nodeDefById.set(n.data.id, n);
  for (const n of graph.nodes) {
    if (ROW_TYPES.has(n.data.type)) {
      const card = n.data.parent!;
      if (!rowsByCard.has(card)) rowsByCard.set(card, []);
      rowsByCard.get(card)!.push(n);
      cardOfNode.set(n.data.id, card);
    } else {
      liveNodes.push(n);
    }
  }
  for (const rows of rowsByCard.values()) {
    rows.sort((a, b) => (a.data.ord ?? 0) - (b.data.ord ?? 0));
  }
  for (const e of graph.edges) {
    if (!e.data.detail) continue;
    for (const end of [e.data.source, e.data.target]) {
      const card = cardOfNode.get(end);
      if (card) {
        if (!detailEdgesByCard.has(card)) detailEdgesByCard.set(card, []);
        detailEdgesByCard.get(card)!.push(e);
      }
    }
  }
  connectionList.reindex();
  for (const n of liveNodes) {
    if (rowsByCard.has(n.data.id)) buildCardArt(n);
  }
  const liveEdges = graph.edges.filter((e) => !e.data.detail);

  if (cy) removeOwnedElements(cy, radialSyntheticIds);
  cy?.destroy();
  cy = cytoscape({
    container: el("cy"),
    elements: {
      nodes: liveNodes,
      edges: liveEdges,
    } as unknown as cytoscape.ElementsDefinition,
    style: buildStyle(),
    layout: { name: "preset" },
    wheelSensitivity: 0.2,
    hideEdgesOnViewport: true,
    motionBlur: false,
    pixelRatio: 1,
    boxSelectionEnabled: false,
    // dragging always pans the canvas — node positions are layout-owned
    autoungrabify: true,
  });
  initializeVirtualCards(cy, rowsByCard);
  // a graph push while a view was active must clear EVERYTHING the view
  // owned: the spec, the canvas tint, the pending zoom nudge, the panel
  window.clearTimeout(zoomNudge);
  clearViewUiState();
  hidePanel();
  applySchemaGrouping(false);
  applyFilters();
  runLayout();
  cy.on("tap", "node", (ev) => {
    const n = ev.target as NodeSingular;
    if (n.hasClass("radial-summary")) {
      const category = n.data("category") as UsageCategory;
      const view = activeView();
      if (view?.mode === "radial" && view.radialResult) {
        showUsageMatrix(view.radialResult, category);
      }
      return;
    }
    const unit = unitOf(n);
    if (rowsByCard.has(unit.id()) && !materialized.has(unit.id()) && activeMode.kind === "base") {
      materializeNeighborhood(unit.id());
      applyFilters();
    }
    selectNode(n);
  });
  cy.on("tap", (ev) => {
    if (ev.target === cy) clearSelection();
  });
  cy.on("dbltap", "node", (ev) => {
    const node = ev.target as NodeSingular;
    if (!node.hasClass("radial-summary")) focusNode(node);
  });
  wireHoverPreview();
}

function applyFilters(): void {
  if (!cy) return;
  applyFilterClasses(cy, materializationState(), prefs, edgeMode(), activeMode.kind === "isolated");
  applyConnectionEmphasis(
    cy,
    prefs.emphasizeConnections ? connectionEmphasis(unitAdjacency(cardUnits()).degree) : new Map(),
  );
  restackRows();
  buildLegend();
}

/**
 * ERD pass: stack each materialized card's visible children (columns by attnum,
 * then triggers and constraints) as uniform-width rows inside the card.
 * Compound positions are DERIVED from children in cytoscape, so this must
 * re-run after anything that moves cards or changes row visibility — layouts,
 * filters, materialization — or edges anchor to stale row positions. The card
 * center is snapshotted before the loop because moving rows shifts it.
 */
function restackRows(): void {
  if (!cy) return;
  adapterRestackRows(cy);
}

/** Move tables/views/functions in or out of their schema compound. */
function applySchemaGrouping(relayout: boolean): void {
  if (!cy) return;
  exitView(false);
  adapterApplySchemaGrouping(cy, prefs.schemaGroup);
  if (relayout) {
    applyFilters();
    runLayout();
  }
}

// ── card-level layouts ──

const GAP = 36;
const PILL_GAP = 14;

function canvasAspect(): number {
  const c = el("cy");
  const raw = c.clientWidth / Math.max(1, c.clientHeight);
  // shelf packing wastes some height — bias wider
  return Math.min(5, Math.max(1, raw)) * 1.3;
}

/** Fit synchronously so follow-up selection animations cannot interrupt it. */
function fitView(eles?: cytoscape.CollectionArgument, padding = 50): void {
  if (!cy) return;
  cy.stop();
  // class-derived shown set, never `:visible` — computed style is stale right
  // after the batched class changes of focus/call-tree, so `:visible` fits
  // would cover the long-hidden full-graph extent and zoom way out
  const target = eles ?? fitTarget(cy);
  cy.fit(target, padding);
}

// visibility/unit helpers live in core.ts so headless tests can cover them
const isShown = isShownByClasses;

/** Layout units: the currently shown cards and standalone nodes. */
function cardUnits(): NodeSingular[] {
  return coreCardUnits(cy!).filter((n) => isShown(n));
}

function unitBox(u: NodeSingular) {
  return u.boundingBox({ includeLabels: true });
}

/** Shelf-pack members into rows of the given width starting at (x0, y0); returns height used. */
function packShelf(
  members: NodeSingular[],
  x0: number,
  y0: number,
  rowWidth: number,
  gap: number,
): number {
  let x = 0;
  let y = y0;
  let rowH = 0;
  for (const u of members) {
    const b = unitBox(u);
    if (x > 0 && x + b.w > rowWidth) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    moveUnitTo(u, x0 + x + b.w / 2, y + b.h / 2);
    x += b.w + gap;
    rowH = Math.max(rowH, b.h);
  }
  return y + rowH - y0;
}

/** One schema block: relations shelved on top, function pills densely below. */
function layoutCardBlock(
  members: NodeSingular[],
  x0: number,
  y0: number,
  rowWidth: number,
): number {
  const byLabel = (a: NodeSingular, b: NodeSingular): number =>
    String(a.data("label")).localeCompare(String(b.data("label")));
  const rels = members.filter((u) => u.data("type") !== "function").sort(byLabel);
  const pills = members.filter((u) => u.data("type") === "function").sort(byLabel);
  let h = 0;
  if (rels.length > 0) h += packShelf(rels, x0, y0, rowWidth, GAP);
  if (pills.length > 0) {
    if (rels.length > 0) h += GAP;
    h += packShelf(pills, x0, y0 + h, rowWidth, PILL_GAP);
  }
  return h;
}

/**
 * Schema-blocked grid, packed to the viewport's aspect ratio.
 * Geometry: a region of area A laid out at aspect ratio r has width
 * W = sqrt(A·r) — applied twice: each schema block gets its width from its own
 * area share, and the outer shelf width comes from the total. Shelf packing
 * wastes 10–25% height, hence the ×1.15 bias in canvasAspect() and ×1.1 on the
 * outer width. Blocks pack tallest-first (FFDH) to keep shelves dense.
 */
function layoutGridCards(units: NodeSingular[]): void {
  const groups = new Map<string, NodeSingular[]>();
  for (const u of units) {
    const key = String(u.data("schema") ?? "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(u);
  }
  const aspect = canvasAspect();
  // estimate each block's footprint to derive its width and the outer shelf width
  const blocks = [...groups.entries()].map(([key, members]) => {
    let area = 0;
    let widest = 0;
    for (const u of members) {
      const b = unitBox(u);
      area += (b.w + GAP) * (b.h + GAP);
      widest = Math.max(widest, b.w);
    }
    return { key, members, area, width: Math.max(widest + GAP, Math.sqrt(area * aspect)) };
  });
  const totalArea = blocks.reduce((s, b) => s + b.area, 0);
  const outerWidth = Math.max(
    blocks.reduce((m, b) => Math.max(m, b.width), 0),
    Math.sqrt(totalArea * aspect) * 1.1,
  );
  // FFDH-ish outer shelf: tallest-estimate blocks first
  blocks.sort((a, b) => b.area / b.width - a.area / a.width);
  const BLOCK_GAP = GAP * 2.5;
  let x = 0;
  let y = 0;
  let shelfH = 0;
  for (const block of blocks) {
    if (x > 0 && x + block.width > outerWidth) {
      x = 0;
      y += shelfH + BLOCK_GAP;
      shelfH = 0;
    }
    const h = layoutCardBlock(block.members, x, y, block.width);
    x += block.width + BLOCK_GAP;
    shelfH = Math.max(shelfH, h);
  }
}

/** Unit-level adjacency from card-level edges (aggregates + real unit edges). */
function unitAdjacency(units: NodeSingular[]): {
  out: Map<string, Set<string>>;
  degree: Map<string, number>;
} {
  const edges: { source: string; target: string }[] = [];
  cy!.edges("[?agg]").forEach((e) => {
    if (edgeHidden(e as EdgeSingular)) return;
    edges.push({ source: e.source().id(), target: e.target().id() });
  });
  return unitTopology(
    units.map((unit) => unit.id()),
    edges,
  );
}

function layoutTreeCards(units: NodeSingular[]): void {
  const { out, degree } = unitAdjacency(units);
  const indeg = new Map<string, number>();
  for (const u of units) indeg.set(u.id(), 0);
  for (const targets of out.values()) {
    for (const t of targets) indeg.set(t, (indeg.get(t) ?? 0) + 1);
  }
  const level = new Map<string, number>();
  const seen = new Set<string>();
  let frontier = units.filter((u) => (indeg.get(u.id()) ?? 0) === 0).map((u) => u.id());
  if (frontier.length === 0 && units.length > 0) frontier = [units[0]!.id()];
  let l = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      level.set(id, l);
      for (const t of out.get(id) ?? []) if (!seen.has(t)) next.push(t);
    }
    frontier = next;
    l++;
  }
  for (const u of units) if (!level.has(u.id())) level.set(u.id(), l);
  const byLevel = new Map<number, NodeSingular[]>();
  for (const u of units) {
    const lv = level.get(u.id())!;
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv)!.push(u);
  }
  // wrap each dependency layer to the viewport's aspect so wide trees don't
  // fit-to-specks; busiest cards lead their layer
  const totalArea = units.reduce((s, u) => {
    const b = unitBox(u);
    return s + (b.w + GAP) * (b.h + GAP);
  }, 0);
  const maxW = Math.max(900, Math.sqrt(totalArea * canvasAspect()));
  let y = 0;
  for (const lv of [...byLevel.keys()].sort((a, b) => a - b)) {
    const row = byLevel
      .get(lv)!
      .sort((a, b) => (degree.get(b.id()) ?? 0) - (degree.get(a.id()) ?? 0));
    y += packShelf(row, 0, y, maxW, GAP) + GAP * 2;
  }
}

/**
 * v2 tree/call-graph layout — dagre's layered DAG engine over the unit graph.
 *
 * Where layoutTreeCards (v1) does BFS leveling + per-level shelf wrapping, this
 * hands the unit adjacency to dagre, which gives a proper Sugiyama layout:
 * longest-path ranks (every call edge points the same way, one rank per depth,
 * no wrapping), cycle breaking (recursion/mutual calls don't strand nodes), and
 * median crossing reduction. We run dagre HEADLESS on units only — never the
 * compound schema/column hierarchy it can't handle — then snap each unit's
 * centre to V2_GRID and place it with moveUnitTo, leaving materialization,
 * restack and routing untouched.
 */
function layoutTreeCardsV2(units: NodeSingular[]): void {
  if (units.length === 0) return;
  const { out } = unitAdjacency(units);
  const edges: { source: string; target: string }[] = [];
  for (const [s, targets] of out) {
    for (const t of targets) edges.push({ source: s, target: t });
  }
  const positions = layoutTreeV2Positions(
    units.map((unit) => {
      const box = unitBox(unit);
      return { id: unit.id(), width: box.w, height: box.h };
    }),
    edges,
    GAP,
  );
  for (const u of units) {
    const position = positions.get(u.id());
    if (position) moveUnitTo(u, position.x, position.y);
  }
}

/** Dispatch the tree/call-graph layout to the engine the prefs select. */
function layoutTree(units: NodeSingular[]): void {
  if (prefs.engine === "v2") layoutTreeCardsV2(units);
  else layoutTreeCards(units);
}

// ── obstacle-avoiding edge routing (toggleable heuristic) ──
//
// Cytoscape has no built-in router that avoids node boxes. Since the card
// layouts are ours, a deterministic detour is enough: if an edge's straight
// line crosses any card, re-draw it as Manhattan segments that exit the
// source, run along the outer-left "bus" (always clear of cards), and enter
// the target from its open side. Routed edges use per-edge style bypasses
// (curve-style: segments), cleared and recomputed after every layout/reveal.

/** True when an edge is actually being drawn right now (class-derived). */
function edgeShownForRouting(e: EdgeSingular): boolean {
  if (e.hasClass("agg-suppressed") || edgeHidden(e)) return false;
  const revealed = e.hasClass("revealed") || e.hasClass("hover-reveal");
  if (!revealed) {
    const mode = edgeMode();
    if (mode === "off") return false;
    if (mode === "cards" && !e.data("agg")) return false;
    if (mode === "all" && e.data("agg")) return false;
  }
  return isShown(e.source() as NodeSingular) && isShown(e.target() as NodeSingular);
}

const graphExporter = new GraphExporter({
  graph: () => cy,
  dark: isDark,
  nodeShown: isShown,
  edgeShown: edgeShownForRouting,
  nodeColors: NODE_COLORS,
  edgeColors: EDGE_COLORS,
});

const connectionList = new ConnectionList({
  root: el("panel-body") as unknown as ConnectionListOptions["root"],
  graph: () => cy,
  prefs: () => prefs,
  edgeColors: EDGE_COLORS,
  detailEdgesByCard,
  nodeDefById,
  cardOfNode,
  isShown,
  onSelect: (node) => {
    selectNode(node);
    cy?.animate({ center: { eles: node }, duration: 200 } as never);
  },
  onPage: (html) => {
    const sections = el("panel-body").querySelector<HTMLElement>("#connection-sections");
    if (sections) sections.innerHTML = html;
  },
});

const routedEdges = new Set<string>();
let routingLimited = 0;

function clearEdgeRouting(): void {
  if (!cy) return;
  adapterClearEdgeRouting(cy, routedEdges);
}

function routeEdgesAroundCards(): void {
  if (!cy) return;
  clearEdgeRouting();
  routingLimited = 0;
  if (!prefs.route) {
    updateStats();
    return;
  }
  const units = cardUnits();
  const boxes = units.map((u) => {
    const b = unitBox(u);
    return { id: u.id(), box: { x1: b.x1 - 10, y1: b.y1 - 10, x2: b.x2 + 10, y2: b.y2 + 10 } };
  });
  if (boxes.length === 0) {
    updateStats();
    return;
  }
  const planner = new EdgeRoutingPlanner<EdgeSingular>(boxes, 2_000);
  const extent = cy.extent();
  const center = { x: (extent.x1 + extent.x2) / 2, y: (extent.y1 + extent.y2) / 2 };
  cy.edges().forEach((edge) => {
    const e = edge as EdgeSingular;
    if (!edgeShownForRouting(e)) return;
    const source = e.source() as NodeSingular;
    const target = e.target() as NodeSingular;
    const sourceUnit = unitOf(source).id();
    const targetUnit = unitOf(target).id();
    const sp = source.position();
    const tp = target.position();
    const inViewport =
      (sp.x >= extent.x1 && sp.x <= extent.x2 && sp.y >= extent.y1 && sp.y <= extent.y2) ||
      (tp.x >= extent.x1 && tp.x <= extent.x2 && tp.y >= extent.y1 && tp.y <= extent.y2);
    planner.add(
      e,
      sourceUnit,
      targetUnit,
      sp,
      tp,
      source.selected() || target.selected() ? 0 : inViewport ? 1 : 2,
      Math.hypot((sp.x + tp.x) / 2 - center.x, (sp.y + tp.y) / 2 - center.y),
    );
  });
  const planned = planner.result();
  routingLimited = planned.omitted;
  for (const route of planned.routes) {
    applyEdgeSegments(routedEdges, route.value, route.source, route.target, route.waypoints);
  }
  updateStats();
}

function runLayout(): void {
  if (!cy) return;
  // prefs.layout "tree" is what layoutTreeCards keys off as "breadthfirst"
  const name = prefs.layout === "tree" ? "breadthfirst" : "grid";
  // Taxi routing has no parallel-edge separation; parallel card pairs stay bezier.
  markSingleCardEdgesOrthogonal(cy);
  restackRows();
  const units = cardUnits();
  if (name === "breadthfirst") layoutTree(units);
  else layoutGridCards(units);
  routeEdgesAroundCards();
  fitView();
}

// ── selection ──

function selectNode(node: NodeSingular): void {
  if (!cy) return;
  const view = activeView();
  // the call tree OWNS its revealed/agg-suppressed coating — selection only
  // drives the hot layer and the panel there (one stray tap used to wipe
  // every visible edge of the chain)
  if (view?.mode === "calltree") {
    clearHotEdges(cy);
    const unit = unitOf(node);
    markCallTreeHot(unit);
    renderPanel(node);
    return;
  }
  applySelectionClasses(cy, node, unitOf);
  routeEdgesAroundCards();
  renderPanel(node);
}

function clearSelection(): void {
  if (!cy) return;
  const view = activeView();
  if (view?.mode === "calltree") {
    clearHotEdges(cy);
    hidePanel();
    return;
  }
  if (view?.mode === "focus") {
    // background tap re-selects the origin instead of blanking the view
    const root = cy.getElementById(view.rootId);
    if (root.nonempty()) {
      selectNode(root as unknown as NodeSingular);
      return;
    }
  }
  clearSelectionClasses(cy);
  hidePanel();
  if (activeMode.kind === "base" && edgeMode() !== "all") {
    dematerializeAll();
    restackRows();
  }
  routeEdgesAroundCards();
}

// ── focus mode & call tree ──
//
// Views are DECLARATIVE: a ViewSpec describes the whole view, and entering
// one always goes base → spec (leaveToBase first), never diffing one view
// against another. That, plus class-group ownership in core.ts, is the fix
// for the "swapping focus corrupts state" family of bugs.

/** Declarative description of the active isolated view. */
interface ViewSpec {
  mode: "focus" | "calltree" | "radial";
  /** the node the view was opened from — its panel button renders pressed */
  rootId: string;
  keep: Set<string>;
  crumb: string;
  /** base-state positions, snapshotted BEFORE the view mutated anything */
  saved: PositionSnapshot;
  viewport: { zoom: number; pan: { x: number; y: number } };
  /** call tree only */
  fns?: Set<string>;
  levels?: number;
  touchedRows?: Set<string>;
  onlyTouched?: boolean;
  /** radial neighborhood only */
  radialResult?: ColumnUsageResult;
}
const radialSyntheticIds = new Set<string>();
/** the one pending readable-zoom nudge — re-entering a view cancels it */
let zoomNudge: number | undefined;
let hoverUnit: string | null = null;

function clearViewUiState(): void {
  hoverUnit = null;
  el("content").classList.remove("view-focus", "view-calltree", "view-radial");
  document
    .querySelectorAll("#focus-btn, #calltree-btn, #neighborhood-btn")
    .forEach((button) =>
      button.classList.remove("active-focus", "active-calltree", "active-neighborhood"),
    );
}

function qualifiedNodeLabel(node: NodeSingular): string {
  return `${node.data("schema") ?? ""}.${node.data("label")}`;
}

/** Crumb bar rendered FROM the spec; listeners dispatch by rootId, never
 *  through captured elements (stale after dematerialize/materialize). */
function renderCrumb(): void {
  const crumb = el("crumb");
  const view = activeView();
  if (!view) {
    crumb.classList.add("hidden");
    return;
  }
  crumb.classList.remove("hidden");
  const stepper =
    view.mode === "calltree"
      ? `<span class="crumb-opt">levels
           <button class="lvl-btn" id="crumb-lvl-dn" title="fewer levels">−</button>
           <span class="lvl-val">${view.levels ?? 2}</span>
           <button class="lvl-btn" id="crumb-lvl-up" title="more levels">+</button>
         </span>
         <label class="crumb-opt"><input type="checkbox" id="crumb-cols" ${
           view.onlyTouched !== false ? "checked" : ""
         } />touched columns only</label>`
      : "";
  crumb.innerHTML = `<span>${esc(view.crumb)}</span>${stepper}<button id="crumb-back">back</button>`;
  crumb
    .querySelector("#crumb-back")
    ?.addEventListener("click", () => exitView(view.mode !== "radial"));
  crumb.querySelector("#crumb-lvl-dn")?.addEventListener("click", () => {
    if ((view.levels ?? 2) > 1) showCallTreeById(view.rootId, (view.levels ?? 2) - 1);
  });
  crumb.querySelector("#crumb-lvl-up")?.addEventListener("click", () => {
    showCallTreeById(view.rootId, (view.levels ?? 2) + 1);
  });
  crumb.querySelector("#crumb-cols")?.addEventListener("change", (ev) => {
    if (view.mode !== "calltree") return;
    view.onlyTouched = (ev.target as HTMLInputElement).checked;
    applyCallTreePresentation();
  });
}

function hideCrumb(): void {
  el("crumb").classList.add("hidden");
}

/** Call-tree neatness: hide rows the chain doesn't touch (crumb toggle). */
function applyCallTreeColumnFilter(): void {
  const view = activeView();
  if (!cy || view?.mode !== "calltree") return;
  const onlyTouched = view.onlyTouched !== false;
  const touched = view.touchedRows ?? new Set<string>();
  adapterApplyCallTreeColumnFilter(cy, onlyTouched, touched);
}

/** Return to the canonical base state (no refit) — safe from any state. */
function leaveToBase(): void {
  const view = activeView();
  if (!cy || !view) return;
  const { saved, viewport } = view;
  removeOwnedElements(cy, radialSyntheticIds);
  activeMode = transitionActiveMode(activeMode, { type: "exit" }).state;
  window.clearTimeout(zoomNudge);
  clearViewUiState();
  dematerializeAll();
  resetViewState(cy);
  restoreViewPositions(cy, saved);
  hideCrumb();
  // re-establish what the view bypassed: edge-mode "all" re-materializes,
  // the isolated mask recomputes, stale view-anchored routing is replaced
  applyFilters();
  routeEdgesAroundCards();
  cy.viewport(viewport);
}

function exitView(refit: boolean): void {
  if (activeMode.kind !== "isolated") return;
  leaveToBase();
  if (refit) fitView();
}

/** Enter (or switch to) an isolated view: always base → spec. */
function enterView(spec: Omit<ViewSpec, "saved" | "viewport">): void {
  if (!cy) return;
  if (activeMode.kind === "matrix") closeUsageMatrix();
  else if (activeMode.kind === "isolated") leaveToBase();
  const saved = snapshotPositions(cy); // TRUE base positions, pre-mutation
  const viewport = { zoom: cy.zoom(), pan: { ...cy.pan() } };
  const view = { ...spec, saved, viewport };
  activeMode = transitionActiveMode(activeMode, { type: "enter-isolated", view }).state;
  resetViewState(cy); // strip selection highlights left in base
  clearViewUiState();
  applyKeepMask(cy, view.keep);
  el("content").classList.add(`view-${view.mode}`);
  renderCrumb();
}

/** 1-hop card neighborhood, isolated, re-laid-out, with the origin selected. */
function focusNode(node: NodeSingular): void {
  if (!cy) return;
  const unit = unitOf(node);
  const keep = new Set<string>([unit.id()]);
  cy.edges("[?agg]").forEach((e) => {
    if (edgeHidden(e as EdgeSingular)) return;
    if (e.source().id() === unit.id()) keep.add(e.target().id());
    if (e.target().id() === unit.id()) keep.add(e.source().id());
  });
  const label = qualifiedNodeLabel(node);
  enterView({ mode: "focus", rootId: node.id(), keep, crumb: `Focused: ${label} · 1 hop` });
  if (node.id() !== unit.id()) materializeNeighborhood(unit.id());
  else materializeCard(unit.id());
  applyFilters();
  // the focused ITEM is the star: when it's a row, collapse its (possibly
  // huge) table to the clicked row plus rows related outside the card —
  // a 200-column table must not dwarf the thing being focused
  if (node.id() !== unit.id()) {
    applyFocusedRowFilter(cy, node, unit, keep, unitOf);
  }
  runLayout();
  // leaveToBase (inside enterView) dematerializes rows: the clicked row node
  // may have been REMOVED and re-added — a stale reference has no edges, so
  // the panel would render "no connections". Re-resolve by id.
  const live = cy.getElementById(node.id());
  selectNode((live.nonempty() ? live : unit) as unknown as NodeSingular);
}

function showRadialNeighborhood(node: NodeSingular, result: ColumnUsageResult): void {
  if (!cy || node.data("type") !== "column") return;
  const rootId = node.id();
  const rootUnitId = unitOf(node).id();
  const rows = aggregateUsageRows(result.groups);
  const canvas = el("cy");
  const plan = buildRadialPlan(rows, canvas.clientWidth, canvas.clientHeight);
  const keep = new Set<string>([rootUnitId]);
  const visibleRows = new Map<string, UsageMatrixRow>();
  for (const category of ["reads", "writes", "structural"] as const) {
    for (const row of plan.visible[category]) {
      const unitId = cardOfNode.get(row.owner.id) ?? row.owner.id;
      if (unitId === rootUnitId || visibleRows.has(unitId)) continue;
      keep.add(unitId);
      visibleRows.set(unitId, row);
    }
  }
  enterView({
    mode: "radial",
    rootId,
    keep,
    radialResult: result,
    crumb: `Neighborhood: ${qualifiedNodeLabel(node)}`,
  });
  for (const id of keep) if (rowsByCard.has(id)) materializeCard(id);
  applyFilters();
  const liveRoot = cy.getElementById(rootId);
  const rootUnit = cy.getElementById(rootUnitId);
  if (liveRoot.nonempty() && rootUnit.nonempty()) {
    applyFocusedRowFilter(
      cy,
      liveRoot as unknown as NodeSingular,
      rootUnit as unknown as NodeSingular,
      keep,
      unitOf,
    );
  }
  restackRows();

  const radialItems: {
    id: string;
    category: UsageCategory;
    width: number;
    height: number;
  }[] = [];
  for (const [id, row] of visibleRows) {
    const unit = cy.getElementById(id);
    if (unit.empty() || !isShown(unit)) continue;
    const box = unit.boundingBox({ includeLabels: true, includeNodes: true });
    radialItems.push({ id, category: row.primary, width: box.w, height: box.h });
  }
  for (const category of ["reads", "writes", "structural"] as const) {
    const hidden = plan.hidden[category];
    if (hidden === 0) continue;
    const id = `__radial_${rootId}_${category}`;
    addRadialSummary(cy, radialSyntheticIds, {
      id,
      target: rootUnitId,
      label: `${category[0]!.toUpperCase() + category.slice(1)} +${hidden}`,
      category,
      kind: category === "reads" ? "reads" : category === "writes" ? "updates" : "fk",
    });
    radialItems.push({ id, category, width: 92, height: 26 });
  }

  const rootBox = rootUnit.boundingBox({ includeLabels: true, includeNodes: true });
  const positions = radialPositions(radialItems, rootBox.w, rootBox.h);
  moveUnitTo(rootUnit as unknown as NodeSingular, 0, 0);
  for (const item of radialItems) {
    const target = cy.getElementById(item.id);
    const position = positions.get(item.id);
    if (!position || target.empty()) continue;
    if (target.isNode() && target.isParent()) {
      moveUnitTo(target as unknown as NodeSingular, position.x, position.y);
    } else target.position(position);
  }
  restackRows();
  routeEdgesAroundCards();
  fitView(undefined, 64);
  const selected = cy.getElementById(rootId);
  selectNode((selected.nonempty() ? selected : rootUnit) as unknown as NodeSingular);
  revealOwnedRadialElements(cy, radialSyntheticIds);
}

/** Rebuild the call-tree presentation from the current spec — the crumb's
 *  column toggle re-runs this; the depth stepper re-enters the whole view. */
function applyCallTreePresentation(): void {
  const spec = activeView();
  if (!cy || spec?.mode !== "calltree") return;
  const keep = spec.keep;
  const fns = spec.fns ?? new Set<string>();
  const onlyTouched = spec.onlyTouched !== false;
  const onChain = (kind: string, srcUnit: string, tgtUnit: string, tgtId: string): boolean => {
    if (!keep.has(srcUnit) || !keep.has(tgtUnit)) return false;
    if (kind === "executes") return fns.has(tgtId) || fns.has(tgtUnit);
    if (kind === "calls") return fns.has(srcUnit) || fns.has(tgtUnit);
    if (DATA_KINDS.has(kind)) return fns.has(srcUnit);
    return false;
  };

  // A base "all" view may already have spent the full row budget on unrelated
  // cards. Rebuild detail from the call-tree set so the budget serves this view.
  dematerializeAll();
  // Prioritize the origin, then the call-chain order, but keep the same hard
  // row budget as the all-connections view. Oversized cards stay compact.
  const rootCard = cardOfNode.get(spec.rootId) ?? spec.rootId;
  const detailCards = [...keep].filter((id) => rowsByCard.has(id));
  detailCards.sort((a, b) => (a === rootCard ? -1 : b === rootCard ? 1 : 0));
  materializeWithinBudget(cy, materializationState(), detailCards);
  applyFilters();
  const touchedRows = collectCallTreeTouchedRows(cy, ROW_TYPES, unitOf, onChain);

  // tables the chain touches only at WHOLE-TABLE level (no column detail —
  // think regex-fallback inserts/deletes) have zero touched rows; hiding
  // all rows makes their compound render as NOTHING. Collapse them back to
  // compact virtual cards instead — the agg pass below still draws their
  // edges because no detail pair survives to suppress it.
  if (onlyTouched) {
    dematerializeCardsWithoutTouchedRows(cy, materializationState(), keep, touchedRows);
  }

  revealCallTreeEdges(cy, unitOf, onChain);
  spec.touchedRows = touchedRows;
  applyCallTreeColumnFilter();
  restackRows();
  layoutTree(cardUnits());
  routeEdgesAroundCards();
  fitView();
}

/** Crumb stepper entry point — resolves the live root by id. */
function showCallTreeById(id: string, levels: number): void {
  const n = cy?.getElementById(id);
  if (n && n.nonempty()) showCallTree(n as unknown as NodeSingular, levels);
}

/**
 * Call tree: from a trigger/function, follow executes/calls up to `levels`
 * deep, plus the root's direct callers for context, plus every table the
 * closure touches.
 */
function showCallTree(node: NodeSingular, levels = 2): void {
  if (!cy) return;
  const { fns, keep } = callTreeClosure(cy, node, levels);
  const label = qualifiedNodeLabel(node);
  // re-entering the same root (depth stepper) keeps the column-filter choice
  const view = activeView();
  const onlyTouched =
    view?.mode === "calltree" && view.rootId === node.id() ? view.onlyTouched !== false : true;
  enterView({
    mode: "calltree",
    rootId: node.id(),
    keep,
    fns,
    levels,
    onlyTouched,
    crumb: `Call tree: ${label}`,
  });
  applyCallTreePresentation();
  // leaveToBase (inside enterView) may have removed and re-created the
  // clicked row — re-resolve so panel/zoom see the live node
  const live = cy.getElementById(node.id());
  if (live.nonempty()) node = live as unknown as NodeSingular;

  // wide trees fit to specks — one readable-zoom nudge; entering any other
  // view first cancels it (stored handle + rootId guard)
  window.clearTimeout(zoomNudge);
  const rootId = node.id();
  zoomNudge = window.setTimeout(() => {
    if (!cy || activeView()?.rootId !== rootId || cy.zoom() >= 0.3) return;
    const root = cy.getElementById(rootId);
    if (root.nonempty()) {
      cy.animate({ zoom: 0.5, center: { eles: root }, duration: 200 } as never);
    }
  }, 300);
  renderPanel(node);
}

function wireHoverPreview(): void {
  if (!cy) return;
  cy.on("mouseover", "node", (ev) => {
    const unit = unitOf(ev.target as NodeSingular);
    if (hoverUnit === unit.id()) return;
    clearHoverReveal(cy!);
    hoverUnit = unit.id();
    setHoverReveal(unit);
  });
  cy.on("mouseout", "node", () => {
    hoverUnit = null;
    clearHoverReveal(cy!);
  });
  // cursor affordance: pointer over interactive nodes, default for panning
  const container = el("cy");
  cy.on("mouseover", "node", () => {
    container.style.cursor = "pointer";
  });
  cy.on("mouseout", "node", () => {
    container.style.cursor = "";
  });
}

// ── panel ──

function renderPanel(node: NodeSingular): void {
  const d = node.data() as GraphNodeData;
  const view = activeView();
  const panelCy = cy;
  const panelMode = activeMode;
  const generation = ++panelRenderGeneration;
  el("panel").classList.remove("hidden");
  requestAnimationFrame(() => {
    if (
      !panelCy ||
      cy !== panelCy ||
      activeMode !== panelMode ||
      generation !== panelRenderGeneration ||
      node.removed()
    ) {
      return;
    }
    panelCy.resize();
    if (view?.mode === "radial") {
      // Opening the details panel narrows the canvas. Preserve the complete
      // neighborhood instead of re-centering the root and clipping a sector.
      fitView(undefined, 64);
    } else if (d.type === "column" && activeMode.kind === "base") {
      panelCy.stop();
      panelCy.zoom(Math.max(panelCy.zoom(), 0.95));
      panelCy.center(node);
    } else panelCy.animate({ center: { eles: node }, duration: 180 } as never);
  });
  const panel = el("panel-body");
  postToHost({ type: "nodeSelected", id: node.id() });
  const connections = connectionList.render(node);
  const ownerTable = ROW_TYPES.has(d.type) ? String(node.parent().first().data("label") ?? "") : "";
  const where = ownerTable ? `${d.schema ?? ""}.${ownerTable}` : (d.schema ?? "");
  const canCallTree = d.type === "function" || d.type === "trigger";
  const hasColumnUsage = d.type === "column" && selectedColumnUsage?.columnId === node.id();
  panel.innerHTML = `
    <button class="close" id="panel-close" title="Close details" aria-label="Close details">x</button>
    <h2>${esc(d.label)}</h2>
    <p class="meta">
      <span class="chip" style="background:${NODE_COLORS[d.type] ?? "#888"}">${esc(d.type)}</span>
      <span>${esc(where)}</span>
    </p>
    ${d.detail ? `<p class="detail">${esc(d.detail)}</p>` : ""}
    <div class="actions">
      ${d.type === "schema" ? "" : '<button id="def-btn" title="jump to source definition (.hcl, up.sql, then DDL)">Go to definition</button><button id="ddl-btn">Open DDL</button>'}
      <button id="focus-btn" class="${view?.mode === "focus" && view.rootId === node.id() ? "active-focus" : ""}">Focus</button>
      ${canCallTree ? `<button id="calltree-btn" class="${view?.mode === "calltree" && view.rootId === node.id() ? "active-calltree" : ""}">Call tree</button>` : ""}
      ${d.type === "column" ? `<button id="neighborhood-btn" ${hasColumnUsage ? "" : "disabled"} class="${view?.mode === "radial" && view.rootId === node.id() ? "active-neighborhood" : ""}">Neighborhood</button><button id="matrix-btn" ${hasColumnUsage ? "" : "disabled"} class="${activeMatrix()?.result.columnId === node.id() ? "active-matrix" : ""}">Usage matrix</button>` : ""}
    </div>
    ${d.type === "column" ? `<section id="column-usages" data-column-id="${esc(node.id())}" aria-live="polite"><p class="usage-empty">Loading usages...</p></section>` : ""}
    ${connections}`;
  panel.querySelector("#panel-close")?.addEventListener("click", () => {
    if (activeMode.kind === "isolated") {
      // keep the view, just dismiss the panel — clearSelection in focus mode
      // re-selects the origin, which would immediately reopen it
      if (cy) clearHotEdges(cy);
      hidePanel();
    } else {
      clearSelection();
    }
  });

  // parent lookups resolved NOW, while the node is live — the panel outlives
  // view transitions that remove row nodes, and traversal on a removed
  // element returns nothing
  const ddlTarget = d.type === "column" ? (node.parent().first().data() as GraphNodeData) : d;
  panel.querySelector("#ddl-btn")?.addEventListener("click", () => {
    const td = ddlTarget;
    postToHost({
      type: "openDdl",
      nodeType: td.type,
      oid: td.oid,
      schema: td.schema ?? "",
      name: td.label,
      label: `${td.schema ?? ""}.${td.label}`,
    });
  });
  panel.querySelector("#def-btn")?.addEventListener("click", () => {
    const owner = ownerTable; // resolved at render time — see ddlTarget note
    postToHost({
      type: "openDefinition",
      nodeType: d.type,
      oid: d.oid,
      schema: d.schema ?? "",
      name: d.label,
      owner,
      label: `${d.schema ?? ""}.${d.label}`,
    });
  });
  if (d.type === "column") {
    if (hasColumnUsage && selectedColumnUsage) renderColumnUsages(selectedColumnUsage);
    else {
      activeColumnUsageRequest = ++usageRequestId;
      postToHost({
        type: "requestColumnUsages",
        revision: graphRevision,
        requestId: activeColumnUsageRequest,
        columnId: node.id(),
      });
    }
  }
  // exiting/entering a view removes and re-adds row nodes — every handler
  // must re-resolve by id, never act on the node captured at render time
  const liveNode = (id: string): NodeSingular | null => {
    const direct = cy?.getElementById(id);
    if (direct && direct.nonempty()) return direct as unknown as NodeSingular;
    const card = cardOfNode.get(id);
    const fallback = card ? cy?.getElementById(card) : undefined;
    return fallback && fallback.nonempty() ? (fallback as unknown as NodeSingular) : null;
  };
  // toggles: pressing the active view's button on its origin node exits it
  panel.querySelector("#focus-btn")?.addEventListener("click", () => {
    const id = node.id();
    const view = activeView();
    if (view?.mode === "focus" && view.rootId === id) {
      exitView(true);
      const live = liveNode(id);
      if (live) selectNode(live);
    } else {
      const live = liveNode(id);
      if (live) focusNode(live);
    }
  });
  panel.querySelector("#calltree-btn")?.addEventListener("click", () => {
    const id = node.id();
    const view = activeView();
    if (view?.mode === "calltree" && view.rootId === id) {
      exitView(true);
      const live = liveNode(id);
      if (live) selectNode(live);
    } else {
      const live = liveNode(id);
      if (live) showCallTree(live);
    }
  });
  panel.querySelector("#neighborhood-btn")?.addEventListener("click", () => {
    const id = node.id();
    const view = activeView();
    if (view?.mode === "radial" && view.rootId === id) {
      exitView(false);
      const live = liveNode(id);
      if (live) selectNode(live);
      return;
    }
    const result = selectedColumnUsage?.columnId === id ? selectedColumnUsage : null;
    const live = liveNode(id);
    if (result && live) showRadialNeighborhood(live, result);
  });
  panel.querySelector("#matrix-btn")?.addEventListener("click", () => {
    const id = node.id();
    const result = selectedColumnUsage?.columnId === id ? selectedColumnUsage : null;
    if (!result) return;
    if (activeMatrix()?.result.columnId === id) closeUsageMatrix();
    else showUsageMatrix(result);
  });
}

/** Isolate one schema's tables/views/functions (clicking a schema in the tree). */
function focusSchema(s: NodeSingular): void {
  if (!cy) return;
  const name = String(s.data("label"));
  const keep = new Set<string>();
  for (const u of coreCardUnits(cy)) {
    if (String(u.data("schema") ?? "") === name) keep.add(u.id());
  }
  enterView({ mode: "focus", rootId: s.id(), keep, crumb: `Schema: ${name}` });
  applyFilters();
  runLayout();
}

/** Tree click → focus view on that node (schemas isolate the whole schema). */
function jumpToNode(id: string): void {
  if (!cy) return;
  if (activeMode.kind === "matrix") closeUsageMatrix();
  const target = cy.getElementById(id);
  if (target.nonempty() && target.data("type") === "schema") {
    focusSchema(target as unknown as NodeSingular);
    return;
  }
  exitView(false);
  // virtual rows only exist in cy once their card is materialized
  const card = cardOfNode.get(id);
  if (card && !materialized.has(card)) materializeCard(card);
  const ele = cy.getElementById(id);
  if (ele.empty()) return;
  focusNode(ele as unknown as NodeSingular);
}

function updateStats(): void {
  if (!cy) return;
  const units = coreCardUnits(cy);
  const visibleUnits = units.filter((node) => isShown(node)).length;
  const visibleEdges = cy
    .edges()
    .filter((edge) => edgeShownForRouting(edge as EdgeSingular)).length;
  const activeFilters =
    prefs.filterSchemas.length + prefs.filterNodeTypes.length + prefs.filterEdgeKinds.length;
  const rowCounts = materializationRowCounts(materializationState());
  const parts = [
    `${visibleUnits}/${units.length} objects`,
    `${visibleEdges} connections`,
    activeFilters > 0 ? `${activeFilters} filters` : "",
    edgeMode() === "all" && rowCounts.materialized < rowCounts.total
      ? `detail budget ${rowCounts.materialized}/${rowCounts.total}`
      : "",
    limitedCards.size > 0 ? `${limitedCards.size} compact at detail limit` : "",
    routingLimited > 0 ? `${routingLimited} routes omitted` : "",
  ].filter(Boolean);
  const text = `${database ? `${database} · ` : ""}${parts.join(" · ")}`;
  // on-canvas overlay (bottom-right, like the legend)…
  el("stats").textContent = text;
  // …and the extension mirrors it into the status bar tooltip
  postToHost({ type: "stats", text });
}

function buildLegend(): void {
  if (!cy) {
    el("legend").textContent = "";
    return;
  }
  const nodeTypes = new Set(
    cy
      .nodes()
      .filter((node) => isShown(node as NodeSingular) && node.data("type") !== "schema")
      .map((node) => String(node.data("type"))),
  );
  const edgeKinds = new Set<string>();
  cy.edges("[?agg]").forEach((edge) => {
    if (!edgeShownByClasses(edge as EdgeSingular)) return;
    const kinds = edge.data("kinds") as Record<string, number> | undefined;
    for (const kind of kinds ? Object.keys(kinds) : [String(edge.data("kind"))]) {
      if (prefs.filterEdgeKinds.length === 0 || prefs.filterEdgeKinds.includes(kind as EdgeKind)) {
        edgeKinds.add(kind);
      }
    }
  });
  const groups = [
    { name: "data", color: EDGE_COLORS.reads, kinds: DATA_KINDS },
    { name: "calls", color: EDGE_COLORS.calls, kinds: new Set(["calls", "executes"]) },
    {
      name: "structure",
      color: EDGE_COLORS.fk,
      kinds: new Set(["fk", "constrains", "indexes", "default", "update-of"]),
    },
  ];
  const items = [
    ...Object.entries(NODE_COLORS)
      .filter(([name]) => nodeTypes.has(name))
      .map(
        ([name, color]) => `<span><i class="dot" style="background:${color}"></i>${name}</span>`,
      ),
    ...groups
      .filter((group) => [...group.kinds].some((kind) => edgeKinds.has(kind)))
      .map(
        (group) =>
          `<span><i class="line" style="background:${group.color}"></i>${group.name}</span>`,
      ),
  ];
  el("legend").innerHTML = items.join("");
  el("reset-filters").classList.toggle(
    "hidden",
    prefs.filterSchemas.length + prefs.filterNodeTypes.length + prefs.filterEdgeKinds.length === 0,
  );
}

// ── wiring ──

/** A reveal that arrived before the graph did — applied right after render. */
let pendingRevealId: string | null = null;

/**
 * Apply a prefs update from the extension, doing the minimal cytoscape work
 * for whatever actually changed (a full re-render is far too heavy for a
 * single toggle). Diffed against the previous mirror, then the mirror is
 * advanced.
 */
function applyPrefs(next: Prefs): void {
  const prev = prefs;
  prefs = next;
  if (!cy) return;
  const nodeTypesChanged = !sameList(next.filterNodeTypes, prev.filterNodeTypes);
  const layoutChanged = next.layout !== prev.layout || next.engine !== prev.engine;
  const edgeModeChanged = next.edgeMode !== prev.edgeMode;
  const schemaGroupChanged = next.schemaGroup !== prev.schemaGroup;
  const routeChanged = next.route !== prev.route;
  const emphasisChanged = next.emphasizeConnections !== prev.emphasizeConnections;
  const filtersChanged =
    !sameList(next.filterSchemas, prev.filterSchemas) ||
    nodeTypesChanged ||
    !sameList(next.filterEdgeKinds, prev.filterEdgeKinds);
  const visibilityChanged = next.hideIsolated !== prev.hideIsolated || filtersChanged;
  if (nodeTypesChanged) {
    const rematerialize = [...materialized];
    dematerializeAll();
    for (const id of rowsByCard.keys()) {
      const definition = nodeDefById.get(id);
      if (!definition) continue;
      buildCardArt(definition);
      const card = cy.getElementById(id);
      if (card.nonempty()) {
        card.data("svg", definition.data.svg);
        card.data("cardW", definition.data.cardW);
        card.data("cardH", definition.data.cardH);
      }
    }
    for (const id of rematerialize) materializeCard(id);
  }

  if (
    activeMode.kind === "base" &&
    ((edgeModeChanged && prev.edgeMode === "all") || (filtersChanged && next.edgeMode === "all"))
  ) {
    dematerializeAll();
    limitedCards.clear();
  }

  if (schemaGroupChanged) applySchemaGrouping(false);
  if (activeView()?.mode === "calltree" && (layoutChanged || nodeTypesChanged)) {
    applyCallTreePresentation();
    return;
  }

  const needsFilter = edgeModeChanged || schemaGroupChanged || visibilityChanged || emphasisChanged;
  const needsLayout = schemaGroupChanged || layoutChanged;
  const needsRoute = edgeModeChanged || routeChanged || visibilityChanged;
  if (needsFilter) applyFilters();
  if (needsLayout) runLayout();
  else if (needsRoute) routeEdgesAroundCards();

  if ((edgeModeChanged || visibilityChanged) && !el("panel").classList.contains("hidden")) {
    const selected = primarySelectedNode(cy);
    if (selected) renderPanel(selected);
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** searchGraph picker → light a card and centre on it (selection only, no view). */
function searchSelect(id: string): void {
  if (!cy) return;
  if (activeMode.kind === "matrix") closeUsageMatrix();
  const card = cardOfNode.get(id);
  if (activeMode.kind === "isolated") exitView(false);
  if (card) {
    materializeNeighborhood(card);
    applyFilters();
  }
  const ele = cy.getElementById(id);
  if (ele.empty()) return;
  selectNode(ele as unknown as NodeSingular);
}

/** tree "Call Tree" → show the call tree for a function/trigger, else focus it. */
function callTreeById(id: string): void {
  if (!cy) return;
  if (activeMode.kind === "matrix") closeUsageMatrix();
  exitView(false);
  const card = cardOfNode.get(id);
  if (card && !materialized.has(card)) materializeCard(card);
  const ele = cy.getElementById(id);
  if (ele.empty()) return;
  const node = ele as unknown as NodeSingular;
  const t = String(node.data("type"));
  if (t === "function" || t === "trigger") showCallTree(node);
  else focusNode(node);
}

function exportPng(): void {
  requestAnimationFrame(() => {
    const dataUri = graphExporter.png();
    if (dataUri) postToHost({ type: "pngExport", dataUri });
  });
}

function exportSvg(): void {
  requestAnimationFrame(() => {
    const svg = graphExporter.svg();
    if (svg) postToHost({ type: "svgExport", svg });
  });
}

window.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data as HostToWebviewMessage;
  if (msg.type === "graph") {
    database = msg.database ?? "";
    graphRevision = msg.revision;
    usageGroups.clear();
    occurrenceRequestGroups.clear();
    render(msg.graph);
    if (pendingRevealId) {
      const id = pendingRevealId;
      pendingRevealId = null;
      jumpToNode(id);
    }
  } else if (msg.type === "columnUsages") {
    if (msg.revision === graphRevision && msg.requestId === activeColumnUsageRequest) {
      renderColumnUsages(msg.result);
    }
  } else if (msg.type === "usageOccurrences") {
    if (msg.revision === graphRevision) renderUsageOccurrencePage(msg.page, msg.requestId);
  } else if (msg.type === "clear") {
    cy?.destroy();
    cy = null;
    activeMode = BASE_ACTIVE_MODE;
    radialSyntheticIds.clear();
    window.clearTimeout(zoomNudge);
    clearViewUiState();
    selectedColumnUsage = null;
    usageGroups.clear();
    occurrencePages.clear();
    occurrenceRequestGroups.clear();
    el("content").classList.remove("view-matrix");
    el("usage-matrix").classList.add("hidden");
    el("cy").classList.remove("hidden");
    el("canvas-footer").classList.remove("hidden");
    hidePanel();
    hideCrumb();
    el("empty").style.display = "flex";
    el("empty").textContent = msg.message;
  } else if (msg.type === "prefs") {
    applyPrefs(normalizePrefs(msg.prefs));
  } else if (msg.type === "reveal") {
    if (cy) jumpToNode(String(msg.id ?? ""));
    else pendingRevealId = String(msg.id ?? "");
  } else if (msg.type === "searchSelect") {
    searchSelect(String(msg.id ?? ""));
  } else if (msg.type === "callTreeById") {
    callTreeById(String(msg.id ?? ""));
  } else if (msg.type === "fit") {
    fitView(undefined, 40);
  } else if (msg.type === "relayout") {
    runLayout();
  } else if (msg.type === "exitView") {
    if (activeMode.kind === "matrix") closeUsageMatrix();
    else if (activeMode.kind === "isolated") exitView(true);
  } else if (msg.type === "exportPng") {
    exportPng();
  } else if (msg.type === "exportSvg") {
    exportSvg();
  } else if (msg.type === "status") {
    if (!cy) {
      el("empty").style.display = "flex";
      el("empty").textContent = String(msg.message ?? "");
    }
  } else if (msg.type === "error") {
    if (!cy) {
      el("empty").style.display = "flex";
      el("empty").textContent = `Error: ${msg.message ?? "unknown"}`;
    }
  }
});

new GraphKeyboardNavigator({
  surface: el("cy") as unknown as GraphKeyboardNavigatorOptions["surface"],
  graph: () => cy,
  units: cardUnits,
  onFocus: (next) => {
    const graph = cy;
    if (!graph) return;
    graph.nodes().unselect();
    next.select();
    graph.animate({ center: { eles: next }, duration: 120 } as never);
  },
  onOpen: selectNode,
});

window.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (activeMode.kind === "matrix") closeUsageMatrix();
  else exitView(true);
});

// search / layout / edge-mode / filters / fit / relayout / refresh are all
// driven natively now — QuickPicks and title-bar actions post messages handled
// above. The webview only owns the canvas, crumb, legend, details panel.

// side panel resize: drag the left edge (no native webview splitter exists)
{
  const panelEl = el("panel");
  const handle = el("panel-resize");
  let resizing = false;
  const setPanelWidth = (width: number): void => {
    const bounded = Math.min(680, Math.max(220, width), Math.max(220, window.innerWidth - 80));
    panelEl.style.width = `${bounded}px`;
    handle.setAttribute("aria-valuenow", String(Math.round(bounded)));
    cy?.resize();
  };
  const stopResizing = (): void => {
    resizing = false;
  };
  handle.addEventListener("pointerdown", (ev) => {
    resizing = true;
    handle.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  handle.addEventListener("pointermove", (ev) => {
    if (!resizing) return;
    setPanelWidth(window.innerWidth - ev.clientX - 8);
  });
  handle.addEventListener("pointerup", (ev) => {
    stopResizing();
    if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
  });
  handle.addEventListener("pointercancel", stopResizing);
  handle.addEventListener("lostpointercapture", stopResizing);
  handle.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    const current = panelEl.getBoundingClientRect().width;
    setPanelWidth(current + (ev.key === "ArrowLeft" ? 24 : -24));
    ev.preventDefault();
  });
}
el<HTMLInputElement>("matrix-search").addEventListener("input", (event) => {
  const matrix = activeMatrix();
  if (!matrix) return;
  matrix.search = (event.target as HTMLInputElement).value;
  matrix.limit = 100;
  matrix.expanded = undefined;
  renderUsageMatrix();
});
el("matrix-categories").addEventListener("click", (event) => {
  const matrix = activeMatrix();
  if (!matrix) return;
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-matrix-category]",
  );
  const category = button?.dataset.matrixCategory as UsageCategory | "all" | undefined;
  if (!category) return;
  matrix.category = category;
  matrix.limit = 100;
  matrix.expanded = undefined;
  renderUsageMatrix();
});
el("matrix-scroll").addEventListener("click", (event) => {
  const matrix = activeMatrix();
  if (!matrix) return;
  const target = event.target as HTMLElement;
  if (target.closest("button[data-occurrence-id], button[data-usage-group]")) {
    handleUsageClick(event);
    return;
  }
  const ownerButton = target.closest<HTMLButtonElement>("button[data-matrix-owner-definition]");
  if (ownerButton?.dataset.matrixOwnerDefinition) {
    const row = matrix.rows.find(
      (candidate) => candidate.owner.id === ownerButton.dataset.matrixOwnerDefinition,
    );
    if (row?.groups[0]) openUsageOwner(row.groups[0]);
    return;
  }
  const cell = target.closest<HTMLButtonElement>("button[data-matrix-cell]");
  if (cell?.dataset.matrixOwner && cell.dataset.matrixCell) {
    const next = {
      ownerId: cell.dataset.matrixOwner,
      category: cell.dataset.matrixCell as UsageCategory,
    };
    matrix.expanded =
      matrix.expanded?.ownerId === next.ownerId && matrix.expanded.category === next.category
        ? undefined
        : next;
    renderUsageMatrix();
    return;
  }
  if (target.closest("#matrix-more")) {
    matrix.limit += 100;
    renderUsageMatrix();
  }
});
buildLegend();
el("reset-filters").addEventListener("click", () => postToHost({ type: "resetFilters" }));
postToHost({ type: "ready" });
