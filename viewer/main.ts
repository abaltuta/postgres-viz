import {
  readSnapshot,
  type Relationship,
  type Snapshot,
  type SnapshotObject,
} from "./snapshot";
import { SnapshotIndex } from "./snapshot-index";
import { objectLabel, referenceLabel } from "./reference-label";

declare const acquireVsCodeApi: undefined | (() => { postMessage(value: unknown): void });
const host = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
const tabs = [
  "Schema overview",
  "Orbital map",
  "Dependency matrix",
  "Arc diagram",
  "Reference index",
  "Object explorer",
  "Visual neighborhood",
] as const;
type Tab = (typeof tabs)[number];
type Pair = ReturnType<SnapshotIndex["objectPairs"]>[number];
const colors = ["#c18da6", "#a99ccb", "#80aca4", "#c3ac75", "#8da8c2", "#c39985"];
const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const workspace = $("#workspace");
const picker = $<HTMLInputElement>("#file");
let data: Snapshot;
let index: SnapshotIndex;
let objects = new Map<string, SnapshotObject>();
let columns = new Map<string, Snapshot["columns"][number]>();
let columnsByObject = new Map<string, Snapshot["columns"]>();
let groups = new Map<string, SnapshotObject[]>();
let pairs: Pair[] = [];
const hiddenKinds = new Set<SnapshotObject["kind"]>();
const hiddenObjects = new Set<string>();
const titles = {
  table: "Tables",
  foreign: "Foreign tables",
  view: "Views",
  matview: "Materialized views",
  function: "Functions",
  procedure: "Procedures",
  constraint: "Constraints",
  index: "Indexes",
  trigger: "Triggers",
} satisfies Record<SnapshotObject["kind"], string>;
function endpointObject(id: string) {
  return objects.get(columns.get(id)?.objectId ?? id)!;
}
function visibleEndpoint(id: string) {
  const object = endpointObject(id);
  return !hiddenObjects.has(object.id) && !hiddenKinds.has(object.kind);
}
function crossesOwners(p: Pair) {
  return index.owner(p.source) !== index.owner(p.target);
}
function visibleGroups() {
  const result = new Map<string, SnapshotObject[]>();
  for (const [schema, items] of groups) {
    const visible = items.filter((o) => visibleEndpoint(o.id));
    if (visible.length) result.set(schema, visible);
  }
  return result;
}
function visibilityControls() {
  const controls = $("#visibility .tools");
  controls.replaceChildren();
  const present = new Set(data.objects.map((o) => o.kind));
  const summary = $("#visibility summary");
  const reset = button(controls, "Show all", () => {
    hiddenObjects.clear();
    hiddenKinds.clear();
    visibilityControls();
    draw();
  });
  function describeVisibility() {
    const count = [...present].filter((kind) => !hiddenKinds.has(kind)).length;
    const filtered = [];
    if (count !== present.size) filtered.push(`${count} of ${present.size} types`);
    if (hiddenObjects.size) filtered.push(`${hiddenObjects.size} individually hidden`);
    reset.hidden = !filtered.length;
    summary.textContent =
      "Diagram visibility" + (filtered.length ? " (" + filtered.join(", ") + ")" : "");
  }
  describeVisibility();
  for (const kind of Object.keys(titles) as (keyof typeof titles)[]) {
    if (!present.has(kind)) continue;
    const label = el(controls, "label");
    const input = el(label, "input");
    input.type = "checkbox";
    input.value = kind;
    input.checked = !hiddenKinds.has(kind);
    label.append(titles[kind]);
    input.onchange = () => {
      if (input.checked) hiddenKinds.delete(kind);
      else hiddenKinds.add(kind);
      describeVisibility();
      draw();
    };
  }
  controls.append(reset);
}
function objectVisibility(parent: HTMLElement) {
  const hidden = hiddenObjects.has(objectId);
  const control = button(
    parent,
    hidden ? "Show object in diagrams" : "Hide object from diagrams",
    () => {
      if (hidden) hiddenObjects.delete(objectId);
      else hiddenObjects.add(objectId);
      visibilityControls();
      draw();
    },
  );
  control.disabled = hiddenKinds.has(objects.get(objectId)!.kind);
}
let tab: Tab = tabs[0];
let objectId = "",
  columnId = "",
  schema = "",
  targetSchema: string | undefined;
let pair: Pair | undefined,
  path: Relationship[] = [];
let depth: 1 | 2 = 2,
  direction: "incoming" | "outgoing" = "incoming";
let visualDirection: typeof direction | "both" = "both";
let filter = "",
  zoom = 1,
  revision = 0,
  fromHost = false;

function el<K extends keyof HTMLElementTagNameMap>(
  parent: Element,
  tag: K,
  text?: string,
  cls?: string,
) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  parent.append(node);
  return node;
}
function button(parent: Element, label: string, fn: () => void, cls?: string, active?: boolean) {
  const node = el(parent, "button", label, cls);
  node.onclick = fn;
  if (active !== undefined) node.setAttribute("aria-pressed", String(active));
  return node;
}
function options(
  parent: Element,
  label: string,
  choices: [string, string][],
  value: string,
  change: (value: string) => void,
) {
  const wrap = el(parent, "label", label + " ");
  const select = el(wrap, "select");
  for (const [id, name] of choices) select.add(new Option(name, id));
  select.value = value;
  select.onchange = () => change(select.value);
}
function label(id: string): string {
  return referenceLabel(id, objects, columns);
}
function swatch(name: string) {
  return colors[[...groups.keys()].indexOf(name) % colors.length]!;
}
function openEndpoint(id: string, next: Tab = tab) {
  const column = columns.get(id);
  objectId = column?.objectId ?? id;
  columnId = column?.id ?? "";
  pair = undefined;
  path = [];
  tab = next;
  draw();
}
function openPair(value: Pair) {
  pair = value;
  objectId = value.source;
  columnId = "";
  path = [];
  draw();
}
function error(message: string) {
  const node = $<HTMLElement>("#error");
  node.textContent = message;
  node.hidden = !message;
}
function load(value: unknown, preserve: boolean, hosted: boolean) {
  const next = readSnapshot(value);
  const nextIndex = new SnapshotIndex(next);
  preserve = preserve && data.database === next.database;
  const previousObjects = objects;
  const previousColumns = columns;
  data = next;
  index = nextIndex;
  fromHost = hosted;
  objects = new Map(next.objects.map((o) => [o.id, o]));
  columns = new Map(next.columns.map((c) => [c.id, c]));
  function sameEndpoint(id: string): boolean {
    const oldColumn = previousColumns.get(id);
    if (oldColumn) {
      const current = columns.get(id);
      return (
        current?.name === oldColumn.name &&
        current.objectId === oldColumn.objectId &&
        sameEndpoint(current.objectId)
      );
    }
    const oldObject = previousObjects.get(id);
    const current = objects.get(id);
    return (
      !!oldObject &&
      !!current &&
      oldObject.kind === current.kind &&
      oldObject.name === current.name &&
      oldObject.schema === current.schema &&
      oldObject.parentId === current.parentId &&
      (!current.parentId || sameEndpoint(current.parentId))
    );
  }
  columnsByObject = new Map();
  for (const c of next.columns) {
    if (!columnsByObject.has(c.objectId)) columnsByObject.set(c.objectId, []);
    columnsByObject.get(c.objectId)!.push(c);
  }
  for (const group of columnsByObject.values()) group.sort((a, b) => a.position - b.position);
  groups = new Map();
  for (const o of index.inventory()) {
    if (!groups.has(o.schema)) groups.set(o.schema, []);
    groups.get(o.schema)!.push(o);
  }
  pairs = index.objectPairs({ groupNested: false });
  if (!preserve) {
    hiddenObjects.clear();
    hiddenKinds.clear();
    tab = tabs[0];
    filter = "";
    direction = "incoming";
    visualDirection = "both";
    depth = 2;
    zoom = 1;
  }
  for (const id of hiddenObjects) if (!objects.has(id)) hiddenObjects.delete(id);
  if (
    !preserve ||
    !path.every(
      (r) =>
        sameEndpoint(r.source) &&
        sameEndpoint(r.target) &&
        (!r.constraintId || sameEndpoint(r.constraintId)),
    )
  )
    path = [];
  if (!preserve || !objects.has(objectId)) objectId = next.objects[0]?.id ?? "";
  if (!preserve || columns.get(columnId)?.objectId !== objectId) columnId = "";
  if (!preserve || !groups.has(schema)) schema = objects.get(objectId)?.schema ?? "";
  targetSchema = undefined;
  const previousPair = pair;
  pair =
    preserve &&
    previousPair &&
    sameEndpoint(previousPair.source) &&
    sameEndpoint(previousPair.target)
      ? pairs.find((p) => p.source === previousPair.source && p.target === previousPair.target)
      : undefined;
  error("");
  visibilityControls();
  $("h1").textContent = next.database;
  $("#stats").textContent = [
    groups.size + " schemas",
    objects.size + " objects",
    columns.size + " columns",
    pairs.filter(crossesOwners).length + " external object links",
  ].join(" / ");
  draw();
}
function parse(text: string, preserve: boolean, hosted: boolean) {
  load(JSON.parse(text), preserve, hosted);
}
function fail(err: unknown) {
  error(err instanceof Error ? err.message : String(err));
}
picker.onchange = async () => {
  const file = picker.files?.[0];
  if (!file) return;
  const ticket = ++revision;
  try {
    const text = await file.text();
    if (ticket === revision) parse(text, false, false);
  } catch (err) {
    if (ticket === revision) fail(err);
  } finally {
    if (ticket === revision) picker.value = "";
  }
};
$<HTMLSelectElement>("#mode").onchange = (event) => {
  document.documentElement.dataset.mode = (event.target as HTMLSelectElement).value;
};
if (host) {
  window.addEventListener("message", ({ data: msg }) => {
    if (msg?.type === "snapshot") {
      ++revision;
      try {
        if (typeof msg.text === "string")
          parse(msg.text, fromHost && msg.preserveSelection !== false, true);
        else load(msg.snapshot, fromHost && msg.preserveSelection !== false, true);
      } catch (err) {
        fail(err);
      }
    } else if (msg?.type === "error") error(String(msg.message));
  });
  host.postMessage({ type: "ready" });
} else if (new URLSearchParams(location.search).get("source") === "cli") {
  const ticket = ++revision;
  fetch("./snapshot.json")
    .then(async (response) => {
      if (!response.ok) throw Error("Snapshot request failed (" + response.status + ")");
      const text = await response.text();
      if (ticket === revision) parse(text, false, false);
    })
    .catch((err) => {
      if (ticket === revision) fail(err);
    });
}

function draw() {
  const nav = $("nav");
  if (!nav.childElementCount)
    for (const title of tabs)
      button(nav, title, () => {
        tab = title;
        path = [];
        draw();
      });
  for (const b of nav.children) {
    if (b.textContent === tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  workspace.replaceChildren();
  $<HTMLDetailsElement>("#visibility").hidden = !objects.size || tab === tabs[5];
  if (!objects.size) {
    el(workspace, "p", "This snapshot contains no objects.", "muted");
    return;
  }
  if (tab === tabs[0]) overview();
  else if (tab === tabs[5] || tab === tabs[6]) explorer();
  else maps();
}
function layout(cls = "") {
  const grid = el(workspace, "div", undefined, "layout " + cls);
  return [el(grid, "section"), el(grid, "aside")] as const;
}
function catalogSections(
  parent: HTMLElement,
  items: SnapshotObject[],
  render: (group: HTMLElement, item: SnapshotObject) => void,
) {
  for (const [kind, title] of Object.entries(titles)) {
    const members = items.filter((o) => o.kind === kind);
    if (!members.length) continue;
    const group = el(parent, "section", undefined, "catalog-section");
    el(group, "h3", title);
    for (const item of members.sort((a, b) => label(a.id).localeCompare(label(b.id))))
      render(group, item);
  }
}
function overview() {
  const shownGroups = visibleGroups();
  const external = pairs.filter(crossesOwners);
  const shownPairs = external.filter((p) => visibleEndpoint(p.source) && visibleEndpoint(p.target));
  const [main, aside] = layout();
  el(main, "h2", "Schemas");
  const cards = el(main, "div", undefined, "cards");
  const kinds = [...new Set(data.objects.map((o) => o.kind))].filter(
    (kind) => !hiddenKinds.has(kind),
  );
  const degree = new Map<string, number>();
  for (const p of shownPairs)
    for (const id of [p.source, p.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
  if (!shownGroups.size) el(main, "p", "No visible objects.", "muted");
  for (const [name, items] of shownGroups) {
    const card = button(
      cards,
      "",
      () => {
        schema = name;
        targetSchema = undefined;
        draw();
      },
      "card",
      name === schema && targetSchema === undefined,
    );
    card.style.setProperty("--swatch", swatch(name));
    el(card, "strong", name, "mono");
    el(card, "small", items.length + " objects");
    const bar = el(card, "span", undefined, "bar");
    for (const [i, kind] of kinds.entries()) {
      const count = items.filter((o) => o.kind === kind).length;
      if (count) {
        const part = el(bar, "i");
        part.style.flex = String(count);
        part.style.setProperty("--swatch", colors[i % colors.length]!);
        part.title = count + " " + kind;
      }
    }
    const hub = items.reduce((a, b) =>
      (degree.get(a.id) ?? 0) >= (degree.get(b.id) ?? 0) ? a : b,
    );
    el(card, "small", hub.name + " · " + (degree.get(hub.id) ?? 0) + " links");
  }
  const legend = el(main, "div", undefined, "key");
  kinds.forEach((k, i) =>
    el(legend, "span", k).style.setProperty("--swatch", colors[i % colors.length]!),
  );
  el(main, "h2", "Schema dependencies");
  el(main, "p", "Read across a row to see which schemas it depends on.", "muted");
  const table = el(el(main, "div", undefined, "pan"), "table");
  const head = el(table, "tr");
  el(head, "th", "From / to");
  for (const name of shownGroups.keys()) el(head, "th", name);
  const counts = new Map<string, Map<string, number>>();
  for (const p of shownPairs) {
    const a = objects.get(p.source)!.schema,
      b = objects.get(p.target)!.schema;
    if (!counts.has(a)) counts.set(a, new Map());
    const row = counts.get(a)!;
    row.set(b, (row.get(b) ?? 0) + 1);
  }
  for (const name of shownGroups.keys()) {
    const row = el(table, "tr");
    el(row, "th", name);
    for (const target of shownGroups.keys()) {
      const count = counts.get(name)?.get(target) ?? 0;
      const b = button(
        el(row, "td"),
        String(count),
        () => {
          schema = name;
          targetSchema = target;
          draw();
        },
        undefined,
        name === schema && targetSchema === target,
      );
      b.setAttribute("aria-label", name + " depends on " + target + ", " + count + " links");
      b.style.background =
        "color-mix(in srgb,var(--accent) " + Math.min(count * 8, 40) + "%,var(--surface))";
    }
  }
  el(aside, "h2", targetSchema === undefined ? schema : schema + " → " + targetSchema);
  const list = el(aside, "div", undefined, "list");
  if (targetSchema === undefined)
    catalogSections(list, groups.get(schema) ?? [], (group, o) => {
      button(group, objectLabel(o, objects, false), () => openEndpoint(o.id, tabs[6]), "entry");
    });
  else {
    const matches = external.filter(
      (p) =>
        objects.get(p.source)!.schema === schema && objects.get(p.target)!.schema === targetSchema,
    );
    for (const p of matches)
      button(
        list,
        label(p.source) + " → " + label(p.target),
        () => {
          tab = tabs[4];
          openPair(p);
        },
        "entry",
      );
    if (!matches.length) el(list, "p", "No direct dependencies in this direction.", "muted");
  }
  const diagnostics = data.diagnostics;
  if (diagnostics.warnings.length || diagnostics.unresolved.length) {
    const details = el(aside, "details");
    el(details, "summary", "Analysis diagnostics");
    for (const msg of diagnostics.warnings) el(details, "p", msg);
    for (const ref of diagnostics.unresolved)
      el(details, "p", label(ref.ownerId) + " · " + ref.identifier + " · " + ref.reason);
  }
}

function svg(parent: Element, tag: string, attrs: Record<string, string | number>, text?: string) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  parent.append(node);
  return node;
}
function svgButton(parent: Element, title: string, fn: () => void, cls = "") {
  const g = svg(parent, "g", { role: "button", tabindex: 0, "aria-label": title, class: cls });
  svg(g, "title", {}, title);
  g.addEventListener("click", fn);
  g.addEventListener("keydown", (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      fn();
    }
  });
  return g;
}
function maps() {
  const shownGroups = visibleGroups();
  const shownPairs = pairs.filter((p) => visibleEndpoint(p.source) && visibleEndpoint(p.target));
  const [main, aside] = layout();
  const tools = el(main, "div", undefined, "tools");
  options(
    tools,
    "Inspect object",
    data.objects.map((o) => [o.id, label(o.id)]),
    objectId,
    (id) => openEndpoint(id),
  );
  if (tab !== tabs[4]) {
    button(tools, "Zoom out", () => {
      zoom = Math.max(0.5, zoom - 0.25);
      draw();
    });
    button(tools, "Fit", () => {
      zoom = 1;
      draw();
    });
    button(tools, "Zoom in", () => {
      zoom = Math.min(4, zoom + 0.25);
      draw();
    });
  }
  const legend = el(main, "div", undefined, "key");
  for (const name of shownGroups.keys())
    el(legend, "span", name).style.setProperty("--swatch", swatch(name));
  const pan = el(main, "div", undefined, "pan");
  const ordered = [...shownGroups.values()].flat();
  const positions = new Map(ordered.map((o, i) => [o.id, i]));
  if (!ordered.length) el(pan, "p", "No visible objects.", "muted");
  else if (tab === tabs[4]) {
    const board = el(pan, "div", undefined, "board");
    for (const [name, items] of shownGroups) {
      const tile = el(board, "section", undefined, "tile");
      tile.style.setProperty("--swatch", swatch(name));
      el(tile, "h3", name);
      for (const o of items) {
        const row = el(tile, "div", undefined, "list");
        button(
          row,
          objectLabel(o, objects, false),
          () => openEndpoint(o.id),
          "entry",
          o.id === objectId,
        );
        for (const p of shownPairs.filter((p) => p.source === o.id))
          button(row, "→ " + label(p.target), () => openPair(p), "entry", p === pair);
      }
    }
  } else {
    const orbit = tab === tabs[1],
      matrix = tab === tabs[2],
      n = ordered.length;
    const width = matrix
      ? Math.max(460, 200 + n * 18)
      : orbit
        ? Math.max(850, 320 + n * 6)
        : Math.max(760, n * 23 + 70);
    const height = matrix ? width : orbit ? width : 490;
    const root = svg(pan, "svg", { viewBox: "0 0 " + width + " " + height, "aria-label": tab });
    root.style.width = zoom * 100 + "%";
    root.style.minWidth = (matrix || !orbit ? width : 640) * zoom + "px";
    const wires = svg(root, "g", {}),
      marks = svg(root, "g", {});
    const size = (width - 200) / n,
      cy = orbit ? height / 2 : 208,
      radius = width * 0.31;
    const point = (i: number) => {
      const angle = ((i + 0.5) * 2 * Math.PI) / n - Math.PI / 2;
      return orbit
        ? { x: width / 2 + radius * Math.cos(angle), y: cy + radius * Math.sin(angle), angle }
        : { x: 35 + ((i + 0.5) * (width - 70)) / n, y: cy, angle: 0 };
    };
    if (matrix)
      svg(wires, "rect", {
        x: 170,
        y: 170,
        width: size * n,
        height: size * n,
        fill: "var(--surface)",
        stroke: "var(--rule)",
      });
    for (const [i, o] of ordered.entries()) {
      const { x, y, angle } = point(i),
        color = swatch(o.schema),
        active = objectId === o.id;
      const g = svgButton(marks, label(o.id), () => openEndpoint(o.id));
      const name = objectLabel(o, objects, false);
      if (matrix) {
        const pos = 170 + (i + 0.5) * size;
        svg(g, "text", { x: 161, y: pos + 3, "text-anchor": "end" }, name);
        svg(g, "text", { x: pos, y: 160, transform: "rotate(-60 " + pos + " 160)" }, name);
        svg(g, "rect", { x: 164, y: pos - size / 2, width: 4, height: size, fill: color });
        svg(g, "rect", { y: 164, x: pos - size / 2, height: 4, width: size, fill: color });
      } else {
        svg(g, "circle", {
          cx: x,
          cy: y,
          r: active ? 6 : 4,
          fill: color,
          stroke: active ? "var(--accent)" : "var(--surface)",
        });
        const flipped = orbit && Math.cos(angle) < 0;
        const tx = orbit ? x + 12 * Math.cos(angle) : x,
          ty = orbit ? y + 12 * Math.sin(angle) : y + 175;
        const degrees = orbit ? (angle * 180) / Math.PI + (flipped ? 180 : 0) : -67;
        svg(
          g,
          "text",
          {
            x: tx,
            y: ty,
            transform: "rotate(" + degrees + " " + tx + " " + ty + ")",
            "text-anchor": flipped ? "end" : "start",
          },
          name,
        );
      }
    }
    const touches = (p: Pair) =>
      pair ? p === pair : p.source === objectId || p.target === objectId;
    for (const p of shownPairs.sort((a, b) => Number(touches(a)) - Number(touches(b)))) {
      const a = positions.get(p.source)!,
        b = positions.get(p.target)!;
      const g = svgButton(
        wires,
        label(p.source) + " → " + label(p.target),
        () => openPair(p),
        touches(p) ? "" : "dim",
      );
      if (matrix)
        svg(g, "rect", {
          x: 170 + b * size + 1,
          y: 170 + a * size + 1,
          width: size - 2,
          height: size - 2,
          rx: 2,
          fill: touches(p) ? "var(--accent)" : swatch(objects.get(p.source)!.schema),
        });
      else {
        const start = point(a),
          end = point(b);
        const bow = Math.min(220, 20 + Math.sqrt(Math.abs(start.x - end.x)) * 7) * (a < b ? -1 : 1);
        const control = orbit
          ? width / 2 + " " + cy + " " + width / 2 + " " + cy
          : start.x + " " + (cy + bow) + " " + end.x + " " + (cy + bow);
        const d = "M" + start.x + " " + start.y + " C" + control + " " + end.x + " " + end.y;
        svg(g, "path", { d, class: "wire" + (touches(p) ? " selected" : "") });
        svg(g, "path", { d, class: "hit" });
      }
    }
  }
  el(aside, "small", pair ? "Directed dependency" : "Selected object");
  el(aside, "h2", pair ? label(pair.source) + " → " + label(pair.target) : label(objectId));
  if (pair) for (const rel of pair.relationships) evidence(aside, rel);
  else {
    button(aside, "Visual neighborhood", () => openEndpoint(objectId, tabs[6]));
    objectVisibility(aside);
    const list = el(aside, "div", undefined, "list");
    const links = pairs.filter((p) => p.source === objectId || p.target === objectId);
    for (const p of links)
      button(list, label(p.source) + " → " + label(p.target), () => openPair(p), "entry");
    if (!links.length) el(list, "p", "No object links.", "muted");
  }
}
function evidence(parent: Element, rel: Relationship) {
  const proof = el(parent, "section", undefined, "proof");
  el(proof, "small", rel.provenance + " · " + rel.kind);
  el(proof, "h3", label(rel.source) + " → " + label(rel.target));
  if (rel.constraintId)
    el(
      proof,
      "p",
      "Constraint " +
        label(rel.constraintId) +
        (rel.position === undefined ? "" : " · position " + rel.position),
    );
  const records = data.evidence.filter((e) => e.relationshipId === rel.id);
  if (!records.length) el(proof, "p", "No SQL occurrence captured.", "muted");
  for (const rec of records) {
    el(proof, "small", label(rec.ownerId) + " · " + rec.provenance);
    if (rec.snippet) el(proof, "pre", rec.snippet);
    const def = data.definitions.find((d) => d.ownerId === rec.ownerId);
    if (def) {
      const details = el(proof, "details");
      el(details, "summary", "Captured definition");
      details.open = !rec.snippet;
      const sql = el(details, "pre");
      if (rec.start !== undefined && rec.end !== undefined) {
        sql.append(def.sql.slice(0, rec.start));
        el(sql, "mark", def.sql.slice(rec.start, rec.end));
        sql.append(def.sql.slice(rec.end));
      } else sql.textContent = def.sql;
    }
    if (host && fromHost)
      button(proof, "Open SQL in editor", () =>
        host.postMessage({ type: "openEvidence", evidenceId: rec.id }),
      );
  }
}

function explorer() {
  const [side, main] = layout("explorer");
  el(side, "h2", "Objects and columns");
  const search = el(side, "input");
  search.type = "search";
  search.placeholder = "Find an object or column";
  search.setAttribute("aria-label", search.placeholder);
  search.value = filter;
  const catalog = el(side, "div", undefined, "catalog");
  function list() {
    catalog.replaceChildren();
    const term = filter.toLowerCase();
    const matchesColumn = (column: Snapshot["columns"][number]) =>
      column.name.toLowerCase().includes(term) || label(column.id).toLowerCase().includes(term);
    const visible = data.objects.filter(
      (o) =>
        label(o.id).toLowerCase().includes(term) || columnsByObject.get(o.id)?.some(matchesColumn),
    );
    catalogSections(catalog, visible, (group, o) => {
      const cols = columnsByObject.get(o.id) ?? [];
      const matches = label(o.id).toLowerCase().includes(term);
      const row = el(group, "div", undefined, "list");
      button(row, label(o.id), () => openEndpoint(o.id), "entry", objectId === o.id && !columnId);
      if (objectId === o.id || term)
        for (const c of cols) {
          if (!matches && !matchesColumn(c)) continue;
          const cb = button(
            row,
            c.name,
            () => openEndpoint(c.id),
            "entry catalog-column",
            columnId === c.id,
          );
          el(cb, "small", c.type);
        }
    });
    if (!catalog.childElementCount) el(catalog, "p", "No matching objects or columns.", "muted");
  }
  list();
  search.oninput = () => {
    filter = search.value;
    list();
  };
  const root = columnId || objectId;
  const visual = tab === tabs[6];
  const selectionHidden = visual && !visibleEndpoint(root);
  const endpointsVisible = (r: Relationship) =>
    visibleEndpoint(r.source) && visibleEndpoint(r.target);
  el(main, "small", columnId ? "Column" : objects.get(objectId)?.kind);
  el(main, "h2", label(root), "mono");
  const tools = el(main, "div", undefined, "tools");
  if (visual && !columnId) objectVisibility(tools);
  options(
    tools,
    "Direction",
    [
      ...(visual ? [["both", "Both directions"] as [string, string]] : []),
      ["incoming", "Referenced by"],
      ["outgoing", "Depends on"],
    ],
    visual ? visualDirection : direction,
    (v) => {
      if (visual) visualDirection = v as typeof visualDirection;
      else direction = v as typeof direction;
      path = [];
      draw();
    },
  );
  options(
    tools,
    "Depth",
    [
      ["1", "1 hop"],
      ["2", "2 hops"],
    ],
    String(depth),
    (v) => {
      depth = v === "1" ? 1 : 2;
      path = [];
      draw();
    },
  );
  const members = [
    objectId,
    ...(columnsByObject.get(objectId) ?? []).map((c) => c.id),
    ...data.objects.filter((o) => o.parentId === objectId).map((o) => o.id),
  ];
  function referencePaths(id: string, direction: "incoming" | "outgoing", limit: 1 | 2) {
    const crossesObjects = (r: Relationship) =>
      endpointObject(r.source).id !== endpointObject(r.target).id;
    return index
      .neighborhood(id, direction, limit)
      .filter((p) =>
        visual ? p.every((r) => crossesObjects(r) && endpointsVisible(r)) : p.some(crossesObjects),
      );
  }
  const selectedDirection = visual ? visualDirection : direction;
  const directions: ("incoming" | "outgoing")[] =
    selectedDirection === "both" ? ["incoming", "outgoing"] : [selectedDirection];
  const neighborhoods = selectionHidden
    ? []
    : directions.map((direction) => ({
        direction,
        paths: (columnId ? [root] : members).flatMap((id) => referencePaths(id, direction, depth)),
      }));
  if (path.length) {
    const matches = (candidate: Relationship[]) =>
      path.every((old, i) => {
        const current = candidate[i];
        return (
          current?.id === old.id &&
          current.source === old.source &&
          current.target === old.target &&
          current.kind === old.kind &&
          current.constraintId === old.constraintId &&
          current.position === old.position
        );
      });
    const current = neighborhoods.flatMap((n) => n.paths).find(matches);
    path = current?.slice(0, path.length) ?? [];
  }
  function renderDirection(direction: "incoming" | "outgoing", paths: Relationship[][]) {
    const endpoint = (rel: Relationship) => (direction === "incoming" ? rel.source : rel.target);
    const same = (a: Relationship[], b: Relationship[]) =>
      a.length === b.length && a.every((r, i) => r.id === b[i]?.id);
    const choose = (value: Relationship[]) => {
      path = value;
      draw();
    };
    if (visual) {
      const direct = [...new Set(paths.map((p) => p[0]).filter((r): r is Relationship => !!r))];
      const next = paths.filter((p) => p.length === 2);
      const context = columnId
        ? members
            .filter((id) => id !== columnId)
            .flatMap((id) => referencePaths(id, direction, 1).map((p) => p[0]!))
        : [];
      if (visualDirection === "both")
        el(main, "h3", direction === "incoming" ? "Referenced by" : "Depends on");
      if (!paths.length && !context.length) {
        el(main, "p", "No visible " + direction + " reference paths.", "muted");
        return;
      }
      const pan = el(main, "div", undefined, "pan");
      const height = Math.max(145, Math.max(direct.length + context.length, next.length) * 48 + 55);
      const scene = svg(pan, "svg", {
        viewBox: "0 0 850 " + height,
        "aria-label": "Directed neighborhood",
      });
      const defs = svg(scene, "defs", {}),
        arrow = svg(defs, "marker", {
          id: "nh-arrow-" + direction,
          viewBox: "0 0 8 8",
          refX: 7,
          refY: 4,
          markerWidth: 6,
          markerHeight: 6,
          orient: "auto-start-reverse",
        });
      svg(arrow, "path", { d: "M0 0 L8 4 L0 8 Z", fill: "var(--wire)" });
      const wires = svg(scene, "g", {}),
        nodes = svg(scene, "g", {});
      const captions = [
        "Selection",
        direction === "incoming" ? "Direct references" : "Direct dependencies",
        "Second hop",
      ];
      [10, 295, 580].forEach((x, i) => {
        if (i <= depth) svg(nodes, "text", { x, y: 18 }, captions[i]);
      });
      function node(x: number, y: number, id: string, value: Relationship[], inactive = false) {
        const active = !value.length || value.every((r, i) => path[i]?.id === r.id);
        const g = svgButton(
          nodes,
          label(id),
          () => {
            if (inactive) {
              openEndpoint(id);
              return;
            }
            choose(value);
          },
          inactive || (path.length && !active) ? "dim" : "",
        );
        svg(g, "rect", {
          x,
          y: y - 16,
          rx: 5,
          width: 244,
          height: 34,
          fill: active ? "var(--active)" : "var(--surface)",
          stroke: active ? "var(--wire)" : "var(--rule)",
        });
        const name = label(id);
        svg(g, "text", { x: x + 9, y: y - 2 }, name.length > 29 ? name.slice(0, 28) + "…" : name);
        svg(
          g,
          "text",
          { x: x + 9, y: y + 11, class: "node-kind" },
          columns.has(id) ? "column" : endpointObject(id).kind,
        );
      }
      function wire(x: number, y: number, toY: number, value: Relationship[]) {
        const start = x + 244,
          end = x + 285,
          mid = (start + end) / 2;
        const d =
          "M" +
          start +
          " " +
          y +
          " C" +
          mid +
          " " +
          y +
          " " +
          mid +
          " " +
          toY +
          " " +
          end +
          " " +
          toY;
        const rel = value[value.length - 1]!;
        const g = svgButton(
          wires,
          label(rel.source) + " " + rel.kind + " " + label(rel.target),
          () => choose(value),
        );
        const active = value.every((r, i) => path[i]?.id === r.id);
        svg(g, "path", {
          d,
          class: "wire" + (active ? " selected" : path.length ? " dim" : ""),
          [direction === "incoming" ? "marker-start" : "marker-end"]:
            "url(#nh-arrow-" + direction + ")",
        });
        svg(g, "path", { d, class: "hit" });
      }
      const rootY = height / 2;
      node(10, rootY, root, []);
      for (const [i, rel] of direct.entries()) {
        const y = 50 + i * 48;
        wire(10, rootY, y, [rel]);
        node(295, y, endpoint(rel), [rel]);
      }
      for (const [i, rel] of context.entries())
        node(295, 50 + (i + direct.length) * 48, endpoint(rel), [rel], true);
      for (const [i, p] of next.entries()) {
        const y = 50 + i * 48;
        wire(295, 50 + direct.indexOf(p[0]!) * 48, y, p);
        node(580, y, endpoint(p[1]!), p);
      }
    } else {
      for (const p of paths) {
        const row = el(main, "div", undefined, "path");
        p.forEach((rel, i) => {
          if (i) el(row, "span", direction === "incoming" ? "←" : "→");
          button(
            row,
            label(endpoint(rel)),
            () => choose(p.slice(0, i + 1)),
            "",
            same(path, p.slice(0, i + 1)),
          );
        });
      }
    }
    if (!paths.length) el(main, "p", "No " + direction + " reference paths.", "muted");
    else if (!path.length) el(main, "p", "Select a reference to inspect its evidence.", "muted");
  }
  if (selectionHidden) el(main, "p", "The selection is hidden in diagrams.", "muted");
  for (const { direction, paths } of neighborhoods) renderDirection(direction, paths);
  if (path.length) {
    el(main, "h3", "Selected path");
    for (const [i, rel] of path.entries()) {
      el(main, "small", "Hop " + (i + 1));
      evidence(main, rel);
    }
  }
  const definition = data.definitions.find((d) => d.ownerId === root);
  if (definition) {
    const section = el(main, "details");
    el(section, "summary", "Captured SQL");
    el(section, "pre", definition.sql);
  }
  const keyPairs = data.relationships
    .filter((r) => r.kind === "fk" && r.constraintId === root)
    .sort((a, b) => a.position! - b.position!);
  if (keyPairs.length) {
    el(main, "h3", "Foreign key columns");
    for (const rel of keyPairs) evidence(main, rel);
  }
  const locals = (columnId ? index.columnReferences(columnId) : data.relationships).filter(
    (r) => index.owner(r.source) === objectId && index.owner(r.target) === objectId,
  );
  if (locals.length) {
    const details = el(main, "details");
    el(details, "summary", "Same-object details (" + locals.length + ")");
    for (const r of locals) evidence(details, r);
  }
}
