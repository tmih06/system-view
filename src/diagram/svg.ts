import { theme as lightTheme, type Theme } from "./theme";
import type { EdgeKind, IconMap, Scene, SceneEdge, SceneGroup, SceneNode } from "./types";

/**
 * Self-contained SVG rendering of an already-laid-out {@link Scene}.
 *
 * Coordinates in a scene are absolute, so this module never derives geometry:
 * it only paints the rectangles, polylines and label boxes it is given. Fonts
 * are native SVG `<text>` (no foreignObject) so the file opens in viewers,
 * design tools and browsers without scripts, and icon aliases are resolved to
 * self-contained `data:` URIs so the document has no external references.
 *
 * Painting order is background, groups, connectors, then nodes/cards. That is
 * the reference whiteboard language: panels are tinted backdrops, edges sit on
 * top of them and icon cards stay crisp on top of everything.
 */

export interface SvgRenderOptions {
  /**
   * Graph-paper mode. `true` (default) paints the palette background plus a
   * 24px grid for standalone exports; `false` leaves the canvas transparent so
   * a host UI can draw its own grid underneath the SVG.
   */
  grid?: boolean;
  /** Paint palette. Defaults to the light theme; geometry never depends on it. */
  palette?: Theme;
}

const GRID_SIZE = 24;
const GROUP_PAD = 14;
const CAPTION_GAP = 8;
const SUBTITLE_GAP = 3;

/** XML-escape text and attribute values, including quotes. Shared by both exporters. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Format a coordinate compactly; geometry comes from the layout pass. */
function n(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** Split an authored line defensively; layout normally pre-wraps lines. */
function lines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** All visible lines of a node's title/subtitle blocks. */
function splitLines(block: string[]): string[] {
  return block.flatMap(lines);
}

/**
 * Baseline offset that visually centres a line box of `lineHeight` around its
 * middle. SVG has no reliable cross-viewer vertical centring primitive that
 * respects a fixed line height, so text is placed by explicit baseline.
 */
function baseline(centerY: number, fontSize: number): number {
  return centerY + fontSize * 0.36;
}

/** Center y of line `index` in a block starting at `top` with fixed height. */
function lineCenter(top: number, index: number, lineHeight: number): number {
  return top + index * lineHeight + lineHeight / 2;
}

/**
 * Resolve an icon alias to its embedded data URI.
 *
 * Shared with the draw.io exporter, which applies its own style escaping on top.
 * Missing or non-data aliases are a hard error: silently omitting the image
 * would produce an export that looks complete but has no icon, which is worse
 * than failing the request. Callers pass a human-readable `subject` (exporter
 * plus node) so the thrown message names the offending element.
 */
export function resolveIconDataUri(icons: IconMap, alias: string, subject: string): string {
  const uri = icons[alias];
  if (uri == null) {
    throw new Error(`${subject} references icon alias "${alias}", which is not in the icon map`);
  }
  if (!/^data:image\//i.test(uri)) {
    throw new Error(`${subject} has icon alias "${alias}", which is not an image data URI`);
  }
  return uri;
}

/** Edge paint per kind: accent blue for the main flow, muted grey elsewhere. */
function edgeStyle(kind: EdgeKind, palette: Theme): { color: string; width: number; dash?: string } {
  if (kind === "primary") return { color: palette.primary, width: 1.5 };
  if (kind === "async") return { color: palette.secondary, width: 1.2, dash: "5 4" };
  return { color: palette.secondary, width: 1.2 };
}

/**
 * Order groups so every parent is painted before its children.
 *
 * Shared with the draw.io exporter, which needs the same container nesting
 * order. The contract emits groups parent-first, but paint order (SVG) and
 * container nesting (draw.io) both depend on it, so the exporters enforce it
 * instead of trusting input order. Sibling order from the scene is preserved,
 * which keeps overlapping root panels in their authored stacking order. A
 * parent cycle throws rather than silently truncating the list.
 */
export function orderGroups(groups: SceneGroup[]): SceneGroup[] {
  const byId = new Map<string, SceneGroup>();
  for (const group of groups) {
    if (byId.has(group.id)) throw new Error(`diagram duplicate group id "${group.id}"`);
    byId.set(group.id, group);
  }
  const ordered: SceneGroup[] = [];
  const placed = new Set<string>();

  const place = (group: SceneGroup, chain: Set<string>): void => {
    if (placed.has(group.id)) return;
    if (chain.has(group.id)) {
      throw new Error(`diagram group "${group.id}" participates in a parent cycle`);
    }
    chain.add(group.id);
    if (group.parent) {
      const parent = byId.get(group.parent);
      if (!parent) {
        throw new Error(`diagram group "${group.id}" references unknown parent "${group.parent}"`);
      }
      place(parent, chain);
    }
    chain.delete(group.id);
    ordered.push(group);
    placed.add(group.id);
  };

  for (const group of groups) place(group, new Set());
  return ordered;
}

/**
 * Rounded rectangle with the radius clamped to half the shorter side.
 *
 * SVG clamps oversized `rx` itself but clamping here keeps the emitted value
 * meaningful, and the same clamp is what draw.io's `arcSize` produces.
 */
function rect(x: number, y: number, width: number, height: number, radius: number, style: string): string {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" rx="${n(r)}" ${style}/>`;
}

/** Graph-paper backdrop: opaque theme background plus a 24px grid overlay. */
function renderGrid(width: number, height: number, palette: Theme): { pattern: string; body: string } {
  const patternId = "diagram-grid";
  const pattern =
    `<pattern id="${patternId}" width="${GRID_SIZE}" height="${GRID_SIZE}" patternUnits="userSpaceOnUse">` +
    `<path d="M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}" fill="none" stroke="${palette.grid}" stroke-width="1"/>` +
    `</pattern>`;
  return {
    pattern,
    body:
      `<rect x="0" y="0" width="${n(width)}" height="${n(height)}" fill="${palette.background}"/>` +
      `<rect x="0" y="0" width="${n(width)}" height="${n(height)}" fill="url(#${patternId})"/>`,
  };
}

function renderGroup(group: SceneGroup, palette: Theme): string {
  const tone = palette.tones[group.tone] ?? palette.tones.neutral;
  const dash = group.dashed ? ` stroke-dasharray="4 4"` : "";
  const fill = rect(
    group.x,
    group.y,
    group.width,
    group.height,
    18,
    `fill="${tone.fill}" stroke="${tone.stroke}" stroke-width="1"${dash}`,
  );
  const label = group.label
    ? `<text x="${n(group.x + GROUP_PAD + 2)}" y="${n(group.y + GROUP_PAD + 10)}" fill="${tone.ink}" ` +
      `font-family="${escapeXml(palette.fontFamily)}" font-size="${palette.groupSize}" font-weight="bold">` +
      `${escapeXml(group.label)}</text>`
    : "";
  return `<g data-group="${escapeXml(group.id)}">${fill}${label}</g>`;
}

/** One rendered line of native SVG text. */
function textLine(
  content: string,
  x: number,
  centerY: number,
  size: number,
  fill: string,
  family: string,
  weight?: string,
): string {
  return (
    `<text x="${n(x)}" y="${n(baseline(centerY, size))}" fill="${fill}" ` +
    `font-family="${escapeXml(family)}" font-size="${size}" text-anchor="middle"` +
    (weight ? ` font-weight="${weight}"` : "") +
    `>${escapeXml(content)}</text>`
  );
}

/**
 * Two-tier caption: bold name lines, then a 3px gap, then mono subtitle lines.
 *
 * `top` is the top of the title block, so service nodes pass the card bottom
 * plus the caption gap while body shapes pass the top of their centred text
 * block. The gap is only counted when both tiers are present, matching the
 * footprint the layout reserves.
 */
function captionBlock(
  id: string,
  centerX: number,
  top: number,
  titleBlock: string[],
  subtitleBlock: string[],
  palette: Theme,
): string {
  const titleLines = splitLines(titleBlock);
  const subtitleLines = splitLines(subtitleBlock);
  const gap = titleLines.length > 0 && subtitleLines.length > 0 ? SUBTITLE_GAP : 0;
  const subtitleTop = top + titleLines.length * palette.titleLineHeight + gap;

  const title = titleLines
    .map((line, index) =>
      textLine(
        line,
        centerX,
        lineCenter(top, index, palette.titleLineHeight),
        palette.titleSize,
        palette.ink,
        palette.fontFamily,
        "bold",
      ),
    )
    .join("");
  const subtitle = subtitleLines
    .map((line, index) =>
      textLine(
        line,
        centerX,
        lineCenter(subtitleTop, index, palette.subtitleLineHeight),
        palette.subtitleSize,
        palette.muted,
        palette.monoFamily,
      ),
    )
    .join("");
  return `<g data-caption="${escapeXml(id)}">${title}${subtitle}</g>`;
}

/** Height of a node's reserved caption footprint, used to centre body text. */
function captionHeight(node: SceneNode, palette: Theme): number {
  const titleLines = splitLines(node.labelLines).length;
  const subtitleLines = splitLines(node.subtitleLines).length;
  const gap = titleLines > 0 && subtitleLines > 0 ? SUBTITLE_GAP : 0;
  return titleLines * palette.titleLineHeight + gap + subtitleLines * palette.subtitleLineHeight;
}

/** Service nodes: white rounded square with the icon, caption underneath. */
function renderServiceNode(node: SceneNode, icons: IconMap, palette: Theme): string {
  if (!node.card) {
    throw new Error(`renderSvg: service node "${node.id}" has no icon card rectangle`);
  }
  const card = node.card;
  const cardRect = rect(
    card.x,
    card.y,
    card.width,
    card.height,
    18,
    `fill="${palette.surface}" stroke="${palette.border}" stroke-width="1"`,
  );
  const iconSize = Math.max(0, Math.min(palette.iconSize, card.width - 8, card.height - 8));
  const icon = node.icon
    ? (() => {
        // A raw `#` inside a data URI starts a fragment, so a colour literal in
        // an unescaped SVG payload would truncate the image. Percent-encoding it
        // is a no-op for correctly encoded payloads.
        const uri = resolveIconDataUri(icons, node.icon, `renderSvg: node "${node.id}"`).replace(/#/g, "%23");
        const x = card.x + (card.width - iconSize) / 2;
        const y = card.y + (card.height - iconSize) / 2;
        return (
          `<image x="${n(x)}" y="${n(y)}" width="${n(iconSize)}" height="${n(iconSize)}" ` +
          `href="${escapeXml(uri)}" xlink:href="${escapeXml(uri)}" preserveAspectRatio="xMidYMid meet"/>`
        );
      })()
    : "";
  const caption = captionBlock(
    node.id,
    node.x + node.width / 2,
    card.y + card.height + CAPTION_GAP,
    node.labelLines,
    node.subtitleLines,
    palette,
  );
  return `<g data-node="${escapeXml(node.id)}">${cardRect}${icon}${caption}</g>`;
}

/** Process, decision and terminal bodies painted inside the node footprint. */
function renderBodyNode(node: SceneNode, palette: Theme): string {
  const body = `fill="${palette.surface}" stroke="${palette.border}" stroke-width="1"`;
  let shape: string;
  switch (node.shape) {
    case "decision": {
      const cx = node.x + node.width / 2;
      const cy = node.y + node.height / 2;
      shape =
        `<polygon points="${n(cx)},${n(node.y)} ${n(node.x + node.width)},${n(cy)} ` +
        `${n(cx)},${n(node.y + node.height)} ${n(node.x)},${n(cy)}" ${body}/>`;
      break;
    }
    case "terminal":
      shape = rect(node.x, node.y, node.width, node.height, node.height / 2, body);
      break;
    case "process":
      shape = rect(node.x, node.y, node.width, node.height, 14, body);
      break;
    default:
      throw new Error(`renderSvg: node "${node.id}" has unsupported shape "${String(node.shape)}"`);
  }
  const caption = captionBlock(
    node.id,
    node.x + node.width / 2,
    node.y + (node.height - captionHeight(node, palette)) / 2,
    node.labelLines,
    node.subtitleLines,
    palette,
  );
  return `<g data-node="${escapeXml(node.id)}">${shape}${caption}</g>`;
}

function renderNode(node: SceneNode, icons: IconMap, palette: Theme): string {
  if (node.shape === "service") return renderServiceNode(node, icons, palette);
  return renderBodyNode(node, palette);
}

/** Arrow markers, one per edge paint so markers inherit the right colour. */
function renderMarkers(palette: Theme): string {
  const marker = (id: string, color: string) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" ` +
    `orient="auto" markerUnits="userSpaceOnUse">` +
    `<path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/></marker>`;
  return (
    marker("arrow-primary", palette.primary) +
    marker("arrow-secondary", palette.secondary) +
    marker("arrow-async", palette.secondary)
  );
}

/**
 * Centred edge label inside the label rectangle the layout reserved.
 *
 * Multiline label text is split into separate `<text>` baselines because SVG
 * has no automatic line breaking; the block is vertically centred on the box.
 */
function renderEdgeLabel(edge: SceneEdge, palette: Theme): string {
  const box = edge.label;
  if (!box || !box.text.trim()) return "";
  const textLines = lines(box.text);
  const lineHeight = palette.subtitleLineHeight;
  const style = edgeStyle(edge.kind, palette);
  const content = textLines
    .map((line, index) => {
      const center = box.y + box.height / 2 + (index - (textLines.length - 1) / 2) * lineHeight;
      return (
        `<text x="${n(box.x + box.width / 2)}" y="${n(baseline(center, palette.edgeSize))}" ` +
        `fill="${style.color}" font-family="${escapeXml(palette.monoFamily)}" font-size="${palette.edgeSize}" ` +
        `text-anchor="middle">${escapeXml(line)}</text>`
      );
    })
    .join("");
  return `<g data-label="${escapeXml(edge.id)}">${content}</g>`;
}

function renderEdge(edge: SceneEdge, nodeIds: Set<string>, palette: Theme): string {
  if (!Array.isArray(edge.points) || edge.points.length < 2) {
    throw new Error(`renderSvg: edge "${edge.id}" has fewer than two points`);
  }
  // Endpoints are not needed for painting, but a dangling reference means the
  // scene is inconsistent; failing here surfaces it in the preview instead of
  // only when the user exports. Coordinates still come from `points`.
  if (!nodeIds.has(edge.source)) {
    throw new Error(`renderSvg: edge "${edge.id}" references unknown source node "${edge.source}"`);
  }
  if (!nodeIds.has(edge.target)) {
    throw new Error(`renderSvg: edge "${edge.id}" references unknown target node "${edge.target}"`);
  }
  const style = edgeStyle(edge.kind, palette);
  const marker = `arrow-${edge.kind}`;
  const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : "";
  const d = edge.points.map((point, index) => `${index === 0 ? "M" : "L"} ${n(point.x)} ${n(point.y)}`).join(" ");
  const path =
    `<path d="${d}" fill="none" stroke="${style.color}" stroke-width="${style.width}" ` +
    `stroke-linejoin="round" stroke-linecap="round"${dash} marker-end="url(#${marker})"/>`;
  return `<g data-edge="${escapeXml(edge.id)}" data-kind="${edge.kind}">${path}${renderEdgeLabel(edge, palette)}</g>`;
}

/**
 * Render a laid-out scene as a standalone SVG document.
 *
 * @param scene Absolute-geometry scene produced by the layout pass.
 * @param icons Alias to self-contained `data:image/...` URI map.
 * @param options `grid: false` leaves the canvas transparent for a host-drawn grid.
 * @throws When an icon alias is missing/non-data, an edge has no geometry, or a
 *   node shape/card is not representable. The export never drops content silently.
 */
export function renderSvg(scene: Scene, icons: IconMap, options: SvgRenderOptions = {}): string {
  // A zero viewBox is invalid and NaN stringifies into broken markup, so the
  // document always gets a finite, positive canvas even for an empty scene.
  const width = Number.isFinite(scene.width) ? Math.max(1, scene.width) : 1;
  const height = Number.isFinite(scene.height) ? Math.max(1, scene.height) : 1;

  const palette = options.palette ?? lightTheme;
  const markers = renderMarkers(palette);
  // With `grid: false` neither the pattern nor the backdrop rects are emitted:
  // the canvas must stay transparent so a host page's own graph paper shows
  // through, and an unused pattern def would only add weight.
  const grid = options.grid !== false;
  const gridLayer = grid ? renderGrid(width, height, palette) : null;
  const groups = orderGroups(scene.groups).map((group) => renderGroup(group, palette)).join("");
  const nodeIds = new Set(scene.nodes.map((node) => node.id));
  const edges = scene.edges.map((edge) => renderEdge(edge, nodeIds, palette)).join("");
  const nodes = scene.nodes.map((node) => renderNode(node, icons, palette)).join("");

  return (
    // No `<?xml ?>` declaration: the same string is injected into the preview
    // DOM, where an XML processing instruction is parsed as a bogus comment.
    // SVG without the declaration is still well-formed XML (UTF-8 default).
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" ` +
    `width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}" role="img">` +
    `<title>${escapeXml(scene.title || "Diagram")}</title>` +
    `<desc>${escapeXml(`Diagram with ${scene.nodes.length} nodes and ${scene.edges.length} connections.`)}</desc>` +
    `<defs>${markers}${gridLayer ? gridLayer.pattern : ""}</defs>` +
    (gridLayer ? gridLayer.body : "") +
    groups +
    edges +
    nodes +
    `</svg>`
  );
}
