/**
 * Regenerate `diagram/club.manual.json` from the traced `diagram/club.drawio`.
 *
 * Why this exists: the traced example was originally produced by ad-hoc scripts
 * that dropped geometry. Authored box sizes, connector anchors, bend points, and
 * label origins were lost, which made wires overlap, double back, and drift off
 * the reference. Committing the conversion makes every field reproducible and
 * reviewable in a diff instead of being patched by hand.
 *
 * Rules encoded here, all derived from the reference file itself:
 * - Panel and node rectangles are the traced absolute rectangles.
 * - Node `width`/`height` are the authored box, never a measured minimum.
 * - Connector anchors are the traced `exitX/exitY` and `entryX/entryY` fractions.
 * - Bend points come from the traced `<Array>` points.
 * - Labels anchor at the traced text centre and baseline (`labelAt`).
 * - Edge kind: blue stroke is primary, dashed is async, otherwise secondary.
 * - Every traced icon is matched to a committed `icons/*.svg` alias; unmatched
 *   artwork is written to `icons/` so no card can silently render iconless.
 *
 * Run with `bun scripts/trace-club.ts [outputPath]`. The output is deterministic:
 * keys and ordering are fixed, so reruns produce byte-identical files. Tests
 * pass a temporary path so verification never mutates the committed fixture.
 */
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type Point = { x: number; y: number };

interface TracedNode {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  subtitle?: string;
  group?: string;
  icon?: string;
  shape?: "process";
  cardX?: number;
  cardY?: number;
  cardWidth?: number;
  cardHeight?: number;
}

interface TracedEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  kind?: "primary" | "async";
  fromAnchor?: Point;
  toAnchor?: Point;
  via?: Point[];
  labelAt?: Point;
}

interface TracedGroup {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  tone: "warm" | "cool" | "neutral";
  parent?: string;
  dashed?: boolean;
}

const root = new URL("../", import.meta.url);
const drawioPath = fileURLToPath(new URL("diagram/club.drawio", root));
// An explicit output path lets tests compare generated output without ever
// rewriting the committed fixture.
const outputPath = process.argv[2] ?? fileURLToPath(new URL("diagram/club.manual.json", root));
const svgPath = fileURLToPath(new URL("out/club-editable.svg", root));
const iconsDir = new URL("icons/", root);

/** Panel tone and outline per traced group. */
const GROUP_STYLE: Record<string, { tone: TracedGroup["tone"]; dashed: boolean; label: string }> = {
  cf: { tone: "warm", dashed: false, label: "Cloudflare" },
  dok: { tone: "cool", dashed: false, label: "Dokploy Server" },
  "dok.invsys": { tone: "cool", dashed: true, label: "Inventory System (SANGISAICF)" },
  "dok.pub": { tone: "cool", dashed: true, label: "Festival Web (sangifes)" },
  ext: { tone: "neutral", dashed: false, label: "External Services" },
  backup: { tone: "neutral", dashed: true, label: "Backup Server (inside WireGuard)" },
  ci: { tone: "neutral", dashed: true, label: "Separate PC (CI)" },
  offline: { tone: "neutral", dashed: true, label: "Photo Capture (offline)" },
  clients: { tone: "neutral", dashed: true, label: "Clients" },
};

const round = (value: number, places = 1): number => Number(value.toFixed(places));

/**
 * Minimal XML reader for the drawio document.
 *
 * Bun ships no DOMParser, and a full XML dependency is not worth one file, so
 * this tokenises the constructs the exporter actually emits: elements with
 * attributes, self-closing tags, and text. It is deliberately strict about
 * attribute quoting so a malformed file fails loudly instead of yielding
 * silently missing geometry.
 */
interface ElementNode {
  name: string;
  attrs: Record<string, string>;
  children: ElementNode[];
}

function parseXml(source: string): ElementNode {
  const document: ElementNode = { name: "#document", attrs: {}, children: [] };
  const stack = [document];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*"[^"]*")*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->/g;
  let cursor = 0;
  for (let match = tag.exec(source); match !== null; match = tag.exec(source)) {
    if (match[0].startsWith("<?") || match[0].startsWith("<!--")) continue;
    cursor = tag.lastIndex;
    const [, closing, name, rawAttrs, selfClosing] = match;
    if (closing === "/") {
      const open = stack.pop();
      if (open === undefined || open.name !== name) {
        throw new Error(`trace-club: unbalanced </${name}> in drawio document`);
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attr of rawAttrs.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g)) attrs[attr[1]] = attr[2];
    const element: ElementNode = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(element);
    if (selfClosing !== "/") stack.push(element);
  }
  if (cursor === 0) throw new Error("trace-club: drawio document contained no elements");
  if (stack.length !== 1) throw new Error(`trace-club: unclosed <${stack[stack.length - 1].name}>`);
  return document;
}

function findAll(node: ElementNode, name: string, out: ElementNode[] = []): ElementNode[] {
  for (const child of node.children) {
    if (child.name === name) out.push(child);
    findAll(child, name, out);
  }
  return out;
}

function first(node: ElementNode, name: string): ElementNode | undefined {
  return node.children.find((child) => child.name === name);
}

const kindOf = (tag: ElementNode): string => tag.name.slice(tag.name.indexOf(":") + 1);

const cells = new Map<string, ElementNode>();
const document = parseXml(await Bun.file(drawioPath).text());
for (const cell of findAll(document, "mxCell")) {
  const id = cell.attrs.id;
  if (id !== undefined) cells.set(id, cell);
}
if (cells.size === 0) throw new Error("trace-club: no mxCell elements found");

/** Absolute origin of a cell, accumulated through its container chain. */
function origin(id: string): Point {
  let x = 0;
  let y = 0;
  let current = cells.get(id);
  while (current !== undefined) {
    const geometry = first(current, "mxGeometry");
    if (geometry !== undefined) {
      x += Number(geometry.attrs.x ?? 0);
      y += Number(geometry.attrs.y ?? 0);
    }
    const parent = current.attrs.parent;
    current = parent === undefined || parent === "0" || parent === "1" ? undefined : cells.get(parent);
  }
  return { x, y };
}

/** Absolute rectangle of a vertex cell. */
function box(id: string): { x: number; y: number; width: number; height: number } {
  const cell = cells.get(id);
  if (cell === undefined) throw new Error(`trace-club: no cell "${id}"`);
  const geometry = first(cell, "mxGeometry");
  if (geometry === undefined) throw new Error(`trace-club: cell "${id}" has no geometry`);
  const { x, y } = origin(id);
  return {
    x: round(x),
    y: round(y),
    width: round(Number(geometry.attrs.width)),
    height: round(Number(geometry.attrs.height)),
  };
}

const isContainer = (cell: ElementNode): boolean => (cell.attrs.style ?? "").includes("container=1");

/** Normalised SVG text, used to match traced artwork against local aliases. */
const normalise = (svg: string): string =>
  svg.replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();

const localIcons = new Map<string, string>();
for await (const name of new Bun.Glob("*.svg").scan(fileURLToPath(iconsDir))) {
  const alias = name.slice(0, -".svg".length);
  localIcons.set(alias, normalise(await Bun.file(new URL(name, iconsDir)).text()));
}

/** Inner artwork of a wrapped 512px icon, if the payload uses that wrapper. */
function innerArtwork(svg: string): string | undefined {
  const match = /<svg[^>]*x="64"[^>]*>([\s\S]*?)<\/svg>\s*$/.exec(svg);
  return match === null ? undefined : normalise(match[1]);
}

/** Resolve a traced icon payload to a committed alias, writing it out if new. */
async function resolveIcon(nodeId: string): Promise<string | undefined> {
  const iconCell = cells.get(`${nodeId}-icon`);
  if (iconCell === undefined) return undefined;
  const match = /image=data:image\/svg\+xml,([^;]+)/.exec(iconCell.attrs.style ?? "");
  if (match === null) return undefined;
  const svg = decodeURIComponent(match[1].split(";")[0]);

  for (const [alias, body] of localIcons) if (body === normalise(svg)) return alias;
  const artwork = innerArtwork(svg);
  if (artwork !== undefined) {
    for (const [alias, body] of localIcons) {
      if (innerArtwork(body) === artwork) return alias;
    }
  }

  // Unmatched artwork is committed under a derived alias instead of being
  // dropped: a card with no icon is exactly the defect this generator prevents.
  const alias = nodeId.replace(/^.*\./, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = new URL(`${alias}.svg`, iconsDir);
  if (!(await Bun.file(path).exists())) {
    await mkdir(iconsDir, { recursive: true });
    await Bun.write(path, svg.replace(/></g, ">\n<") + "\n");
  }
  localIcons.set(alias, normalise(svg));
  return alias;
}

/** Connector label anchors, keyed by text in document order. */
const labelTexts = new Map<string, Point[]>();
const svgMarkup = await Bun.file(svgPath).text();
for (const match of svgMarkup.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
  const attrs = match[1];
  const text = match[2].trim();
  if (text === "") continue;
  const x = Number(/\bx="(-?[\d.]+)"/.exec(attrs)?.[1]);
  const y = Number(/\by="(-?[\d.]+)"/.exec(attrs)?.[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
  labelTexts.set(text, [...(labelTexts.get(text) ?? []), { x: round(x), y: round(y) }]);
}
const labelCursor = new Map<string, number>();

const groupIds = Object.keys(GROUP_STYLE).filter((id) => cells.has(id));
const groups: TracedGroup[] = groupIds.map((id) => {
  const style = GROUP_STYLE[id];
  const rect = box(id);
  const parent = cells.get(id)!.attrs.parent;
  const group: TracedGroup = {
    id,
    label: style.label,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    tone: style.tone,
  };
  if (parent !== undefined && GROUP_STYLE[parent] !== undefined) group.parent = parent;
  if (style.dashed) group.dashed = true;
  return group;
});

const nodeIds = [...cells.keys()].filter((id) => cells.get(id)!.attrs.vertex === "1" && cells.has(`${id}-card`));
if (nodeIds.length === 0) throw new Error("trace-club: no traced service cards found");

const nodes: TracedNode[] = [];
for (const id of nodeIds) {
  const rect = box(id);
  const caption = cells.get(`${id}-caption`);
  const subtitle = cells.get(`${id}-subtitle`);
  const node: TracedNode = {
    id,
    label: caption?.attrs.value ?? id,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
  if (subtitle?.attrs.value) node.subtitle = subtitle.attrs.value;

  // Card geometry is authored, not derived: the traced card is smaller than the
  // default and off-centre, and connector anchors and label origins were
  // measured against this exact rectangle.
  const card = first(cells.get(`${id}-card`)!, "mxGeometry");
  if (card !== undefined) {
    node.cardX = round(Number(card.attrs.x ?? 0));
    node.cardY = round(Number(card.attrs.y ?? 0));
    node.cardWidth = round(Number(card.attrs.width));
    node.cardHeight = round(Number(card.attrs.height));
  }
  const parent = cells.get(id)!.attrs.parent;
  if (parent !== undefined && GROUP_STYLE[parent] !== undefined) node.group = parent;
  const icon = await resolveIcon(id);
  if (icon !== undefined) node.icon = icon;
  else node.shape = "process";
  nodes.push(node);
}
nodes.sort((a, b) => {
  const rankA = groupIds.indexOf(a.group ?? "");
  const rankB = groupIds.indexOf(b.group ?? "");
  return rankA === rankB ? a.id.localeCompare(b.id) : rankA - rankB;
});

const edges: TracedEdge[] = [];
for (const [id, cell] of cells) {
  if (cell.attrs.edge !== "1") continue;
  const from = cell.attrs.source;
  const to = cell.attrs.target;
  if (from === undefined || to === undefined) continue;
  if (!nodeIds.includes(from) || !nodeIds.includes(to)) continue;

  const style = cell.attrs.style ?? "";
  const fraction = (key: string): number | undefined => {
    const found = new RegExp(`\\b${key}=(-?[\\d.]+)`).exec(style);
    return found === null ? undefined : round(Number(found[1]), 6);
  };
  const edge: TracedEdge = { id, from, to };
  if (cell.attrs.value) edge.label = cell.attrs.value;
  if (style.includes("#1883B6")) edge.kind = "primary";
  else if (style.includes("dashed=1")) edge.kind = "async";

  const exitX = fraction("exitX");
  const exitY = fraction("exitY");
  const entryX = fraction("entryX");
  const entryY = fraction("entryY");
  if (exitX !== undefined && exitY !== undefined) edge.fromAnchor = { x: exitX, y: exitY };
  if (entryX !== undefined && entryY !== undefined) edge.toAnchor = { x: entryX, y: entryY };

  const geometry = first(cell, "mxGeometry");
  const array = geometry === undefined ? undefined : first(geometry, "Array");
  if (array !== undefined) {
    const via = array.children
      .filter((point) => kindOf(point) === "mxPoint")
      .map((point) => ({ x: round(Number(point.attrs.x)), y: round(Number(point.attrs.y)) }));
    if (via.length > 0) edge.via = via;
  }

  if (edge.label !== undefined) {
    const candidates = labelTexts.get(edge.label) ?? [];
    const index = labelCursor.get(edge.label) ?? 0;
    const at = candidates[index];
    if (at !== undefined) {
      edge.labelAt = at;
      labelCursor.set(edge.label, index + 1);
    }
  }
  edges.push(edge);
}

const document_out = { title: "Club architecture", layout: "manual", groups, nodes, edges };
await Bun.write(outputPath, JSON.stringify(document_out, null, 2) + "\n");
console.log(
  `trace-club: wrote ${groups.length} groups, ${nodes.length} nodes ` +
    `(${nodes.filter((node) => node.icon).length} with icons), ${edges.length} edges ` +
    `(${edges.filter((edge) => edge.labelAt).length} placed labels).`,
);
