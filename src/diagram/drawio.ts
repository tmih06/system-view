import { theme } from "./theme";
import { escapeXml, orderGroups, resolveIconDataUri } from "./svg";
import type { IconMap, Point, Scene, SceneEdge, SceneGroup, SceneNode } from "./types";

/**
 * Editable draw.io (mxGraph) export of an already-laid-out {@link Scene}.
 *
 * The export is structural rather than a screenshot: every visible element
 * becomes an mxCell the user can select, edit and move.
 *
 * Shape mapping (geometry is taken verbatim from the scene):
 * - each group is a `container=1` cell nested under its parent group, so
 *   dragging a panel moves its children and the nesting survives in draw.io;
 * - each node is a transparent `container=1` cell covering the node footprint
 *   and is the cell connectors attach to, with the painted body/card, icon and
 *   caption as non-connectable children;
 * - each edge is a real edge cell with `source`/`target` set to those
 *   containers, explicit fractional exit/entry anchors derived from the first
 *   and last routed points, interior points as waypoints, and its label as the
 *   cell value so it stays editable.
 *
 * draw.io splits the style attribute on `;`, so `data:` URIs must be rewritten
 * before they reach a style: a `;base64,` marker would truncate the image and
 * render a blank box. {@link drawioImageUri} keeps the payload and lets
 * draw.io re-add the marker at load time.
 */

/** Vertical rhythm from the shared contract: caption spacings and line boxes. */
const CAPTION_GAP = 8;
const SUBTITLE_GAP = 3;

/** Cell id prefixes keep ids unique across groups, nodes, edges and children. */
const GROUP_PREFIX = "g-";
const NODE_PREFIX = "n-";
const EDGE_PREFIX = "e-";

function attr(value: string): string {
  return escapeXml(value).replace(/\r?\n/g, "&#10;");
}

/** draw.io turns `\n` inside a non-HTML label value into a line break. */
function labelValue(text: string): string {
  return attr(text.replace(/\r\n?/g, "\n"));
}

/**
 * Rewrite a data URI so it survives draw.io's semicolon-separated style parser.
 *
 * Draw.io embeds images marker-less (`data:image/svg+xml,<base64>`) and adds
 * the `;base64,` marker back in `mxGraph.postProcessCellStyle`; a literal
 * marker in the file truncates the style at `;base64` and the icon disappears.
 * Percent-encoded SVG payloads are kept as-is because draw.io detects the
 * leading `%3C` and does not base64-wrap them, so only stray semicolons need
 * neutralising there. Any other payload is fully percent-encoded.
 */
function drawioImageUri(uri: string, alias: string): string {
  const comma = uri.indexOf(",");
  if (!/^data:image\//i.test(uri) || comma < 0) {
    throw new Error(`renderDrawio: icon alias "${alias}" is not a usable image data URI`);
  }
  // Only the media type matters here; any parameter list (charset, base64)
  // must not survive into the style because draw.io re-adds `;base64` itself.
  const type = (uri.slice("data:".length, comma).split(";")[0] || "").trim().toLowerCase();
  const payload = uri.slice(comma + 1);
  if (payload.length === 0) {
    throw new Error(`renderDrawio: icon alias "${alias}" has an empty data URI payload`);
  }

  if (type === "image/svg+xml") {
    // draw.io leaves percent-encoded SVG alone only when it starts with the
    // literal `%3C`; a lowercase `%3c` would make draw.io prepend a base64
    // marker and break the image, so the first escape is normalised.
    if (/^%3c/i.test(payload)) {
      return `data:${type},%3C${payload.slice(3).replace(/;/g, "%3B")}`;
    }
    if (payload.startsWith("<")) return `data:${type},${encodeURIComponent(payload)}`;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(payload)) {
      throw new Error(`renderDrawio: icon alias "${alias}" has an unsupported SVG payload`);
    }
    return `data:${type},${payload.replace(/\s+/g, "")}`;
  }

  // Non-SVG images are base64 in practice; anything else is escaped so that a
  // semicolon cannot split the style string.
  if (/^[A-Za-z0-9+/=\s]+$/.test(payload)) return `data:${type},${payload.replace(/\s+/g, "")}`;
  return `data:${type},${encodeURIComponent(payload)}`;
}

/**
 * Absolute top-left of a container cell, which its children's geometry is
 * relative to.
 *
 * Scene rectangles are absolute; draw.io child coordinates are relative to the
 * immediate parent container, so a child subtracts exactly one container
 * origin. `orderGroups` has already rejected unknown parents and cycles, so
 * this is a direct lookup.
 */
function groupOrigin(groups: Map<string, SceneGroup>, id: string | undefined): Point {
  if (!id) return { x: 0, y: 0 };
  const group = groups.get(id);
  if (!group) throw new Error(`renderDrawio: unknown group "${id}"`);
  return { x: group.x, y: group.y };
}

function num(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function geometry(x: number, y: number, width: number, height: number): string {
  return `<mxGeometry x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" as="geometry"/>`;
}

function textCell(
  id: string,
  parent: string,
  value: string,
  style: string,
  x: number,
  y: number,
  width: number,
  height: number,
): string {
  return (
    `<mxCell id="${attr(id)}" value="${labelValue(value)}" style="${attr(style)}" vertex="1" ` +
    `parent="${attr(parent)}" connectable="0">${geometry(x, y, width, height)}</mxCell>`
  );
}

function titleStyle(): string {
  return (
    `text;html=0;whiteSpace=nowrap;fillColor=none;strokeColor=none;spacing=0;` +
    `fontFamily=Arial;fontSize=${theme.titleSize};fontStyle=1;fontColor=${theme.ink};` +
    `align=center;verticalAlign=middle;`
  );
}

function subtitleStyle(): string {
  return (
    `text;html=0;whiteSpace=nowrap;fillColor=none;strokeColor=none;spacing=0;` +
    `fontFamily=Courier New;fontSize=${theme.subtitleSize};fontStyle=0;fontColor=${theme.muted};` +
    `align=center;verticalAlign=middle;`
  );
}

function renderGroup(group: SceneGroup, groups: Map<string, SceneGroup>): string {
  const tone = theme.tones[group.tone] ?? theme.tones.neutral;
  const origin = groupOrigin(groups, group.parent);
  const parentId = group.parent ? `${GROUP_PREFIX}${group.parent}` : "1";
  const style =
    `rounded=1;absoluteArcSize=1;arcSize=36;html=0;whiteSpace=nowrap;` +
    `fillColor=${tone.fill};strokeColor=${tone.stroke};strokeWidth=1;` +
    `dashed=${group.dashed ? 1 : 0};dashPattern=4 4;` +
    `align=left;verticalAlign=top;spacingTop=10;spacingLeft=14;` +
    `fontFamily=Arial;fontSize=${theme.groupSize};fontStyle=1;fontColor=${tone.ink};` +
    `container=1;collapsible=0;recursiveResize=0;`;
  return (
    `<mxCell id="${attr(`${GROUP_PREFIX}${group.id}`)}" value="${labelValue(group.label)}" ` +
    `style="${attr(style)}" vertex="1" parent="${attr(parentId)}" connectable="0">` +
    geometry(group.x - origin.x, group.y - origin.y, group.width, group.height) +
    `</mxCell>`
  );
}

/**
 * Card, icon and caption of a service node, positioned inside the node cell.
 *
 * Scene rectangles are absolute while draw.io child geometry is relative to
 * the parent cell, so every child here subtracts the node's own top-left. The
 * captions span the full node width and begin at the card bottom plus the
 * contract's caption gap, matching the footprint the layout reserved.
 */
function renderServiceChildren(nodeId: string, node: SceneNode, icons: IconMap): string {
  if (!node.card) {
    throw new Error(`renderDrawio: service node "${node.id}" has no icon card rectangle`);
  }
  const card = node.card;
  const cells: string[] = [
    `<mxCell id="${attr(`${nodeId}-card`)}" value="" style="${attr(
      `rounded=1;absoluteArcSize=1;arcSize=36;fillColor=#ffffff;strokeColor=${theme.border};strokeWidth=1;`,
    )}" vertex="1" parent="${attr(nodeId)}" connectable="0">` +
      geometry(card.x - node.x, card.y - node.y, card.width, card.height) +
      `</mxCell>`,
  ];

  if (node.icon) {
    const uri = drawioImageUri(
      resolveIconDataUri(icons, node.icon, `renderDrawio: node "${node.id}"`),
      node.icon,
    );
    const size = Math.max(0, Math.min(theme.iconSize, card.width - 8, card.height - 8));
    cells.push(
      `<mxCell id="${attr(`${nodeId}-icon`)}" value="" ` +
        `style="${attr(`shape=image;imageAspect=1;image=${uri};`)}" vertex="1" ` +
        `parent="${attr(nodeId)}" connectable="0">` +
        geometry(
          card.x + (card.width - size) / 2 - node.x,
          card.y + (card.height - size) / 2 - node.y,
          size,
          size,
        ) +
        `</mxCell>`,
    );
  }

  const titleTop = card.y + card.height + CAPTION_GAP;
  const titleHeight = node.labelLines.length * theme.titleLineHeight;
  cells.push(
    textCell(
      `${nodeId}-title`,
      nodeId,
      node.labelLines.join("\n"),
      titleStyle(),
      0,
      titleTop - node.y,
      node.width,
      titleHeight,
    ),
  );
  if (node.subtitleLines.length > 0) {
    cells.push(
      textCell(
        `${nodeId}-subtitle`,
        nodeId,
        node.subtitleLines.join("\n"),
        subtitleStyle(),
        0,
        titleTop + titleHeight + SUBTITLE_GAP - node.y,
        node.width,
        node.subtitleLines.length * theme.subtitleLineHeight,
      ),
    );
  }
  return cells.join("");
}

/** Body shape plus the vertically centred two-tier caption, node-local. */
function renderBodyChildren(nodeId: string, node: SceneNode): string {
  let body: string;
  switch (node.shape) {
    case "decision":
      body = `rhombus;whiteSpace=wrap;html=0;fillColor=#ffffff;strokeColor=${theme.border};strokeWidth=1;`;
      break;
    case "terminal":
      // A pill: SVG uses `height / 2`, and draw.io's absolute arc size is the
      // diameter, clamped by the shorter side, which gives the same radius.
      body =
        `rounded=1;absoluteArcSize=1;arcSize=${num(Math.min(node.width, node.height))};` +
        `whiteSpace=wrap;html=0;fillColor=#ffffff;strokeColor=${theme.border};strokeWidth=1;`;
      break;
    case "process":
      body = `rounded=1;absoluteArcSize=1;arcSize=28;whiteSpace=wrap;html=0;fillColor=#ffffff;strokeColor=${theme.border};strokeWidth=1;`;
      break;
    default:
      throw new Error(`renderDrawio: node "${node.id}" has unsupported shape "${String(node.shape)}"`);
  }

  const titleHeight = node.labelLines.length * theme.titleLineHeight;
  const subtitleHeight = node.subtitleLines.length * theme.subtitleLineHeight;
  const gap = node.labelLines.length > 0 && node.subtitleLines.length > 0 ? SUBTITLE_GAP : 0;
  const blockTop = (node.height - (titleHeight + gap + subtitleHeight)) / 2;
  const cells = [
    `<mxCell id="${attr(`${nodeId}-body`)}" value="" style="${attr(body)}" vertex="1" ` +
      `parent="${attr(nodeId)}" connectable="0">` +
      geometry(0, 0, node.width, node.height) +
      `</mxCell>`,
    textCell(
      `${nodeId}-title`,
      nodeId,
      node.labelLines.join("\n"),
      titleStyle(),
      0,
      blockTop,
      node.width,
      titleHeight,
    ),
  ];
  if (node.subtitleLines.length > 0) {
    cells.push(
      textCell(
        `${nodeId}-subtitle`,
        nodeId,
        node.subtitleLines.join("\n"),
        subtitleStyle(),
        0,
        blockTop + titleHeight + gap,
        node.width,
        subtitleHeight,
      ),
    );
  }
  return cells.join("");
}

/** A transparent connectable container per node, holding its painted parts. */
function renderNode(node: SceneNode, groupParent: string, origin: Point, icons: IconMap): string {
  const id = `${NODE_PREFIX}${node.id}`;
  const containerStyle =
    `fillColor=none;strokeColor=none;html=0;whiteSpace=nowrap;` +
    `container=1;collapsible=0;recursiveResize=0;`;
  const children =
    node.shape === "service" ? renderServiceChildren(id, node, icons) : renderBodyChildren(id, node);
  return (
    `<mxCell id="${attr(id)}" value="" style="${attr(containerStyle)}" vertex="1" ` +
    `parent="${attr(groupParent)}" connectable="1">` +
    geometry(node.x - origin.x, node.y - origin.y, node.width, node.height) +
    `</mxCell>` +
    children
  );
}

/** Fractional exit/entry coordinates for the routed point on a node edge. */
function anchorFraction(point: Point, node: SceneNode): { x: number; y: number } {
  if (node.width === 0 || node.height === 0) return { x: 0.5, y: 0.5 };
  return { x: (point.x - node.x) / node.width, y: (point.y - node.y) / node.height };
}

/**
 * Point halfway along the routed polyline.
 *
 * draw.io centres a relative edge label at `geometry.x/2` of the path length
 * (0.5 when `x` is omitted), and applies `offset` in absolute units on top.
 * The label offset below is the difference between that point and the scene's
 * label rectangle centre, which keeps the exported label where the layout put
 * it while leaving it draggable along the edge.
 */
function polylineMidpoint(points: Point[]): Point {
  const segments: { from: Point; to: Point; length: number }[] = [];
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1];
    const to = points[index];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    segments.push({ from, to, length });
    total += length;
  }
  if (total === 0) return points[0];
  let remaining = total / 2;
  for (const segment of segments) {
    if (remaining <= segment.length) {
      const t = segment.length === 0 ? 0 : remaining / segment.length;
      return {
        x: segment.from.x + (segment.to.x - segment.from.x) * t,
        y: segment.from.y + (segment.to.y - segment.from.y) * t,
      };
    }
    remaining -= segment.length;
  }
  return points[points.length - 1];
}

function renderEdge(edge: SceneEdge, nodes: Map<string, SceneNode>): string {
  if (!Array.isArray(edge.points) || edge.points.length < 2) {
    throw new Error(`renderDrawio: edge "${edge.id}" has fewer than two points`);
  }
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  if (!source) throw new Error(`renderDrawio: edge "${edge.id}" references unknown source node "${edge.source}"`);
  if (!target) throw new Error(`renderDrawio: edge "${edge.id}" references unknown target node "${edge.target}"`);

  const first = edge.points[0];
  const last = edge.points[edge.points.length - 1];
  const exit = anchorFraction(first, source);
  const entry = anchorFraction(last, target);

  const primary = edge.kind === "primary";
  const color = primary ? theme.primary : theme.secondary;
  const width = primary ? 1.5 : 1.2;
  const dashed = edge.kind === "async";
  const style =
    `edgeStyle=none;rounded=0;html=0;whiteSpace=nowrap;` +
    `endArrow=block;endFill=1;endSize=6;strokeWidth=${width};strokeColor=${color};` +
    `fontFamily=Courier New;fontSize=${theme.edgeSize};fontColor=${color};labelBackgroundColor=none;` +
    `dashed=${dashed ? 1 : 0};dashPattern=5 4;` +
    `exitX=${num(exit.x)};exitY=${num(exit.y)};exitDx=0;exitDy=0;exitPerimeter=0;` +
    `entryX=${num(entry.x)};entryY=${num(entry.y)};entryDx=0;entryDy=0;entryPerimeter=0;`;

  // Interior routed points become movable waypoints; terminals stay anchors.
  const waypoints: Point[] = [];
  for (const point of edge.points.slice(1, -1)) {
    const previous = waypoints[waypoints.length - 1];
    if (!previous || previous.x !== point.x || previous.y !== point.y) waypoints.push(point);
  }

  const parts: string[] = [];
  // draw.io writes waypoints before the label offset; keep that order so the
  // file matches the format its own serializer round-trips.
  if (waypoints.length > 0) {
    parts.push(
      `<Array as="points">` +
        waypoints.map((point) => `<mxPoint x="${num(point.x)}" y="${num(point.y)}"/>`).join("") +
        `</Array>`,
    );
  }
  if (edge.label) {
    const mid = polylineMidpoint(edge.points);
    const centerX = edge.label.x + edge.label.width / 2;
    const centerY = edge.label.y + edge.label.height / 2;
    parts.push(`<mxPoint x="${num(centerX - mid.x)}" y="${num(centerY - mid.y)}" as="offset"/>`);
  }

  const label = edge.label?.text ?? "";
  return (
    `<mxCell id="${attr(`${EDGE_PREFIX}${edge.id}`)}" value="${labelValue(label)}" style="${attr(style)}" ` +
    `edge="1" parent="1" source="${attr(`${NODE_PREFIX}${edge.source}`)}" ` +
    `target="${attr(`${NODE_PREFIX}${edge.target}`)}">` +
    `<mxGeometry relative="1" as="geometry">${parts.join("")}</mxGeometry></mxCell>`
  );
}

/**
 * Reject duplicate mxCell ids in the generated document.
 *
 * draw.io keys its model by cell id, so a scene whose node id makes one
 * generated child id equal another cell's id (for example nodes "a" and
 * "a-card") would silently merge or drop cells. Scanning the finished document
 * keeps validation in one place instead of duplicating the naming scheme.
 */
function assertUniqueCellIds(xml: string): void {
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<mxCell id="([^"]*)"/g)) {
    const id = match[1];
    if (seen.has(id)) {
      throw new Error(`renderDrawio: generated duplicate cell id "${id}"; rename the conflicting scene id`);
    }
    seen.add(id);
  }
}

/**
 * Render a laid-out scene as an editable draw.io document.
 *
 * @param scene Absolute-geometry scene produced by the layout pass; geometry is
 *   never recomputed, only rebased onto parent containers.
 * @param icons Alias to self-contained `data:image/...` URI map.
 * @throws When an icon alias is missing/invalid, an edge references an unknown
 *   node or has no geometry, a group parent is unknown, a generated cell id
 *   would collide, or a node shape/card cannot be represented.
 *
 * Known rendering difference: draw.io fixed text uses its own 1.2 line-height
 * constant, while the scene reserves 17px/14px line boxes. Caption cells keep
 * the scene's rectangle and centre their text inside it, so a multi-line block
 * is drawn slightly tighter than the SVG export but never moves the layout.
 */
export function renderDrawio(scene: Scene, icons: IconMap): string {
  const groups = new Map<string, SceneGroup>(scene.groups.map((group) => [group.id, group]));
  const nodes = new Map<string, SceneNode>();
  for (const node of scene.nodes) {
    if (nodes.has(node.id)) throw new Error(`renderDrawio: duplicate node id "${node.id}"`);
    nodes.set(node.id, node);
  }
  for (const node of scene.nodes) {
    if (node.parent && !groups.has(node.parent)) {
      throw new Error(`renderDrawio: node "${node.id}" references unknown group "${node.parent}"`);
    }
  }

  const groupCells = orderGroups(scene.groups)
    .map((group) => renderGroup(group, groups))
    .join("");
  const nodeCells = scene.nodes
    .map((node) =>
      renderNode(
        node,
        node.parent ? `${GROUP_PREFIX}${node.parent}` : "1",
        groupOrigin(groups, node.parent),
        icons,
      ),
    )
    .join("");
  const edgeCells = scene.edges.map((edge) => renderEdge(edge, nodes)).join("");

  const width = Number.isFinite(scene.width) ? Math.max(1, Math.round(scene.width)) : 1;
  const height = Number.isFinite(scene.height) ? Math.max(1, Math.round(scene.height)) : 1;

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<mxfile host="app.diagrams.net" agent="d2-rich-icons" version="26.0.0" type="device">` +
    `<diagram id="diagram" name="${attr(scene.title || "Diagram")}">` +
    `<mxGraphModel dx="${width}" dy="${height}" grid="1" gridSize="24" guides="1" tooltips="1" ` +
    `connect="1" arrows="1" fold="0" page="0" pageWidth="${width}" pageHeight="${height}" ` +
    `background="${theme.background}" math="0" shadow="0">` +
    `<root><mxCell id="0"/><mxCell id="1" parent="0"/>` +
    groupCells +
    nodeCells +
    edgeCells +
    `</root></mxGraphModel></diagram></mxfile>`;

  assertUniqueCellIds(xml);
  return xml;
}
