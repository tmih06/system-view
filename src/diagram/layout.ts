import {
  collectEdges,
  collectRects,
  edgePolyline,
  loadEngine,
  num,
  orderedSections,
  type ElkEngine,
  type ElkGraphEdge,
  type ElkGraphNode,
  type ElkPort,
} from "./elk";
import { theme } from "./theme";
import type {
  Direction,
  EdgeKind,
  MeasureText,
  Point,
  Rect,
  Scene,
  SceneEdge,
  SceneGroup,
  SceneNode,
  Shape,
  Side,
  Tone,
} from "./types";

/**
 * Coordinate-free diagram layout.
 *
 * `layoutDiagram` validates an untrusted `DiagramSpec`, measures every caption
 * with the caller's text measurement callback, hands a sized graph to ELK's
 * layered algorithm and translates the result into a `Scene` whose coordinates
 * are all absolute. No pixel geometry is accepted from the input, and none is
 * invented here: every number either comes from measured text, from an anchor
 * position ELK must respect, or from ELK's own output.
 *
 * Two strategies, chosen by graph shape:
 *
 * - **One run** for a plain graph of nodes, or a single panel. One ELK run with
 *   `INCLUDE_CHILDREN` routes connectors across group boundaries, which a
 *   per-group recursive layout cannot do.
 * - **Panel composition** for a canvas holding several panels (see
 *   {@link layoutComposed}). One run per panel decides its interior, then one run
 *   places the panels as fixed boxes. This is what gives a canvas of large panels
 *   its overall shape: a single run either flattens every panel into one wide
 *   strip or, with wrapping enabled, throws inside ELK as soon as a connector
 *   crosses a wrapped panel's border.
 *
 * Shared between both strategies:
 * - Each node rectangle is sized to its *full footprint* (icon card plus caption,
 *   or a body shape's text block). Footprints are obstacles, so captions are
 *   protected from connectors by construction.
 * - Connector anchors are explicit ports pinned with `FIXED_POS`, so east/west
 *   endpoints sit at icon-card centre height rather than at the border of the
 *   wider, invisible caption box. The single-run path then pulls those endpoints
 *   onto the visible card edge; north/south endpoints already meet the footprint
 *   border.
 *
 * Documented limits:
 * - In the single-run strategy a group's own `direction` is honoured only when
 *   the group is *closed*: no connector crosses its border. ELK cannot lay out a
 *   self-directed subtree in its own run and still route crossing connectors, so
 *   an open group follows the enclosing direction. The composed strategy has no
 *   such limit and honours every panel's direction.
 * - `flow` is a routing preference: existing edges along the declared chain get a
 *   high straightness priority. It never adds connections and never guarantees
 *   exact alignment.
 */
const CARD = theme.cardSize;
const CAPTION_GAP = 8;
const SUBTITLE_GAP = 3;
const TITLE_LINE_HEIGHT = theme.titleLineHeight;
const SUBTITLE_LINE_HEIGHT = theme.subtitleLineHeight;

/** Wrap width for service captions; wider titles wrap instead of widening cards. */
const CAPTION_WRAP = 172;
/** Wrap width inside process/terminal bodies. */
const BODY_WRAP = 184;
/** Wrap width inside decision diamonds, which need about twice the text width. */
const DECISION_WRAP = 136;
/** Wrap width for connector labels. */
const EDGE_LABEL_WRAP = 176;

const BODY_PAD_X = 18;
const BODY_PAD_Y = 13;
const BODY_MIN_WIDTH = 120;
const BODY_MIN_HEIGHT = 52;
const DECISION_MIN_WIDTH = 152;
const DECISION_MIN_HEIGHT = 96;

const GROUP_PAD_TOP = 34;
const GROUP_PAD_SIDE = 18;
const GROUP_PAD_BOTTOM = 18;
/** Horizontal room a group label needs beside its padding. */
const GROUP_LABEL_GUTTER = 12;
const ROOT_PAD = 24;

const NODE_SPACING = 36;
const LAYER_SPACING = 64;
const COMPONENT_SPACING = 48;
const EDGE_NODE_SPACING = 18;
const EDGE_EDGE_SPACING = 12;
const EDGE_LABEL_SPACING = 6;

/**
 * Direction perpendicular to each direction.
 *
 * A panel inside a horizontal canvas flows vertically by default, so the canvas
 * reads as columns of members instead of one wide row of cards.
 */
const PERPENDICULAR: Record<Direction, Direction> = { right: "down", left: "down", down: "right", up: "right" };
/** A `down` panel with more cards than this becomes a grid instead of one column. */
const GRID_ROWS_BEFORE_WRAP = 6;
/**
 * Target width/height for a wrapped panel.
 *
 * Members flow down a column and the columns wrap, so ~0.5 gives two columns for
 * a nine-card panel: a grid read at a glance instead of a 1300 px strip.
 */
const PANEL_WRAP_ASPECT = "0.5";
/** Centre of a rectangle; the reference point a connector aims at. */
function centreOf(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Which side of a rectangle a point sits on.
 *
 * The nearest edge wins. Used to give a border crossing its departure side, so a
 * wire leaves the panel it came from heading outward instead of doubling back.
 */
function sideAtRect(point: Point, rect: Rect): Side {
  const distances: Array<[Side, number]> = [
    ["west", Math.abs(point.x - rect.x)],
    ["east", Math.abs(point.x - (rect.x + rect.width))],
    ["north", Math.abs(point.y - rect.y)],
    ["south", Math.abs(point.y - (rect.y + rect.height))],
  ];
  return distances.reduce((best, candidate) => (candidate[1] < best[1] ? candidate : best))[0];
}

/**
 * Pack elements into rows in declaration order.
 *
 * A deterministic packer, not a solver, because the canvas composition is an
 * authoring decision: the panels appear in the order the script lists them, and
 * the only variable is where a row breaks. Sizing each panel happens in an
 * earlier pass, so this only has to decide positions.
 *
 * Rows fill left to right until the next element would push the row past the
 * target length, then start a new row. A row is as tall as its tallest member and
 * every member is top-aligned, which keeps panel headings on a common line.
 *
 * @param items Element ids with their measured size, in declaration order.
 * @param gap Space between neighbours, on both axes.
 * @param targetAspect Desired width/height of the packed block.
 * @returns Absolute top-left position of each element, plus the block's extent.
 */
function packInOrder(
  items: Array<{ id: string; width: number; height: number }>,
  gap: number,
  targetAspect: number,
): Map<string, Point> {
  if (items.length === 0) return new Map();

  /**
   * Row layout with a cap on how many elements share a row.
   *
   * A width limit cannot express this correctly: three equal panels split evenly
   * in half is `total / 2`, which is less than two panels plus a gap, so every
   * row would hold one panel and the canvas would grow into a column. Capping the
   * row *count* instead makes "two per row" directly reachable.
   */
  const fillWith = (cap: number): { positions: Map<string, Point>; width: number; height: number } => {
    const positions = new Map<string, Point>();
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    let widest = 0;
    let inRow = 0;
    for (const item of items) {
      if (inRow > 0 && inRow >= cap) {
        widest = Math.max(widest, x - gap);
        x = 0;
        y += rowHeight + gap;
        rowHeight = 0;
        inRow = 0;
      }
      positions.set(item.id, { x, y });
      x += item.width + gap;
      rowHeight = Math.max(rowHeight, item.height);
      inRow += 1;
    }
    return { positions, width: Math.max(widest, x - gap), height: y + rowHeight };
  };

  // Try every cap and keep the canvas closest to the requested aspect. A cap is a
  // direct, understandable knob ("at most N panels per row"), and the search is
  // cheap because a canvas has a handful of top-level elements.
  let best: { positions: Map<string, Point>; width: number; height: number } | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let cap = 1; cap <= items.length; cap += 1) {
    const candidate = fillWith(cap);
    const score = Math.abs(candidate.width / Math.max(1, candidate.height) - targetAspect);
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = candidate;
    }
  }
  return best!.positions;
}

/**
 * Orthogonal route that treats rectangles as obstacles.
 *
 * Used where ELK cannot help: a connector that crosses a panel border has to
 * reach one specific card inside a panel that another run already laid out, and
 * a naive L or Z shape would cut straight through the cards in between.
 *
 * The approach is a visibility grid. Candidate lines are the free channels beside
 * every obstacle and the two endpoints, so any path along them is guaranteed to
 * stay clear of the cards and the result can never clip one. A breadth-first
 * search over that grid gives the fewest-turns route, and collinear points are
 * merged afterwards so the polyline has no redundant corners.
 *
 * @param start Absolute start point, outside every obstacle.
 * @param end Absolute end point.
 * @param obstacles Rectangles that must not be entered.
 * @returns An axis-aligned polyline from `start` to `end`.
 */
function routeAround(start: Point, end: Point, obstacles: Rect[]): Point[] {
  const clearance = NODE_SPACING / 2;
  const axis = (values: number[]): number[] => [...new Set(values.map((value) => Math.round(value)))].sort((a, b) => a - b);

  // Candidate lines: both endpoints, every obstacle's clearance edges, and the
  // midpoint channels between them. Seeding both of the start's and the goal's
  // coordinates is what lets the first and last legs be horizontal *or*
  // vertical.
  /**
   * Candidate grid lines.
   *
   * Both endpoints seed a line, so the first and last legs may run either way.
   * Every obstacle contributes its two clearance edges. The midpoints between
   * consecutive lines matter most: that is where the free channel between two
   * cards lies, and without those lines a tight pair of cards reads as solid and
   * the search is forced around the whole panel.
   */
  const withMidpoints = (values: number[]): number[] => {
    const sorted = axis(values);
    const midpoints: number[] = [];
    for (let index = 1; index < sorted.length; index += 1) {
      midpoints.push((sorted[index - 1] + sorted[index]) / 2);
    }
    return axis([...sorted, ...midpoints]);
  };
  const xs = withMidpoints([
    start.x,
    end.x,
    ...obstacles.flatMap((r) => [r.x - clearance, r.x + r.width + clearance]),
  ]);
  const ys = withMidpoints([
    start.y,
    end.y,
    ...obstacles.flatMap((r) => [r.y - clearance, r.y + r.height + clearance]),
  ]);

  /**
   * True when a grid point sits in an obstacle's interior.
   *
   * Strict interior, not the expanded border: a corridor line runs *along* the
   * clearance edge of two neighbouring cards, and treating that line as blocked
   * would close the only channel between them.
   */
  const blocked = (point: Point): boolean =>
    obstacles.some(
      (r) =>
        point.x > r.x + 0.5 &&
        point.x < r.x + r.width - 0.5 &&
        point.y > r.y + 0.5 &&
        point.y < r.y + r.height - 0.5,
    );

  /**
   * True when the open segment between two grid points stays clear.
   *
   * Grid candidates are axis-aligned by construction, so the test is an exact
   * interval overlap against each obstacle's interior — no sampling, and no way
   * for a thin obstacle to slip between two samples.
   */
  const clearBetween = (a: Point, b: Point): boolean => {
    const inset = 0.5;
    for (const r of obstacles) {
      const left = r.x + inset;
      const right = r.x + r.width - inset;
      const top = r.y + inset;
      const bottom = r.y + r.height - inset;
      if (a.y === b.y) {
        if (a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right) return false;
      } else if (a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom) {
        return false;
      }
    }
    return true;
  };

  /**
   * Keep the search inside the region the connector actually needs.
   *
   * The whole canvas is reachable through the gaps between panels, so an
   * unbounded search happily routes the long way round a panel instead of
   * through the empty space beside it. Bounding it to the endpoints' own box,
   * plus one gutter of slack, makes the short way through the gutter win.
   */
  const padding = NODE_SPACING * 2;
  const box = {
    left: Math.min(start.x, end.x) - padding,
    right: Math.max(start.x, end.x) + padding,
    top: Math.min(start.y, end.y) - padding,
    bottom: Math.max(start.y, end.y) + padding,
  };
  const inBox = (point: Point): boolean =>
    point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;

  const key = (x: number, y: number) => `${x},${y}`;
  const startKey = key(start.x, start.y);
  const goalKey = key(end.x, end.y);

  /**
   * Breadth-first search over the grid lines.
   *
   * Breadth-first rather than cheapest-first because every step costs the same
   * distance class: it finds the route with the fewest corridor hops, which is
   * also the one with the fewest turns after collinear points are merged.
   */
  const search = (gridX: number[], gridY: number[], accept: (point: Point) => boolean): Point[] | undefined => {
    const previous = new Map<string, string>();
    const visited = new Set<string>([startKey]);
    const queue: Point[] = [start];
    let found = false;
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (key(current.x, current.y) === goalKey) {
        found = true;
        break;
      }
      const candidates = [...gridX.map((x) => ({ x, y: current.y })), ...gridY.map((y) => ({ x: current.x, y }))];
      for (const candidate of candidates) {
        const id = key(candidate.x, candidate.y);
        if (visited.has(id) || blocked(candidate) || !accept(candidate)) continue;
        if (!clearBetween(current, candidate)) continue;
        visited.add(id);
        previous.set(id, key(current.x, current.y));
        queue.push(candidate);
      }
    }
    if (!found) return undefined;
    const result: Point[] = [];
    for (let cursor: string | undefined = goalKey; cursor !== undefined; cursor = previous.get(cursor)) {
      const [x, y] = cursor.split(",").map(Number);
      result.push({ x, y });
    }
    result.reverse();
    return orthogonalize(result);
  };

  /**
   * A point inside an "allowed" panel is only blocked by that panel's cards, not
   * by the panel outline: a crossing connector legitimately starts inside the
   * panel it is leaving. The caller excludes allowed panels from the obstacle
   * list for exactly this reason, so the search can begin there.
   */
  const narrow = search(xs, ys, inBox);
    if (narrow !== undefined) return narrow;
  // The narrow box had no route (a target card can sit behind another). Widen to
  // the whole canvas and search again: the long way round is still a route that
  // never crosses a card.
  const wideXs = axis([...xs, ...obstacles.flatMap((r) => [r.x - clearance * 4, r.x + r.width + clearance * 4])]);
  const wideYs = axis([...ys, ...obstacles.flatMap((r) => [r.y - clearance * 4, r.y + r.height + clearance * 4])]);
  const wide = search(wideXs, wideYs, () => true);
  if (wide !== undefined) return wide;

  // No clear route at any width: a two-corner path keeps the wire connected
  // rather than dropping it.
  return orthogonalize([start, { x: end.x, y: start.y }, end]);
}

/**
 * Orthogonal route between two border points, around the space between them.
 *
 * Each end steps outward by the node gap, then the two steps are joined through
 * the midpoint of the remaining axis. The result only ever occupies the gutter,
 * so a panel's cards are never crossed by a connector that merely passes by.
 */
function routeBetween(start: Point, startSide: Side, end: Point, endSide: Side): Point[] {
  const reach = NODE_SPACING;
  const step = (point: Point, side: Side): Point => {
    switch (side) {
      case "east":
        return { x: point.x + reach, y: point.y };
      case "west":
        return { x: point.x - reach, y: point.y };
      case "south":
        return { x: point.x, y: point.y + reach };
      case "north":
        return { x: point.x, y: point.y - reach };
    }
  };
  const from = step(start, startSide);
  const to = step(end, endSide);
  const midX = Math.round((from.x + to.x) / 2);
  const midY = Math.round((from.y + to.y) / 2);
  return orthogonalize([from, { x: midX, y: from.y }, { x: midX, y: to.y }, to]);
}

/**
 * Target width/height of the packed canvas.
 *
 * Slightly landscape, which suits a browser pane. It only decides where a row
 * breaks; it never stretches a panel.
 */
const TARGET_CANVAS_ASPECT = 1.35;
/** Card-to-card spacing inside a panel. */
const PANEL_NODE_SPACING = 48;
/** Layer-to-layer spacing inside a panel; wires run down these channels. */
const PANEL_LAYER_SPACING = 72;
/** Clearance between a wire and a card inside a panel. */
const PANEL_EDGE_NODE_SPACING = 24;
/** Clearance between two parallel wires inside a panel. */
const PANEL_EDGE_EDGE_SPACING = 18;

/** Tolerance for treating two coordinates as the same point or the same border. */
const EPS = 0.75;
/** Preference weights for edges on the declared main flow chain. */
const FLOW_DIRECTION = "100";
const FLOW_STRAIGHTNESS = "100";

const TITLE_FONT = `bold ${theme.titleSize}px ${theme.fontFamily}`;
const SUBTITLE_FONT = `${theme.subtitleSize}px ${theme.monoFamily}`;
const GROUP_FONT = `bold ${theme.groupSize}px ${theme.fontFamily}`;
/**
 * Edge label font. Both exporters paint connector labels with the mono family,
 * so measurement has to use it too, otherwise the reserved label box is narrow
 * for the glyphs actually drawn.
 */
const EDGE_FONT = `${theme.edgeSize}px ${theme.monoFamily}`;

const DIRECTIONS = ["right", "down", "left", "up"] as const satisfies readonly Direction[];
const SIDES = ["north", "east", "south", "west"] as const satisfies readonly Side[];
const TONES = ["warm", "cool", "neutral"] as const satisfies readonly Tone[];
const SHAPES = ["service", "process", "decision", "terminal"] as const satisfies readonly Shape[];
const KINDS = ["primary", "secondary", "async"] as const satisfies readonly EdgeKind[];

const ROOT_FIELDS = ["title", "direction", "groups", "nodes", "edges", "flow", "layout", "defaults"];
const DEFAULTS_FIELDS = ["width", "height", "cardX", "cardY", "cardWidth", "cardHeight"];
const GROUP_FIELDS = ["id", "label", "parent", "tone", "dashed", "direction", "columns", "x", "y", "width", "height"];
const NODE_FIELDS = ["id", "label", "subtitle", "icon", "group", "shape", "x", "y", "width", "height", "cardX", "cardY", "cardWidth", "cardHeight"];
const EDGE_FIELDS = ["id", "from", "to", "label", "kind", "fromSide", "toSide", "via", "fromAnchor", "toAnchor", "labelOffset", "labelAt"];
/**
 * Attachment points that follow the icon card instead of the box.
 *
 * A hand-composed diagram attaches most wires at the icon card's left or right
 * edge, at the card's vertical centre. Writing that as a fraction of the whole
 * box (0.851064, 0.278846) hides the intent and breaks as soon as the card or
 * box changes size. The name states the relationship instead.
 */
const ANCHOR_NAMES = ["card-left", "card-right", "card-top", "card-bottom", "card-centre"] as const;
type AnchorName = (typeof ANCHOR_NAMES)[number];

const DIRECTION_TO_ELK: Record<Direction, string> = {
  right: "RIGHT",
  down: "DOWN",
  left: "LEFT",
  up: "UP",
};

/** Side a connector leaves on, and enters on, for a forward edge. */
const OUTGOING_SIDE: Record<Direction, Side> = { right: "east", down: "south", left: "west", up: "north" };
/** Clockwise successor of a side; gives self-loops two distinct anchors. */
const NEXT_SIDE: Record<Side, Side> = { north: "east", east: "south", south: "west", west: "north" };
const PREVIOUS_SIDE: Record<Side, Side> = { north: "west", east: "north", south: "east", west: "south" };

function oppositeSide(side: Side): Side {
  return side === "east" ? "west" : side === "west" ? "east" : side === "north" ? "south" : "north";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidatedGroup {
  id: string;
  label: string;
  parent?: string;
  tone: Tone;
  dashed: boolean;
  direction?: Direction;
  /** Cards per row when this panel is laid out as a grid. */
  columns?: number;
  /** Explicit panel rectangle in manual mode. */
  rect?: Rect;
}

interface ValidatedNode {
  id: string;
  label: string;
  subtitle?: string;
  icon?: string;
  group?: string;
  shape: Shape;
  /** Declaration index; used only as a deterministic reading-order hint. */
  order: number;
  /** Explicit top-left corner and size in manual mode. */
  at?: Point;
  minWidth?: number;
  minHeight?: number;
  /** Explicit icon-card rectangle relative to the node origin, manual mode only. */
  card?: Rect;
}

interface ValidatedEdge {
  /** Emitted identifier: the authored id, or a deterministic generated one. */
  id: string;
  from: string;
  to: string;
  label?: string;
  kind: EdgeKind;
  fromSide?: Side;
  toSide?: Side;
  /** Explicit interior bends in manual mode. */
  via?: Point[];
  /**
   * Attachment on the source box: a fraction pair, or a named position derived
   * from that node's icon card (see {@link namedAnchor}).
   */
  fromAnchor?: Point | AnchorName;
  /** Attachment on the target box, with the same forms as `fromAnchor`. */
  toAnchor?: Point | AnchorName;
  labelOffset?: Point;
  labelAt?: Point;
}

interface ValidatedDiagram {
  title: string;
  direction: Direction;
  groups: ValidatedGroup[];
  nodes: ValidatedNode[];
  edges: ValidatedEdge[];
  flow: string[];
  manual: boolean;
}

type JsonObject = Record<string, unknown>;

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/** Throw a path-qualified validation error. Never returns. */
function fail(path: string, message: string): never {
  throw new Error(`Diagram script ${path}: ${message}`);
}

function readObject(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, `expected an object, received ${describeValue(value)}`);
  }
  return value as JsonObject;
}

function rejectUnknownFields(value: JsonObject, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(path, `unknown field "${key}"; allowed fields are ${allowed.map((name) => `"${name}"`).join(", ")}`);
    }
  }
}

function readString(value: unknown, path: string, requireNonEmpty: boolean): string {
  if (typeof value !== "string") fail(path, `expected a string, received ${describeValue(value)}`);
  if (requireNonEmpty && value.trim() === "") fail(path, "must not be empty");
  return value;
}

function readOptionalString(value: unknown, path: string, requireNonEmpty: boolean): string | undefined {
  return value === undefined ? undefined : readString(value, path, requireNonEmpty);
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, `expected a boolean, received ${describeValue(value)}`);
  return value;
}

function readEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  const received = typeof value === "string" ? `"${value}"` : describeValue(value);
  fail(path, `expected one of ${allowed.map((name) => `"${name}"`).join(", ")}, received ${received}`);
}

function readOptionalEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T | undefined {
  return value === undefined ? undefined : readEnum(value, path, allowed);
}

/** Optional `{x,y}`; manual mode requires pairs, so a half-specified point is an error. */
function readOptionalPoint(value: JsonObject, path: string): Point | undefined {
  const hasX = value.x !== undefined;
  const hasY = value.y !== undefined;
  if (!hasX && !hasY) return undefined;
  if (hasX !== hasY) fail(path, "x and y must be given together");
  const x = readNumber(value.x, `${path}.x`);
  const y = readNumber(value.y, `${path}.y`);
  return { x, y };
}

/** Optional `{width,height}`; either may be omitted, but a negative value is an error. */
function readOptionalSize(value: JsonObject, path: string): { width?: number; height?: number } | undefined {
  if (value.width === undefined && value.height === undefined) return undefined;
  const size: { width?: number; height?: number } = {};
  if (value.width !== undefined) size.width = readNumber(value.width, `${path}.width`);
  if (value.height !== undefined) size.height = readNumber(value.height, `${path}.height`);
  return size;
}

/** Optional `{x,y,width,height}` panel rectangle; all four are required together. */
function readOptionalRect(value: JsonObject, path: string): Rect | undefined {
  const fields = ["x", "y", "width", "height"] as const;
  const present = fields.filter((field) => value[field] !== undefined);
  if (present.length === 0) return undefined;
  if (present.length !== fields.length) {
    fail(path, `group geometry needs all of x, y, width and height; missing ${fields.filter((field) => value[field] === undefined).join(", ")}`);
  }
  const rect = {
    x: readNumber(value.x, `${path}.x`),
    y: readNumber(value.y, `${path}.y`),
    width: readNumber(value.width, `${path}.width`),
    height: readNumber(value.height, `${path}.height`),
  };
  if (rect.width <= 0 || rect.height <= 0) fail(path, "group width and height must be positive");
  return rect;
}

/**
 * Read a finite number.
 *
 * Layout geometry is pixel data, so non-finite values are rejected rather than
 * coerced: a NaN coordinate would silently blank part of the canvas.
 */
function readNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, `expected a finite number, received ${describeValue(value)}`);
  }
  return value;
}

/** Read a positive whole number, such as a grid column count. */
function readPositiveInteger(value: unknown, path: string): number {
  const number = readNumber(value, path);
  if (!Number.isInteger(number) || number < 1) {
    fail(path, `expected a positive whole number, received ${describeValue(value)}`);
  }
  return number;
}

function readArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, `expected an array, received ${describeValue(value)}`);
  return value;
}

/**
 * Validate an untrusted diagram script and normalise it.
 *
 * Mirrors `diagram.schema.json`: unknown fields are rejected rather than
 * silently ignored, ids and labels must be non-empty, ids are unique across
 * groups and nodes, and group parents must exist and be acyclic. Connector
 * cycles are legal (ELK reverses them while breaking cycles); only containment
 * cycles are errors.
 *
 * @throws Error with a path-qualified message, e.g. `edges[2].to: unknown node "api"`.
 */
function validateDiagram(input: unknown): ValidatedDiagram {
  const root = readObject(input, "(root)");
  rejectUnknownFields(root, ROOT_FIELDS, "(root)");

  const title = root.title === undefined ? "" : readString(root.title, "title", false);
  const direction = root.direction === undefined ? "right" : readEnum(root.direction, "direction", DIRECTIONS);
  const manual = root.layout === "manual";

  const rawGroups = root.groups === undefined ? [] : readArray(root.groups, "groups");
  const rawNodes = readArray(root.nodes, "nodes");
  if (rawNodes.length === 0) fail("nodes", "must declare at least one node");

  const groups: ValidatedGroup[] = [];
  const groupById = new Map<string, ValidatedGroup>();
  rawGroups.forEach((entry, index) => {
    const path = `groups[${index}]`;
    const value = readObject(entry, path);
    rejectUnknownFields(value, GROUP_FIELDS, path);
    const id = readString(value.id, `${path}.id`, true);
    if (groupById.has(id)) fail(`${path}.id`, `duplicate group id "${id}"`);
    const group: ValidatedGroup = {
      id,
      label: readString(value.label, `${path}.label`, true),
      parent: readOptionalString(value.parent, `${path}.parent`, true),
      tone: value.tone === undefined ? "neutral" : readEnum(value.tone, `${path}.tone`, TONES),
      dashed: value.dashed === undefined ? false : readBoolean(value.dashed, `${path}.dashed`),
      direction: readOptionalEnum(value.direction, `${path}.direction`, DIRECTIONS),
      columns: value.columns === undefined ? undefined : readPositiveInteger(value.columns, `${path}.columns`),
    };
    const rect = readOptionalRect(value, path);
    if (rect !== undefined) group.rect = rect;
    else if (manual) fail(path, "manual layout requires x, y, width and height on every group");
    groups.push(group);
    groupById.set(id, group);
  });

  for (const group of groups) {
    if (group.parent !== undefined && !groupById.has(group.parent)) {
      fail(`groups[id="${group.id}"].parent`, `unknown group "${group.parent}"`);
    }
  }
  assertAcyclicGroups(groups, groupById);

  /**
   * Values shared by every node.
   *
   * A hand-composed diagram usually gives every card the same box and the same
   * icon square — 35 nodes with one identical `width`/`height` is 70 redundant
   * numbers that must stay in sync. Declaring them once here keeps the script
   * about geometry that actually differs, and a node may still override any
   * field individually.
   */
  const defaults: { width?: number; height?: number; card?: Rect } = {};
  if (root.defaults !== undefined) {
    const path = "defaults";
    const value = readObject(root.defaults, path);
    rejectUnknownFields(value, DEFAULTS_FIELDS, path);
    const size = readOptionalSize(value, path);
    if (size?.width !== undefined) defaults.width = size.width;
    if (size?.height !== undefined) defaults.height = size.height;
    const cardFields = ["cardWidth", "cardHeight"] as const;
    const card = cardFields.filter((field) => value[field] !== undefined);
    if (card.length > 0) {
      if (card.length !== cardFields.length) fail(path, "cardWidth and cardHeight must be given together");
      defaults.card = {
        x: readNumber(value.cardX ?? 0, `${path}.cardX`),
        y: readNumber(value.cardY ?? 0, `${path}.cardY`),
        width: readNumber(value.cardWidth, `${path}.cardWidth`),
        height: readNumber(value.cardHeight, `${path}.cardHeight`),
      };
    } else if (value.cardX !== undefined || value.cardY !== undefined) {
      fail(path, "cardX and cardY require cardWidth and cardHeight");
    }
  }

  const nodes: ValidatedNode[] = [];
  const nodeById = new Map<string, ValidatedNode>();
  rawNodes.forEach((entry, index) => {
    const path = `nodes[${index}]`;
    const value = readObject(entry, path);
    rejectUnknownFields(value, NODE_FIELDS, path);
    const id = readString(value.id, `${path}.id`, true);
    if (nodeById.has(id)) fail(`${path}.id`, `duplicate node id "${id}"`);
    if (groupById.has(id)) fail(`${path}.id`, `id "${id}" is already used by a group`);
    const icon = readOptionalString(value.icon, `${path}.icon`, true);
    if (icon !== undefined && !/^[a-z0-9-]+$/.test(icon)) {
      fail(`${path}.icon`, `expected a lowercase alias such as "cloudflare" or "postgresql", received "${icon}"`);
    }
    const group = readOptionalString(value.group, `${path}.group`, true);
    if (group !== undefined && !groupById.has(group)) fail(`${path}.group`, `unknown group "${group}"`);
    const subtitle = readOptionalString(value.subtitle, `${path}.subtitle`, false);
    const at = readOptionalPoint(value, path);
    const size = readOptionalSize(value, path);
    if (manual && at === undefined) fail(path, "manual layout requires x and y on every node");
    const node: ValidatedNode = {
      id,
      label: readString(value.label, `${path}.label`, true),
      subtitle: subtitle === undefined || subtitle.trim() === "" ? undefined : subtitle,
      icon,
      group,
      order: index,
      shape:
        value.shape === undefined
          ? icon === undefined
            ? "process"
            : "service"
          : readEnum(value.shape, `${path}.shape`, SHAPES),
    };
    if (at !== undefined) node.at = at;
    const width = size?.width ?? defaults.width;
    const height = size?.height ?? defaults.height;
    if (width !== undefined) node.minWidth = width;
    if (height !== undefined) node.minHeight = height;
    const fields = ["cardWidth", "cardHeight"] as const;
    const card = fields.map((field) => value[field]).filter((entry) => entry !== undefined);
    if (card.length > 0) {
      if (card.length !== fields.length) fail(path, "cardWidth and cardHeight must be given together");
      node.card = {
        x: readNumber(value.cardX ?? 0, `${path}.cardX`),
        y: readNumber(value.cardY ?? 0, `${path}.cardY`),
        width: readNumber(value.cardWidth, `${path}.cardWidth`),
        height: readNumber(value.cardHeight, `${path}.cardHeight`),
      };
    } else if (value.cardX !== undefined || value.cardY !== undefined) {
      fail(path, "cardX and cardY require cardWidth and cardHeight");
    } else if (defaults.card !== undefined) {
      // A shared card rectangle keeps every icon square identical, which is what
      // makes a traced grid of cards line up. It is relative to the node origin,
      // so a node that overrides only `width` keeps the same card inset.
      node.card = { ...defaults.card };
    }
    nodes.push(node);
    nodeById.set(id, node);
  });

  const rawEdges = readArray(root.edges, "edges");
  const edges: ValidatedEdge[] = [];
  const explicitIds = new Set<string>();
  rawEdges.forEach((entry, index) => {
    const path = `edges[${index}]`;
    const value = readObject(entry, path);
    rejectUnknownFields(value, EDGE_FIELDS, path);
    const explicitId = readOptionalString(value.id, `${path}.id`, true);
    if (explicitId !== undefined) {
      if (explicitIds.has(explicitId)) fail(`${path}.id`, `duplicate edge id "${explicitId}"`);
      explicitIds.add(explicitId);
    }
    const from = readString(value.from, `${path}.from`, true);
    const to = readString(value.to, `${path}.to`, true);
    if (!nodeById.has(from)) fail(`${path}.from`, `unknown node "${from}"`);
    if (!nodeById.has(to)) fail(`${path}.to`, `unknown node "${to}"`);
    const label = readOptionalString(value.label, `${path}.label`, false);
    const edge: ValidatedEdge = {
      id: explicitId ?? "",
      from,
      to,
      label: label === undefined || label.trim() === "" ? undefined : label,
      kind: value.kind === undefined ? "secondary" : readEnum(value.kind, `${path}.kind`, KINDS),
      fromSide: readOptionalEnum(value.fromSide, `${path}.fromSide`, SIDES),
      toSide: readOptionalEnum(value.toSide, `${path}.toSide`, SIDES),
    };
    for (const key of ["fromAnchor", "toAnchor"] as const) {
      if (value[key] === undefined) continue;
      const anchorPath = `${path}.${key}`;
      if (typeof value[key] === "string") {
        // A named anchor is resolved against the node's measured icon card later,
        // so the script never repeats a fraction that depends on card geometry.
        edge[key] = readEnum(value[key], anchorPath, ANCHOR_NAMES);
        continue;
      }
      const fraction = readObject(value[key], anchorPath);
      rejectUnknownFields(fraction, ["x", "y"], anchorPath);
      const point = {
        x: readNumber(fraction.x, `${anchorPath}.x`),
        y: readNumber(fraction.y, `${anchorPath}.y`),
      };
      // Fractions slightly outside 0..1 are legitimate perimeter offsets: a
      // traced connector may attach just above or beside the authored box.
      if (Math.abs(point.x) > 2 || Math.abs(point.y) > 2) {
        fail(anchorPath, "anchor fractions must be near the 0..1 box range");
      }
      edge[key] = point;
    }
    if (value.labelAt !== undefined) {
      const atPath = `${path}.labelAt`;
      const origin = readObject(value.labelAt, atPath);
      rejectUnknownFields(origin, ["x", "y"], atPath);
      edge.labelAt = { x: readNumber(origin.x, `${atPath}.x`), y: readNumber(origin.y, `${atPath}.y`) };
    }
    if (value.labelOffset !== undefined) {
      const offsetPath = `${path}.labelOffset`;
      const offset = readObject(value.labelOffset, offsetPath);
      rejectUnknownFields(offset, ["x", "y"], offsetPath);
      edge.labelOffset = {
        x: readNumber(offset.x, `${offsetPath}.x`),
        y: readNumber(offset.y, `${offsetPath}.y`),
      };
    }
    if (value.via !== undefined) {
      edge.via = readArray(value.via, `${path}.via`).map((point, index) => {
        const entry = readObject(point, `${path}.via[${index}]`);
        rejectUnknownFields(entry, ["x", "y"], `${path}.via[${index}]`);
        return { x: readNumber(entry.x, `${path}.via[${index}].x`), y: readNumber(entry.y, `${path}.via[${index}].y`) };
      });
    }
    edges.push(edge);
  });

  // Deterministic ids for edges authored without one; explicit ids win and are
  // never reused, so every SceneEdge id is unique.
  const usedIds = new Set<string>(explicitIds);
  for (const edge of edges) {
    if (edge.id !== "") continue;
    const base = `${edge.from}->${edge.to}`;
    let candidate = base;
    for (let suffix = 2; usedIds.has(candidate); suffix += 1) candidate = `${base}~${suffix}`;
    usedIds.add(candidate);
    edge.id = candidate;
  }

  const flow = root.flow === undefined ? [] : readFlow(root.flow, edges, nodeById);

  return { title, direction, groups, nodes, edges, flow, manual };
}

/** Reject containment cycles such as `a.parent = b` and `b.parent = a`. */
function assertAcyclicGroups(groups: ValidatedGroup[], groupById: Map<string, ValidatedGroup>): void {
  for (const group of groups) {
    const chain: string[] = [group.id];
    const seen = new Set<string>(chain);
    let parent = group.parent;
    while (parent !== undefined) {
      if (seen.has(parent)) {
        fail(`groups[id="${group.id}"].parent`, `containment cycle: ${[...chain, parent].join(" -> ")}`);
      }
      seen.add(parent);
      chain.push(parent);
      parent = groupById.get(parent)?.parent;
    }
  }
}

/**
 * Validate the optional preferred flow chain.
 *
 * The chain is a preference: consecutive nodes must already be connected by a
 * directed edge, and those edges get a high straightness priority. It never
 * adds connections and never forces exact alignment.
 */
function readFlow(value: unknown, edges: ValidatedEdge[], nodeById: Map<string, ValidatedNode>): string[] {
  const entries = readArray(value, "flow");
  const flow: string[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const path = `flow[${index}]`;
    const id = readString(entry, path, true);
    if (seen.has(id)) fail(path, `duplicate node "${id}" in flow`);
    if (!nodeById.has(id)) fail(path, `unknown node "${id}"`);
    seen.add(id);
    flow.push(id);
  });
  for (let index = 1; index < flow.length; index += 1) {
    const from = flow[index - 1];
    const to = flow[index];
    if (!edges.some((edge) => edge.from === from && edge.to === to)) {
      fail(`flow[${index - 1}..${index}]`, `no directed connection "${from}" -> "${to}"; flow must follow existing edges`);
    }
  }
  return flow;
}

// ---------------------------------------------------------------------------
// Text measurement and node metrics
// ---------------------------------------------------------------------------

interface MeasuredText {
  lines: string[];
  width: number;
  height: number;
}

/**
 * Greedy word wrap using the caller's measurement callback.
 *
 * Explicit newlines are hard breaks. A single word wider than `maxWidth` stays
 * on its own line: breaking inside a word would misreport what the renderer
 * draws, and an over-wide node is better than a measurement lie.
 */
function measureTextBlock(
  text: string,
  font: string,
  maxWidth: number,
  lineHeight: number,
  measure: MeasureText,
): MeasuredText {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    const words = paragraph.split(/\s+/).filter((word) => word !== "");
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = words[0];
    for (const word of words.slice(1)) {
      const candidate = `${current} ${word}`;
      if (measure(candidate, font) <= maxWidth) current = candidate;
      else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  let width = 0;
  for (const line of lines) width = Math.max(width, measure(line, font));
  return { lines, width, height: lines.length * lineHeight };
}

interface NodeMetrics {
  node: ValidatedNode;
  shape: Shape;
  width: number;
  height: number;
  labelLines: string[];
  subtitleLines: string[];
  /** Icon card relative to the node origin; service nodes only. */
  card: Rect | null;
  /** Local y of the east/west attachment points. */
  sideY: number;
}

/**
 * Size one node from its measured caption.
 *
 * Service nodes stack card and caption, so the footprint always covers the
 * caption. Body shapes must fit a centred title/subtitle block inside the
 * shape; a decision diamond needs roughly twice the text box because the text
 * sits on the diamond's inscribed rectangle.
 */
function measureNode(node: ValidatedNode, measure: MeasureText): NodeMetrics {
  const wrap = node.shape === "service" ? CAPTION_WRAP : node.shape === "decision" ? DECISION_WRAP : BODY_WRAP;
  const title = measureTextBlock(node.label, TITLE_FONT, wrap, TITLE_LINE_HEIGHT, measure);
  const subtitle =
    node.subtitle === undefined
      ? { lines: [] as string[], width: 0, height: 0 }
      : measureTextBlock(node.subtitle, SUBTITLE_FONT, wrap, SUBTITLE_LINE_HEIGHT, measure);
  const textWidth = Math.max(title.width, subtitle.width);

  if (node.shape === "service") {
    const width = Math.max(CARD, Math.ceil(textWidth));
    const height =
      CARD + CAPTION_GAP + title.height + (subtitle.lines.length > 0 ? SUBTITLE_GAP + subtitle.height : 0);
    return {
      node,
      shape: node.shape,
      width,
      height,
      labelLines: title.lines,
      subtitleLines: subtitle.lines,
      card: { x: (width - CARD) / 2, y: 0, width: CARD, height: CARD },
      sideY: CARD / 2,
    };
  }

  const textHeight = title.height + (subtitle.lines.length > 0 ? SUBTITLE_GAP + subtitle.height : 0);
  const width =
    node.shape === "decision"
      ? Math.max(DECISION_MIN_WIDTH, Math.ceil(textWidth * 2) + BODY_PAD_X)
      : Math.max(BODY_MIN_WIDTH, Math.ceil(textWidth) + BODY_PAD_X * 2);
  const height =
    node.shape === "decision"
      ? Math.max(DECISION_MIN_HEIGHT, Math.ceil(textHeight * 2) + BODY_PAD_Y)
      : Math.max(BODY_MIN_HEIGHT, Math.ceil(textHeight) + BODY_PAD_Y * 2);
  return {
    node,
    shape: node.shape,
    width,
    height,
    labelLines: title.lines,
    subtitleLines: subtitle.lines,
    card: null,
    sideY: height / 2,
  };
}

// ---------------------------------------------------------------------------
// Graph structure
// ---------------------------------------------------------------------------

/** Groups in parent-before-child order, following declaration order. */
function orderGroups(groups: ValidatedGroup[]): ValidatedGroup[] {
  const byParent = new Map<string | undefined, ValidatedGroup[]>();
  for (const group of groups) {
    const siblings = byParent.get(group.parent) ?? [];
    siblings.push(group);
    byParent.set(group.parent, siblings);
  }
  const ordered: ValidatedGroup[] = [];
  const visit = (parent: string | undefined): void => {
    for (const group of byParent.get(parent) ?? []) {
      ordered.push(group);
      visit(group.id);
    }
  };
  visit(undefined);
  return ordered;
}

/**
 * Map each group id to the node ids inside its subtree.
 *
 * A group is *closed* when no connector crosses its border; only then may ELK
 * lay its subtree out in a separate run (and honour the group's direction)
 * without detaching connectors.
 */
function collectSubtreeNodes(groups: ValidatedGroup[], nodes: ValidatedNode[]): Map<string, Set<string>> {
  const parentById = new Map(groups.map((group) => [group.id, group.parent]));
  const members = new Map<string, Set<string>>(groups.map((group) => [group.id, new Set<string>()]));
  for (const node of nodes) {
    const seen = new Set<string>();
    let current = node.group;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      members.get(current)?.add(node.id);
      current = parentById.get(current);
    }
  }
  return members;
}

/**
 * Innermost container enclosing both endpoints: a group id, or `undefined` for
 * the root graph. ELK requires an edge to live in a container holding both of
 * its endpoints, and closure guarantees no edge crosses a separately laid out
 * group, so this choice is always accepted.
 */
function jointContainer(
  nodeA: ValidatedNode,
  nodeB: ValidatedNode,
  parentById: Map<string, string | undefined>,
): string | undefined {
  const chain = (node: ValidatedNode): Array<string | undefined> => {
    const result: Array<string | undefined> = [];
    let current = node.group;
    while (current !== undefined) {
      result.push(current);
      current = parentById.get(current);
    }
    result.push(undefined);
    return result;
  };
  const other = new Set<string | undefined>(chain(nodeB));
  return chain(nodeA).find((candidate) => other.has(candidate));
}

/**
 * One authored connector, resolved to the sides it leaves and enters.
 *
 * Shared between the single-run builder and the panel composer so both agree on
 * anchor sides and label boxes for the same script.
 */
interface EdgeInput {
  elkId: string;
  edge: ValidatedEdge;
  from: NodePlacement;
  to: NodePlacement;
  sides: { from: Side; to: Side };
  label?: { text: string; width: number; height: number };
  onFlow: boolean;
  /** Declaration index, used to key per-container ELK edges. */
  index: number;
}

interface NodePlacement {
  node: ValidatedNode;
  metrics: NodeMetrics;
  ports: Map<Side, string>;
}

/**
 * Resolve both anchor sides for a connector.
 *
 * Explicit sides win. When only one end is explicit, the other uses the
 * opposite side so the route stays axis-aligned. Otherwise the pair follows the
 * `direction` of the layout run that places this connector (see
 * `effectiveDirections`), and a connector whose target is declared *before* its
 * source (a back edge) is anchored the other way round so ELK routes it around
 * the flow instead of through it.
 *
 * Declaration order is a reading-order hint, not geometry: it keeps side
 * selection deterministic and independent of coordinates.
 */
function selectSides(
  edge: ValidatedEdge,
  from: ValidatedNode,
  to: ValidatedNode,
  direction: Direction,
): { from: Side; to: Side } {
  if (edge.from === edge.to) {
    if (edge.fromSide !== undefined && edge.toSide !== undefined) {
      return edge.fromSide === edge.toSide
        ? { from: edge.fromSide, to: NEXT_SIDE[edge.fromSide] }
        : { from: edge.fromSide, to: edge.toSide };
    }
    if (edge.fromSide !== undefined) return { from: edge.fromSide, to: NEXT_SIDE[edge.fromSide] };
    if (edge.toSide !== undefined) return { from: PREVIOUS_SIDE[edge.toSide], to: edge.toSide };
    const from = OUTGOING_SIDE[direction];
    return { from, to: NEXT_SIDE[from] };
  }

  const forward = OUTGOING_SIDE[direction];
  const derived = to.order >= from.order
    ? { from: forward, to: oppositeSide(forward) }
    : { from: oppositeSide(forward), to: forward };

  if (edge.fromSide !== undefined && edge.toSide !== undefined) {
    return { from: edge.fromSide, to: edge.toSide };
  }
  if (edge.fromSide !== undefined) return { from: edge.fromSide, to: oppositeSide(edge.fromSide) };
  if (edge.toSide !== undefined) return { from: oppositeSide(edge.toSide), to: edge.toSide };
  return derived;
}

/**
 * Local anchor position on one side of a node.
 *
 * East/west anchors sit at icon-card centre height rather than the middle of the
 * full footprint, so a horizontal connector leaves at card level. North sits on
 * the footprint top, which is the card top for services; south sits below the
 * caption, matching the reference artwork.
 */
function portPosition(metrics: NodeMetrics, side: Side): Point {
  switch (side) {
    case "north":
      return { x: metrics.width / 2, y: 0 };
    case "south":
      return { x: metrics.width / 2, y: metrics.height };
    case "east":
      return { x: metrics.width, y: metrics.sideY };
    case "west":
      return { x: 0, y: metrics.sideY };
  }
}

// ---------------------------------------------------------------------------
// ELK model
function paddingExpr(top: number, side: number, bottom: number): string {
  return `[top=${top},left=${side},bottom=${bottom},right=${side}]`;
}

/** Round to hundredths so exported geometry stays readable and stable. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Snap a polyline onto axis-aligned segments.
 *
 * ELK's orthogonal router already returns axis-aligned segments up to
 * floating-point error; rounding keeps exports readable, and any pair that
 * still differs on both axes receives an explicit corner instead of a silent
 * diagonal. Consecutive duplicates are dropped.
 */
function orthogonalize(raw: Point[]): Point[] {
  const points: Point[] = [];
  for (const candidate of raw) {
    const next = { x: round(candidate.x), y: round(candidate.y) };
    const previous = points[points.length - 1];
    if (previous === undefined) {
      points.push(next);
      continue;
    }
    const dx = Math.abs(next.x - previous.x);
    const dy = Math.abs(next.y - previous.y);
    if (dx < 0.01 && dy < 0.01) continue;
    if (dy < 0.01) points.push({ x: next.x, y: previous.y });
    else if (dx < 0.01) points.push({ x: previous.x, y: next.y });
    else {
      points.push({ x: next.x, y: previous.y });
      points.push(next);
    }
  }
  return points;
}

/**
 * Pull a card-level endpoint onto the visible icon card.
 *
 * Node footprints include the caption, which is wider than the 64 px card, so a
 * horizontal connector pinned to the footprint border would stop beside the
 * caption instead of touching the card. Only horizontal endpoints whose height
 * is within the card are moved, which keeps every segment axis-aligned.
 */
function trimToCard(points: Point[], metrics: NodeMetrics, absolute: Rect, atStart: boolean): void {
  const card = metrics.card;
  if (card === null || points.length < 2) return;
  const endpoint = points[atStart ? 0 : points.length - 1];
  const neighbour = points[atStart ? 1 : points.length - 2];
  if (Math.abs(endpoint.y - neighbour.y) > EPS) return;
  const cardLeft = absolute.x + card.x;
  const cardRight = cardLeft + card.width;
  const cardCenterY = absolute.y + card.y + card.height / 2;
  if (Math.abs(endpoint.y - cardCenterY) > card.height / 2 + EPS) return;
  const borderLeft = absolute.x;
  const borderRight = absolute.x + absolute.width;
  if (Math.abs(endpoint.x - borderLeft) <= EPS && endpoint.x < cardLeft) {
    endpoint.x = round(cardLeft);
  } else if (Math.abs(endpoint.x - borderRight) <= EPS && endpoint.x > cardRight) {
    endpoint.x = round(cardRight);
  }
}

/**
 * Root layout options.
 *
 * The directed layered algorithm is the only ELK algorithm that combines
 * layers, orthogonal routing and ports. Options are spelled out rather than
 * left to defaults so the result stays stable across ELK patch releases.
 */
function rootLayoutOptions(direction: Direction): Record<string, string> {
  return {
    "elk.algorithm": "layered",
    "elk.direction": DIRECTION_TO_ELK[direction],
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.padding": paddingExpr(ROOT_PAD, ROOT_PAD, ROOT_PAD),
    "elk.spacing.nodeNode": String(NODE_SPACING),
    "elk.spacing.componentComponent": String(COMPONENT_SPACING),
    "elk.spacing.edgeNode": String(EDGE_NODE_SPACING),
    "elk.spacing.edgeEdge": String(EDGE_EDGE_SPACING),
    "elk.spacing.edgeLabel": String(EDGE_LABEL_SPACING),
    "elk.separateConnectedComponents": "true",
    "elk.layered.spacing.nodeNodeBetweenLayers": String(LAYER_SPACING),
    "elk.layered.spacing.edgeNodeBetweenLayers": String(EDGE_NODE_SPACING),
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.edgeLabels.placement": "CENTER",
    // Fixed seed: the layered pipeline must not depend on iteration order.
    "elk.randomSeed": "1",
  };
}

/**
 * Per-group layout options.
 *
 * `MINIMUM_SIZE` reserves room for the group label so a short-content group
 * never shrinks under its own heading. The label text itself is not handed to
 * ELK: exporters draw it inside the reserved top padding, and a real node label
 * would make ELK indent the children by a label-dependent amount.
 *
 * A group whose direction is honoured is marked `SEPARATE_CHILDREN`, which makes
 * ELK lay its subtree out in an independent run; `closed` guarantees no
 * connector has to cross that border (see the closure computation).
 */
function groupLayoutOptions(
  direction: Direction,
  closed: boolean,
  labelWidth: number,
): Record<string, string> {
  const minimumWidth = Math.ceil(labelWidth) + GROUP_PAD_SIDE * 2 + GROUP_LABEL_GUTTER;
  const options: Record<string, string> = {
    "elk.padding": paddingExpr(GROUP_PAD_TOP, GROUP_PAD_SIDE, GROUP_PAD_BOTTOM),
    // Share heading-driven extra width on both sides instead of leaving it all on the right.
    "elk.contentAlignment": "[H_CENTER,V_TOP]",
    "elk.nodeSize.constraints": "[MINIMUM_SIZE]",
    "elk.nodeSize.minimum": `(${minimumWidth},${GROUP_PAD_TOP + GROUP_PAD_BOTTOM})`,
    "elk.direction": DIRECTION_TO_ELK[direction],
  };
  if (closed) {
    Object.assign(options, {
      "elk.hierarchyHandling": "SEPARATE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": String(NODE_SPACING),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(LAYER_SPACING),
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.edgeLabels.placement": "CENTER",
      "elk.randomSeed": "1",
    });
  }
  return options;
}

function buildPorts(placement: NodePlacement): ElkGraphNode["ports"] {
  const ports: NonNullable<ElkGraphNode["ports"]> = [];
  for (const [side, id] of placement.ports) {
    const point = portPosition(placement.metrics, side);
    ports.push({
      id,
      x: point.x,
      y: point.y,
      width: 0,
      height: 0,
      layoutOptions: { "elk.port.side": side.toUpperCase() },
    });
  }
  return ports;
}

/**
 * Routing preferences per connector kind.
 *
 * `elk.layered.priority.direction` is what the layered algorithm consults while
 * breaking cycles: an edge with a high value is far more likely to be routed
 * with the overall direction instead of being reversed into a long return loop.
 * The declared flow chain therefore gets the strongest preference, authored
 * `primary` edges the next, and async edges none: a background notification
 * should yield to the request path rather than fight it.
 */
const EDGE_PRIORITIES: Record<EdgeKind, { direction: string; straightness: string }> = {
  primary: { direction: "30", straightness: "40" },
  secondary: { direction: "10", straightness: "0" },
  async: { direction: "0", straightness: "0" },
};

/**
 * Routing preference for one connector.
 *
 * `elk.layered.priority.direction` is what the layered algorithm consults while
 * breaking cycles: a high value keeps an edge pointing with the flow instead of
 * reversing it into a long return loop. Zero-valued preferences are omitted so
 * ELK keeps its own default rather than reading an explicit zero.
 */
function edgePriorityOptions(kind: EdgeKind, onFlow: boolean): Record<string, string> {
  const priority = onFlow
    ? { direction: FLOW_DIRECTION, straightness: FLOW_STRAIGHTNESS }
    : EDGE_PRIORITIES[kind];
  const options: Record<string, string> = {};
  if (priority.direction !== "0") options["elk.layered.priority.direction"] = priority.direction;
  if (priority.straightness !== "0") options["elk.layered.priority.straightness"] = priority.straightness;
  return options;
}

function buildEdge(
  elkId: string,
  edge: ValidatedEdge,
  from: NodePlacement,
  to: NodePlacement,
  sides: { from: Side; to: Side },
  label: { text: string; width: number; height: number } | undefined,
  onFlow: boolean,
): ElkGraphEdge {
  const result: ElkGraphEdge = {
    id: elkId,
    sources: [from.ports.get(sides.from) ?? `n:${from.node.id}`],
    targets: [to.ports.get(sides.to) ?? `n:${to.node.id}`],
  };
  if (label !== undefined) result.labels = [label];
  const options = edgePriorityOptions(edge.kind, onFlow);
  if (Object.keys(options).length > 0) result.layoutOptions = options;
  return result;
}

// ---------------------------------------------------------------------------
// Engine loading
// ---------------------------------------------------------------------------
// Manual layout
// ---------------------------------------------------------------------------

/**
 * Manual node metrics.
 *
 * Authored `width`/`height` are authoritative, not minimums. Connector anchors
 * are fractions of the authored box, so a re-measured box would move every
 * endpoint off the traced point and make wires overlap or double back. Text is
 * still wrapped with the measured metrics; it may render slightly wider than the
 * box, exactly as the traced reference does.
 */
function manualMetrics(node: ValidatedNode, measure: MeasureText): NodeMetrics {
  const metrics = measureNode(node, measure);
  const width = node.minWidth ?? metrics.width;
  const height = node.minHeight ?? metrics.height;
  // An authored card rectangle is exact: the traced icon is smaller than the
  // default card and sits off-centre, which is what its connector anchors and
  // label positions were measured against.
  const card = node.card ?? (metrics.card === null
    ? null
    : { ...metrics.card, x: (width - metrics.card.width) / 2 });
  if (width === metrics.width && height === metrics.height && card === metrics.card) return metrics;
  return {
    ...metrics,
    width,
    height,
    card,
    sideY: card === null ? height / 2 : card.height / 2,
  };
}

/**
 * Absolute attachment point for an authored anchor.
 *
 * A fraction pair is taken literally, as a fraction of the box. A name is
 * resolved against the node's icon card, because that is what a hand-composed
 * reference actually attaches wires to: the card's left or right edge, at the
 * card's vertical centre. Both therefore survive a change of card size or box
 * size, which the equivalent literal fraction would not.
 *
 * @param rect Absolute box of the node.
 * @param metrics That node's measured metrics, including its card.
 * @param anchor Authored anchor: a fraction pair or a card-relative name.
 * @returns Absolute attachment point.
 */
function resolveAnchor(rect: Rect, metrics: NodeMetrics, anchor: Point | AnchorName): Point {
  if (typeof anchor !== "string") {
    return { x: round(rect.x + rect.width * anchor.x), y: round(rect.y + rect.height * anchor.y) };
  }
  // Without a card there is nothing to follow; the box edge is the honest answer.
  if (metrics.card === null) {
    const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    switch (anchor) {
      case "card-left":
        return { x: round(rect.x), y: round(centre.y) };
      case "card-right":
        return { x: round(rect.x + rect.width), y: round(centre.y) };
      case "card-top":
        return { x: round(centre.x), y: round(rect.y) };
      case "card-bottom":
        return { x: round(centre.x), y: round(rect.y + rect.height) };
      case "card-centre":
        return { x: round(centre.x), y: round(centre.y) };
    }
  }
  const card = {
    left: rect.x + metrics.card.x,
    right: rect.x + metrics.card.x + metrics.card.width,
    top: rect.y + metrics.card.y,
    bottom: rect.y + metrics.card.y + metrics.card.height,
    middle: rect.y + metrics.card.y + metrics.card.height / 2,
  };
  switch (anchor) {
    case "card-left":
      return { x: round(card.left), y: round(card.middle) };
    case "card-right":
      return { x: round(card.right), y: round(card.middle) };
    case "card-top":
      return { x: round(card.left + (card.right - card.left) / 2), y: round(card.top) };
    case "card-bottom":
      return { x: round(card.left + (card.right - card.left) / 2), y: round(card.bottom) };
    case "card-centre":
      return { x: round(card.left + (card.right - card.left) / 2), y: round(card.middle) };
  }
}

/**
 * Where the segment from a node's centre to `toward` crosses its border.
 *
 * Hand-composed references attach connectors at arbitrary points, so anchors are
 * derived from the direction the connector actually leaves rather than from a
 * fixed side. A target inside the node falls back to the centre, which keeps
 * degenerate hand-authored geometry from producing NaN.
 */
function borderPoint(rect: Rect, toward: Point): Point {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return { x: round(cx), y: round(cy) };
  const scaleX = Math.abs(dx) < EPS ? Infinity : rect.width / 2 / Math.abs(dx);
  const scaleY = Math.abs(dy) < EPS ? Infinity : rect.height / 2 / Math.abs(dy);
  const t = Math.min(scaleX, scaleY);
  return { x: round(cx + dx * t), y: round(cy + dy * t) };
}

/** True when every segment of a polyline runs exactly along one axis. */
function isOrthogonal(points: Point[]): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const dx = Math.abs(points[index].x - points[index - 1].x);
    const dy = Math.abs(points[index].y - points[index - 1].y);
    if (dx > 0.6 && dy > 0.6) return false;
  }
  return true;
}

/**
 * Build a 90-degree staircase through explicit waypoints.
 *
 * Each leg leaves a point along the dominant axis toward the next one and then
 * turns once, which guarantees axis-aligned segments and a consistent forward
 * direction. Legs whose dominant axis matches the previous leg share a corner
 * instead of doubling back, so the route never reverses on itself.
 */
function routeOrthogonal(start: Point, interior: Point[], end: Point): Point[] {
  const stops = dedupe([start, ...interior, end]);
  const points: Point[] = [stops[0]];
  for (let index = 1; index < stops.length; index += 1) {
    const from = points[points.length - 1];
    const to = stops[index];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) continue;
    const horizontalFirst = Math.abs(dx) >= Math.abs(dy);
    const corner = horizontalFirst ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
    if (Math.abs(corner.x - from.x) > 0.01 || Math.abs(corner.y - from.y) > 0.01) points.push(corner);
    points.push(to);
  }
  return collapseReversals(dedupe(points));
}

/**
 * Remove midpoints that make the route double back on itself.
 *
 * A reversal can only happen between two segments on the same axis (a staircase
 * corner always changes axis), so dropping the middle point keeps every
 * remaining segment axis-aligned while removing the U-turn. Traced waypoints
 * that sit a few pixels past an anchor produce exactly this shape.
 */
function collapseReversals(points: Point[]): Point[] {
  const result = [...points];
  for (let index = 1; index < result.length - 1; ) {
    const a = result[index - 1];
    const b = result[index];
    const c = result[index + 1];
    const ax = b.x - a.x;
    const ay = b.y - a.y;
    const bx = c.x - b.x;
    const by = c.y - b.y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    const sameAxis = (Math.abs(ax) < 0.01 && Math.abs(bx) < 0.01) || (Math.abs(ay) < 0.01 && Math.abs(by) < 0.01);
    if (la > 0.01 && lb > 0.01 && sameAxis && (ax * bx + ay * by) / (la * lb) < 0) {
      result.splice(index, 1);
      index = Math.max(1, index - 1);
      continue;
    }
    index += 1;
  }
  return result;
}

/** Drop consecutive duplicate points without changing the path's shape. */
function dedupe(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (last !== undefined && Math.abs(last.x - point.x) < 0.01 && Math.abs(last.y - point.y) < 0.01) continue;
    result.push(point);
  }
  return result;
}

/**
 * Point at half the route's arc length.
 *
 * This is the reference tool's default label anchor, so an authored offset is
 * measured from the same place. Using the longest segment instead shifts every
 * label on a lopsided route, which is what drove labels onto nodes.
 */
function labelAnchor(points: Point[]): Point {
  const lengths: number[] = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const length = Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
    lengths.push(length);
    total += length;
  }
  if (total === 0) return { x: round(points[0].x), y: round(points[0].y) };
  let travelled = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (travelled + length >= total / 2) {
      const t = (total / 2 - travelled) / length;
      const a = points[index];
      const b = points[index + 1];
      return { x: round(a.x + (b.x - a.x) * t), y: round(a.y + (b.y - a.y) * t) };
    }
    travelled += length;
  }
  const last = points[points.length - 1];
  return { x: round(last.x), y: round(last.y) };
}

/**
 * Place a hand-composed diagram from its authored coordinates.
 *
 * Universe this is the only way to reproduce a traced reference: ELK can honour
 * a group's own direction only when that group is laid out separately, which
 * forbids the connectors that cross group borders in such compositions.
 *
 * Node boxes are measured from their captions and only enlarged to the authored
 * minimum, so a manual script never has to hand-size text. Group rectangles are
 * taken verbatim; containment is the author's responsibility.
 */
function layoutManual(
  diagram: ValidatedDiagram,
  measureText: MeasureText,
): Scene {
  const metricsById = new Map<string, NodeMetrics>();
  for (const node of diagram.nodes) metricsById.set(node.id, manualMetrics(node, measureText));

  const rectById = new Map<string, Rect>();
  for (const node of diagram.nodes) {
    const metrics = metricsById.get(node.id)!;
    const at = node.at!;
    rectById.set(node.id, { x: at.x, y: at.y, width: metrics.width, height: metrics.height });
  }

  const sceneGroups: SceneGroup[] = orderGroups(diagram.groups).map((group) => {
    const rect = group.rect!;
    return {
      id: group.id,
      parent: group.parent,
      label: group.label,
      tone: group.tone,
      dashed: group.dashed,
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
    };
  });

  const sceneNodes: SceneNode[] = diagram.nodes.map((node) => {
    const metrics = metricsById.get(node.id)!;
    const rect = rectById.get(node.id)!;
    const scene: SceneNode = {
      id: node.id,
      parent: node.group,
      shape: metrics.shape,
      labelLines: metrics.labelLines,
      subtitleLines: metrics.subtitleLines,
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
    };
    if (node.icon !== undefined) scene.icon = node.icon;
    if (metrics.card !== null) {
      scene.card = {
        x: round(scene.x + metrics.card.x),
        y: round(scene.y + metrics.card.y),
        width: round(metrics.card.width),
        height: round(metrics.card.height),
      };
    }
    return scene;
  });
  const sceneById = new Map(sceneNodes.map((node) => [node.id, node]));
  const rectOf = (id: string): Rect => sceneById.get(id)!;

  const sceneEdges: SceneEdge[] = diagram.edges.map((edge) => {
    const from = rectOf(edge.from);
    const to = rectOf(edge.to);
    if (edge.from === edge.to) {
      // A self-loop has no centre-to-centre direction; wrap it around the east side.
      const x = from.x + from.width;
      const y = from.y + (edge.toSide === "north" ? 0 : from.height);
      const loop = [
        borderPoint(from, { x: x + 30, y }),
        { x: round(x + 30), y: round(y) },
        { x: round(x + 30), y: round(from.y + from.height / 2) },
        borderPoint(from, { x: x + 30, y: from.y + from.height / 2 }),
      ];
      const scene: SceneEdge = { id: edge.id, source: edge.from, target: edge.to, kind: edge.kind, points: loop };
      if (edge.label !== undefined) Object.assign(scene, { label: placeLabel(edge.label, loop, measureText) });
      return scene;
    }

    const centre = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    const interior = edge.via ?? [];
    // An authored anchor is exact; otherwise the border crossing toward the
    // next waypoint keeps hand-written connectors sensible without anchors.
    const start = edge.fromAnchor
      ? resolveAnchor(from, metricsById.get(edge.from)!, edge.fromAnchor)
      : borderPoint(from, interior[0] ?? centre(to));
    const end = edge.toAnchor
      ? resolveAnchor(to, metricsById.get(edge.to)!, edge.toAnchor)
      : borderPoint(to, interior[interior.length - 1] ?? centre(from));
    // Traced polylines are already orthogonal; drawing them verbatim preserves
    // the authored corners. Only a script with a genuinely diagonal segment is
    // rewritten, because a staircase would otherwise add corners that the
    // reference does not have.
    const authored = dedupe([start, ...interior, end].map((point) => ({ x: round(point.x), y: round(point.y) })));
    const points = isOrthogonal(authored) ? collapseReversals(authored) : routeOrthogonal(start, interior, end);
    if (points.length < 2) throw new Error(`connector "${edge.id}" has no length; move its endpoints apart`);
    const scene: SceneEdge = { id: edge.id, source: edge.from, target: edge.to, kind: edge.kind, points };
    if (edge.label !== undefined) Object.assign(scene, { label: placeLabel(edge.label, points, measureText, edge.labelOffset, edge.labelAt) });
    return scene;
  });

  let maxX = 1;
  let maxY = 1;
  const extend = (x: number, y: number): void => { maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const group of sceneGroups) extend(group.x + group.width, group.y + group.height);
  for (const node of sceneNodes) extend(node.x + node.width, node.y + node.height);
  for (const edge of sceneEdges) {
    for (const point of edge.points) extend(point.x, point.y);
    if (edge.label !== undefined) extend(edge.label.x + edge.label.width, edge.label.y + edge.label.height);
  }

  assertManualGeometry(sceneGroups, sceneNodes, sceneEdges);

  return {
    title: diagram.title,
    width: round(maxX + ROOT_PAD),
    height: round(maxY + ROOT_PAD),
    groups: sceneGroups,
    nodes: sceneNodes,
    edges: sceneEdges,
  };
}

/** True when two rectangles share any interior area. */
function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Reject manual geometry that cannot have come from a traced reference.
 *
 * These are the exact defects this mode was added to fix, so they fail loudly
 * instead of reaching the canvas: a label sitting on a card, two labels on top
 * of each other, or two cards overlapping. Checking here rather than in the
 * renderer means an SVG or draw.io export can never contain them either.
 *
 * Doubling-back routes are not re-checked because they are already prevented:
 * every route passes through {@link collapseReversals} before reaching here.
 */
function assertManualGeometry(groups: SceneGroup[], nodes: SceneNode[], edges: SceneEdge[]): void {
  const labels = edges.flatMap((edge) => (edge.label === undefined ? [] : [{ id: edge.id, box: edge.label }]));
  for (const node of nodes) {
    // The icon card is the visible box; the caption is part of the footprint.
    const visible = node.card ?? node;
    for (const label of labels) {
      if (rectsOverlap(label.box, visible)) {
        throw new Error(`Manual layout: label of connector "${label.id}" overlaps node "${node.id}"; move its labelAt or bend points`);
      }
    }
  }
  for (let index = 0; index < labels.length; index += 1) {
    for (let other = index + 1; other < labels.length; other += 1) {
      if (rectsOverlap(labels[index].box, labels[other].box)) {
        throw new Error(`Manual layout: labels of "${labels[index].id}" and "${labels[other].id}" overlap; adjust their labelAt`);
      }
    }
  }
  for (let index = 0; index < nodes.length; index += 1) {
    for (let other = index + 1; other < nodes.length; other += 1) {
      const a = nodes[index].card ?? nodes[index];
      const b = nodes[other].card ?? nodes[other];
      if (rectsOverlap(a, b)) {
        throw new Error(`Manual layout: nodes "${nodes[index].id}" and "${nodes[other].id}" overlap; check their x/y`);
      }
    }
  }
  const groupIds = new Set(groups.map((group) => group.id));
  for (const node of nodes) {
    if (node.parent !== undefined && !groupIds.has(node.parent)) {
      throw new Error(`Manual layout: node "${node.id}" names unknown group "${node.parent}"`);
    }
  }
}

/**
 * Place a connector label where it neither covers a card nor another label.
 *
 * Candidates march along the route from the midpoint outward, alternating
 * before and after it, and the first that clears every obstacle wins. Falling
 * back to the midpoint keeps a label even when the route is fully crowded, so a
 * label is never dropped — it is only moved.
 *
 * @param text Label text, possibly pre-wrapped.
 * @param points Route the label annotates.
 * @param measureText Caller's text measurement.
 * @param obstacles Boxes the label must not overlap.
 */
function placeLabelOnRoute(
  text: string,
  points: Point[],
  measureText: MeasureText,
  obstacles: Rect[],
): Rect & { text: string } {
  const centred = placeLabel(text, points, measureText);
  const overlaps = (a: Rect, b: Rect): boolean =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const clears = (box: Rect): boolean => obstacles.every((obstacle) => !overlaps(box, obstacle));
  if (clears(centred)) return centred;

  // Search outward on both axes: a label squeezed between two cards may only fit
  // by moving sideways, and one under a wide card only by moving down.
  const stepX = Math.max(12, centred.width / 2);
  const stepY = Math.max(10, centred.height);
  for (let distance = 1; distance <= 24; distance += 1) {
    for (const [dx, dy] of [
      [0, distance * stepY],
      [0, -distance * stepY],
      [distance * stepX, 0],
      [-distance * stepX, 0],
      [distance * stepX, distance * stepY],
      [-distance * stepX, distance * stepY],
      [distance * stepX, -distance * stepY],
      [-distance * stepX, -distance * stepY],
    ]) {
      const candidate: Rect & { text: string } = {
        ...centred,
        x: round(centred.x + dx),
        y: round(centred.y + dy),
      };
      if (clears(candidate)) return candidate;
    }
  }
  return centred;
}

/**
 * Connector label box, centred on the route's longest segment.
 *
 * Manual scripts author no label geometry, so the text is measured here and
 * given a box the renderer can centre in; multiline labels keep their line
 * breaks, which keeps the drawn text identical to the authored string.
 */
function placeLabel(
  text: string,
  points: Point[],
  measureText: MeasureText,
  offset?: Point,
  origin?: Point,
): Rect & { text: string } {
  const measured = measureTextBlock(text, EDGE_FONT, EDGE_LABEL_WRAP, SUBTITLE_LINE_HEIGHT, measureText);
  const width = Math.max(1, Math.ceil(measured.width));
  const height = Math.max(1, Math.ceil(measured.height));
  if (origin !== undefined) {
    // Absolute authored anchor: horizontal centre and baseline, which is how the
    // reference exporter emits connector labels. Converting the baseline back to
    // a box keeps the painter's centre-anchored text on the authored pixels.
    // The painter places a centre-anchored line at `centre + size * 0.36`, and
    // connector labels are painted at the edge size, so invert that exact offset.
    const centreY = origin.y - theme.edgeSize * 0.36;
    return {
      text: measured.lines.join("\n"),
      x: round(origin.x - width / 2),
      y: round(centreY - height / 2),
      width,
      height,
    };
  }
  const anchor = labelAnchor(points);
  return {
    text: measured.lines.join("\n"),
    // An authored offset is exact; otherwise the label sits on the route midpoint.
    x: round(anchor.x + (offset?.x ?? 0) - width / 2),
    y: round(anchor.y + (offset?.y ?? 0) - height / 2),
    width,
    height,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** A panel's interior, in panel-local coordinates. */
interface PanelInterior {
  width: number;
  height: number;
  /** Member offsets, keyed by element id. */
  members: Map<string, Point>;
  /** Routes this panel drew itself, keyed by ELK edge id. */
  routes: Map<string, { points: Point[]; label?: Rect }>;
}

/**
 * Lay out one panel in isolation and report its size and interior.
 *
 * The panel is wrapped in a synthetic parent because ELK rejects layout options
 * (including `direction`) on a root graph that also owns ports, and because the
 * wrapper keeps the panel's own run independent of anything around it.
 */
/**
 * Lay a panel's members out as a grid.
 *
 * A panel is a visual cluster, and its shape is an authoring decision: nine
 * services read as two columns of five, three clients as one column, three
 * offline tools as one row. Handing that to a solver produces the shapes it finds
 * convenient — a ten-card column, or cards reordered into whatever the wrapping
 * pass chose — which is why the reference composition was unreachable.
 *
 * So the shape is declared (`columns`, else `direction`) and the positions follow
 * mechanically: uniform cells sized to the largest member, each member centred in
 * its cell. Declaration order is preserved left-to-right, top-to-bottom, so the
 * script reads in the same order as the diagram.
 *
 * @param members Members in declaration order, with their measured sizes.
 * @param columns Cards per row.
 * @param padding Panel padding; the top reserves the heading.
 * @param minWidth Width the heading needs.
 * @returns Local positions and the resulting panel size.
 */
function gridPanel(
  members: Array<{ id: string; width: number; height: number }>,
  columns: number,
  padding: { top: number; side: number; bottom: number },
  minWidth: number,
): PanelInterior {
  const positions = new Map<string, Point>();
  const routes = new Map<string, { points: Point[]; label?: Rect }>();
  if (members.length === 0) {
    return {
      width: Math.max(minWidth, padding.side * 2),
      height: padding.top + padding.bottom,
      members: positions,
      routes,
    };
  }

  const cellWidth = Math.max(...members.map((member) => member.width));
  const cellHeight = Math.max(...members.map((member) => member.height));
  const perRow = Math.max(1, Math.min(columns, members.length));
  const rows = Math.ceil(members.length / perRow);

  members.forEach((member, index) => {
    const column = index % perRow;
    const row = Math.floor(index / perRow);
    // Cells are left-aligned, not centred. Cards in one panel are already
    // equalised to the same width, so for a card grid the two are identical —
    // but a panel that also holds sub-panels would otherwise push its own cards
    // to the middle of the widest child, which reverses the left-to-right order
    // of a flow that passes through both.
    positions.set(member.id, {
      x: Math.round(padding.side + column * (cellWidth + NODE_SPACING)),
      y: Math.round(padding.top + row * (cellHeight + NODE_SPACING) + (cellHeight - member.height) / 2),
    });
  });

  const width = Math.max(
    minWidth,
    padding.side * 2 + perRow * cellWidth + (perRow - 1) * NODE_SPACING,
  );
  const height = padding.top + padding.bottom + rows * cellHeight + (rows - 1) * NODE_SPACING;
  return { width, height, members: positions, routes };
}

/**
 * Route the connectors a panel owns, inside its own grid.
 *
 * The grid leaves a channel between every pair of cells, so a connector is routed
 * by the same obstacle-avoiding search the canvas uses: cards are obstacles and
 * the channels are the free space. Doing it here rather than leaving connectors
 * to the canvas keeps a panel's internal wiring inside the panel.
 *
 * @param edges Connectors this panel owns, with member-space endpoints.
 * @param members Member sizes, in declaration order.
 * @param positions Member positions from {@link gridPanel}.
 * @param measureText Caller's text measurement, for label boxes.
 */
function routePanelEdges(
  edges: Array<{ id: string; from: string; to: string; label?: { text: string; width: number; height: number } }>,
  members: Array<{ id: string; width: number; height: number }>,
  positions: Map<string, Point>,
  measureText: MeasureText,
): Map<string, { points: Point[]; label?: Rect }> {
  const boxes = new Map<string, Rect>();
  for (const member of members) {
    const at = positions.get(member.id);
    if (at === undefined) continue;
    boxes.set(member.id, { x: at.x, y: at.y, width: member.width, height: member.height });
  }
  const all = [...boxes.values()];

  const routes = new Map<string, { points: Point[]; label?: Rect }>();
  for (const edge of edges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const obstacles = all.filter((box) => box !== from && box !== to);
    // Step outside each card before searching: a point on the border counts as
    // blocked, so starting exactly on it would strand the search.
    // Enter and leave through the horizontal edges when the two cards sit in
    // different rows, and through the vertical ones when they share a row: that
    // is the side whose step-out lands in a free channel rather than in the
    // neighbouring card.
    const sameRow = Math.abs(from.y + from.height / 2 - (to.y + to.height / 2)) < from.height / 2;
    const start = sameRow
      ? { x: from.x + (to.x > from.x ? from.width : 0), y: from.y + from.height / 2 }
      : { x: from.x + from.width / 2, y: from.y + (to.y > from.y ? from.height : 0) };
    const end = sameRow
      ? { x: to.x + (from.x > to.x ? to.width : 0), y: to.y + to.height / 2 }
      : { x: to.x + to.width / 2, y: to.y + (from.y > to.y ? to.height : 0) };
    /**
     * First point outside a card.
     *
     * Chosen from the side that faces the target, but only in the axis that
     * leaves the row: cards in one grid row are separated horizontally, so a
     * sideways step from a card border runs straight into its neighbour. The
     * vertical step leaves the row and reaches the free channel between rows.
     */
    const stepOut = (point: Point, box: Rect): Point => {
      const gap = NODE_SPACING / 2;
      // Continue outward from whichever border this point sits on.
      if (Math.abs(point.x - box.x) < 0.5) return { x: point.x - gap, y: point.y };
      if (Math.abs(point.x - (box.x + box.width)) < 0.5) return { x: point.x + gap, y: point.y };
      if (Math.abs(point.y - box.y) < 0.5) return { x: point.x, y: point.y - gap };
      return { x: point.x, y: point.y + gap };
    };
    const inner = routeAround(stepOut(start, from), stepOut(end, to), obstacles);
    const points = orthogonalize([start, ...inner, end]);
    const entry: { points: Point[]; label?: Rect } = { points };
    if (edge.label !== undefined) {
      const placed = placeLabel(edge.label.text, points, measureText);
      entry.label = placed;
    }
    routes.set(edge.id, entry);
  }
  return routes;
}

/**
 * Compose a diagram panel by panel.
 *
 * Used when the script describes several panels, which is the case a single ELK
 * run handles badly: every panel would either lose its own `direction` or be
 * forced into one wide strip. See the section comment for why this cannot be
 * expressed as one run.
 */
async function layoutComposed(
  diagram: ValidatedDiagram,
  measureText: MeasureText,
  context: {
    groupOrder: ValidatedGroup[];
    groupById: Map<string, ValidatedGroup>;
    subtree: Map<string, Set<string>>;
    placements: Map<string, NodePlacement>;
    edgeInputs: EdgeInput[];
    flowEdges: Set<string>;
  },
): Promise<Scene> {
  const { groupOrder, groupById, subtree, placements, edgeInputs } = context;
  const engine = await loadEngine();

  /** Panels containing an element, innermost first; the element itself excluded. */
  const containersOf = (id: string): string[] => {
    const group = groupById.get(id);
    const result: string[] = [];
    let current = group === undefined ? placements.get(id)?.node.group : group.parent;
    while (current !== undefined) {
      result.push(current);
      current = groupById.get(current)!.parent;
    }
    return result;
  };

  /**
   * Direction a panel's members flow in.
   *
   * An explicit `direction` wins: it is the author stating the panel's reading
   * order. Otherwise a panel takes the direction perpendicular to its enclosing
   * run, so a horizontal canvas of panels reads as columns of members.
   */
  const directionOf = (groupId: string): Direction => {
    const group = groupById.get(groupId)!;
    if (group.direction !== undefined) return group.direction;
    const parent = group.parent === undefined ? undefined : groupById.get(group.parent);
    return parent === undefined ? PERPENDICULAR[diagram.direction] : PERPENDICULAR[directionOf(parent.id)];
  };

  /**
   * Declaration position of an element, for ordering a container's members.
   *
   * A group has no index of its own in the script, so it takes the earliest
   * position of any card inside it. That is what makes a canvas follow the
   * script's reading order even when it mixes loose nodes and panels: the
   * clients declared before Cloudflare stay before Cloudflare.
   */
  const declaredAt = (id: string): number => {
    if (id.startsWith("n:")) return placements.get(id.slice(2))?.node.order ?? Number.MAX_SAFE_INTEGER;
    const members = subtree.get(id.slice(2));
    if (members === undefined || members.size === 0) return Number.MAX_SAFE_INTEGER;
    let earliest = Number.MAX_SAFE_INTEGER;
    for (const nodeId of members) earliest = Math.min(earliest, placements.get(nodeId)?.node.order ?? earliest);
    return earliest;
  };

  /** Elements directly inside a container, in the order the script declares them. */
  const membersOf = (container: string | undefined): string[] =>
    [
      ...groupOrder.filter((group) => group.parent === container).map((group) => `g:${group.id}`),
      ...diagram.nodes.filter((node) => node.group === container).map((node) => `n:${node.id}`),
    ].sort((a, b) => declaredAt(a) - declaredAt(b));

  const depthOf = (groupId: string): number => {
    let depth = 0;
    let current = groupById.get(groupId)!.parent;
    while (current !== undefined) {
      depth += 1;
      current = groupById.get(current)!.parent;
    }
    return depth;
  };

  // Sizes start as each node's measured footprint and are replaced by panel sizes.
  const sizes = new Map<string, Rect>();
  for (const placement of placements.values()) {
    sizes.set(`n:${placement.node.id}`, { x: 0, y: 0, width: placement.metrics.width, height: placement.metrics.height });
  }

  /**
   * Connectors a panel owns, as member ids inside that panel.
   *
   * A connector belongs to the innermost panel holding both of its endpoints.
   * That is the only assignment under which both ends are visible to whatever
   * draws the segment.
   */
  const ownEdges = (
    container: string,
    members: string[],
  ): Array<{ id: string; from: string; to: string; label?: { text: string; width: number; height: number } }> => {
    const result: Array<{ id: string; from: string; to: string; label?: { text: string; width: number; height: number } }> = [];
    for (const entry of edgeInputs) {
      const fromPanels = containersOf(entry.edge.from);
      const toPanels = containersOf(entry.edge.to);
      const shared = fromPanels.find((candidate) => toPanels.includes(candidate));
      if (shared !== container) continue;
      const fromId = `n:${entry.edge.from}`;
      const toId = `n:${entry.edge.to}`;
      if (!members.includes(fromId) || !members.includes(toId)) continue;
      result.push({ id: `e:${entry.index}`, from: fromId, to: toId, label: entry.label });
    }
    return result;
  };

  /**
   * Members of a container as measured boxes, in declaration order.
   *
   * Every card in a panel takes the widest caption's width and the tallest
   * caption's height, so the panel is a grid of equal cells. That is what makes
   * a service cluster read as a table rather than a ragged collage, and it is
   * why the reference composition has columns of identical cards.
   */
  const memberBoxes = (container: string): Array<{ id: string; width: number; height: number }> => {
    const members = membersOf(container);
    const cards = members.filter((id) => id.startsWith("n:"));
    const widest = Math.max(0, ...cards.map((id) => sizes.get(id)!.width));
    const tallest = Math.max(0, ...cards.map((id) => sizes.get(id)!.height));
    return members.map((id) => {
      const size = sizes.get(id)!;
      if (!id.startsWith("n:")) return { id, width: size.width, height: size.height };
      // Uniform cards, but never narrower than this card's own caption needs.
      const width = Math.max(widest, size.width);
      const height = Math.max(tallest, size.height);
      sizes.set(id, { x: 0, y: 0, width, height });
      return { id, width, height };
    });
  };

  /**
   * Cards per row for a panel.
   *
   * `columns` states it; otherwise `direction` gives the shape: `right` puts the
   * members in one row, `down` in one column, and a `down` panel with enough
   * members becomes the squarish grid a reader expects of a service cluster.
   */
  const columnsFor = (group: ValidatedGroup, count: number): number => {
    if (group.columns !== undefined) return group.columns;
    if (directionOf(group.id) === "right" || directionOf(group.id) === "left") return Math.max(1, count);
    return count <= GRID_ROWS_BEFORE_WRAP ? 1 : Math.ceil(Math.sqrt(count));
  };

  // --- Pass 1: each panel as a grid, deepest first ---
  const panels = new Map<string, PanelInterior>();
  const deepestFirst = [...diagram.groups].sort((a, b) => depthOf(b.id) - depthOf(a.id));
  for (const group of deepestFirst) {
    const members = memberBoxes(group.id);
    const padding = { top: GROUP_PAD_TOP, side: GROUP_PAD_SIDE, bottom: GROUP_PAD_BOTTOM };
    const interior = gridPanel(
      members,
      columnsFor(group, members.length),
      padding,
      measureText(group.label, GROUP_FONT) + GROUP_PAD_SIDE * 2 + GROUP_LABEL_GUTTER,
    );
    // Route this panel's own connectors inside its grid, so its wiring never
    // leaves the panel and never depends on where the panel lands.
    interior.routes = routePanelEdges(
      ownEdges(group.id, membersOf(group.id)),
      members,
      interior.members,
      measureText,
    );
    panels.set(group.id, interior);
    sizes.set(`g:${group.id}`, { x: 0, y: 0, width: interior.width, height: interior.height });
  }

  // --- Pass 2: place the top-level panels in declaration order ---
  const canvasMembers = membersOf(undefined);

  /**
   * Place the canvas with a packer, not with ELK.
   *
   * ELK orders a layer by its topology: a panel whose only edges arrive from
   * below is pushed to the top of the canvas. That is a fine rule for an abstract
   * graph and the wrong one for a composed diagram, where a reader expects the
   * panels in the order the script declares them (clients, then Cloudflare, then
   * the server it fronts). Declaration order is also what makes the composition
   * reviewable: a panel that moves should be a diff in the script.
   */
  const canvasSizes = canvasMembers.map((id) => {
    const size = sizes.get(id)!;
    return { id, width: size.width, height: size.height };
  });
  const packed = packInOrder(canvasSizes, COMPONENT_SPACING, TARGET_CANVAS_ASPECT);

  /** Absolute origin of every element, accumulated from the canvas downward. */
  const origin = new Map<string, Point>();
  for (const [id, position] of packed) origin.set(id, position);

  const placeInside = (groupId: string): void => {
    const interior = panels.get(groupId)!;
    const base = origin.get(`g:${groupId}`);
    if (base === undefined) return;
    for (const [id, offset] of interior.members) {
      origin.set(id, { x: base.x + offset.x, y: base.y + offset.y });
      if (id.startsWith("g:")) placeInside(id.slice(2));
    }
  };
  for (const id of canvasMembers) {
    if (id.startsWith("g:")) placeInside(id.slice(2));
  }

  const rectOf = (id: string): Rect => {
    const size = sizes.get(id);
    const at = origin.get(id);
    if (size === undefined || at === undefined) throw new Error(`Layout produced no geometry for "${id}"`);
    return { x: at.x, y: at.y, width: size.width, height: size.height };
  };

  const sceneGroups: SceneGroup[] = groupOrder.map((group) => {
    const rect = rectOf(`g:${group.id}`);
    return {
      id: group.id,
      parent: group.parent,
      label: group.label,
      tone: group.tone,
      dashed: group.dashed,
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
    };
  });

  const sceneNodes: SceneNode[] = diagram.nodes.map((node) => {
    const placement = placements.get(node.id)!;
    const rect = rectOf(`n:${node.id}`);
    const scene: SceneNode = {
      id: node.id,
      parent: node.group,
      shape: placement.metrics.shape,
      labelLines: placement.metrics.labelLines,
      subtitleLines: placement.metrics.subtitleLines,
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
    };
    if (node.icon !== undefined) scene.icon = node.icon;
    if (placement.metrics.card !== null) {
      scene.card = {
        x: round(scene.x + placement.metrics.card.x),
        y: round(scene.y + placement.metrics.card.y),
        width: round(placement.metrics.card.width),
        height: round(placement.metrics.card.height),
      };
    }
    return scene;
  });

  const sceneById = new Map(sceneNodes.map((node) => [node.id, node]));

  // --- Pass 3: connectors ---
  /** Labels already placed, collected as the map runs so later ones avoid them. */
  const placedLabels: Rect[] = [];
  const sceneEdges: SceneEdge[] = edgeInputs.map((entry) => {
    const fromPanels = containersOf(entry.edge.from);
    const toPanels = containersOf(entry.edge.to);
    const shared = fromPanels.find((candidate) => toPanels.includes(candidate));

    // Both ends inside one panel: that panel already drew the exact route.
    const route = shared === undefined ? undefined : panels.get(shared)?.routes.get(`e:${entry.index}`);
    let raw: Point[] = [];
    let labelBox: SceneEdge["label"] | undefined;

    if (route !== undefined) {
      const base = origin.get(`g:${shared}`)!;
      raw = route.points.map((point) => ({ x: base.x + point.x, y: base.y + point.y }));
      if (route.label !== undefined && entry.label !== undefined) {
        labelBox = {
          text: entry.label.text,
          x: round(base.x + route.label.x),
          y: round(base.y + route.label.y),
          width: round(route.label.width),
          height: round(route.label.height),
        };
      }
    } else {
      // The wire crosses panel borders. It runs from the source card out to its
      // panel's border, across the gutter, and into the target card. The gutter
      // leg is routed *around* the intervening panels rather than straight
      // through them, because a straight leg would cut across their cards.
      const fromRect = rectOf(`n:${entry.edge.from}`);
      const toRect = rectOf(`n:${entry.edge.to}`);
      const startPanel = fromPanels[0];
      const endPanel = toPanels[0];
      const startBox = startPanel === undefined ? fromRect : rectOf(`g:${startPanel}`);
      const endBox = endPanel === undefined ? toRect : rectOf(`g:${endPanel}`);
      const start = borderPoint(startBox, centreOf(endBox));
      const end = borderPoint(endBox, centreOf(startBox));
      // Leave and enter on the side that faces the other box, so the first and
      // last legs never double back across their own panel.
      const startSide = sideAtRect(start, startBox);
      const endSide = sideAtRect(end, endBox);
      /**
       * Obstacles for a crossing connector.
       *
       * Two tiers. Cards are hard obstacles everywhere. Panels outside the ones the
       * wire touches are obstacles too, so a wire cannot plough through an
       * unrelated cluster. The panels it does touch are excluded entirely: a wire
       * reaching a card inside a panel legitimately starts inside that panel, and
       * treating the outline as solid would strand the search.
       */
      // Every panel on either endpoint's ancestry is one the wire must be able to
      // reach into; excluding only the innermost would make an outer panel look
      // like solid ground and strand the search.
      const allowedPanels = new Set([...fromPanels, ...toPanels]);
      const obstacles = [
        // Cards inside the target panel are avoided too: the wire has to reach
        // one card in there, so its neighbours are exactly what it must not hit.
        // Cards inside the target panel are avoided too: the wire has to reach one
        // card in there, so its neighbours are exactly what it must not hit. The
        // whole footprint is used, not just the icon square, because the caption
        // is what a reader sees and a wire across it is the defect this guards.
        ...sceneNodes
          .filter((node) => node.id !== entry.edge.from && node.id !== entry.edge.to)
          .map((node) => ({ x: node.x, y: node.y, width: node.width, height: node.height })),
        ...sceneGroups
          .filter((group) => !allowedPanels.has(group.id))
          .map((group) => ({ x: group.x, y: group.y, width: group.width, height: group.height })),
      ];
      void startSide;
      void endSide;
      // Step outside both cards first, so neither endpoint starts inside the
      // area the router treats as blocked. The step follows the centre-to-centre
      // direction and lands a node gap past the card's own border, which is the
      // closest point that is guaranteed clear of it.
      /** True when a point sits inside any obstacle, inset so a border counts as free. */
      const insideAny = (point: Point): boolean =>
        obstacles.some(
          (r) =>
            point.x > r.x + 0.5 && point.x < r.x + r.width - 0.5 &&
            point.y > r.y + 0.5 && point.y < r.y + r.height - 0.5,
        );
      /**
       * First waypoint outside a card, on a side that is actually free.
       *
       * Axis-aligned, because the router only moves along the grid lines it is
       * given. The side facing the target is tried first, then the others: a card
       * can be packed tightly enough that its natural exit lands inside a
       * neighbour, and choosing a blocked exit would strand the search and force
       * the through-the-cards fallback.
       */
      const leave = (rect: Rect, toward: Rect): Point => {
        const dx = toward.x + toward.width / 2 - (rect.x + rect.width / 2);
        const dy = toward.y + toward.height / 2 - (rect.y + rect.height / 2);
        const gap = NODE_SPACING;
        const centreY = Math.round(rect.y + rect.height / 2);
        const centreX = Math.round(rect.x + rect.width / 2);
        const candidates: Array<{ point: Point; facing: number }> = [
          { point: { x: Math.round(rect.x + rect.width + gap), y: centreY }, facing: dx },
          { point: { x: Math.round(rect.x - gap), y: centreY }, facing: -dx },
          { point: { x: centreX, y: Math.round(rect.y + rect.height + gap) }, facing: dy },
          { point: { x: centreX, y: Math.round(rect.y - gap) }, facing: -dy },
        ];
        // Prefer a side pointing at the target, then any clear side.
        candidates.sort((a, b) => b.facing - a.facing);
        const free = candidates.find((candidate) => !insideAny(candidate.point));
        return (free ?? candidates[0]).point;
      };
      const routeFrom = leave(fromRect, toRect);
      const routeTo = leave(toRect, fromRect);
      const inner = routeAround(routeFrom, routeTo, obstacles);
      // `inner` already begins at `routeFrom` and ends at `routeTo`; repeating
      // them would add zero-length legs and hide which side the wire leaves on.
      // The card border point is rounded while the router's exit is not, so the
      // first two points can differ by a fraction of a pixel. Snapping them to
      // the same grid is what lets the wire report which side it leaves on.
      const snap = (point: Point): Point => ({ x: Math.round(point.x), y: Math.round(point.y) });
      raw = dedupe(
        orthogonalize([borderPoint(fromRect, routeFrom), ...inner, borderPoint(toRect, routeTo)].map(snap)),
      );
    }

    /**
     * No card trim here.
     *
     * The single-run path starts on the footprint border and needs pulling onto the
     * card. A composed route already starts on the card border, and trimming it
     * again would move a vertical end sideways and detach the wire.
     */
    const points = orthogonalize(raw);
    if (points.length < 2) {
      throw new Error(`Connector "${entry.edge.id}" collapsed while routing; check its explicit sides`);
    }
    const scene: SceneEdge = {
      id: entry.edge.id,
      source: entry.edge.from,
      target: entry.edge.to,
      kind: entry.edge.kind,
      points,
    };
    if (entry.label !== undefined) {
      // A crossing connector has no box of its own, so its label is placed on the
      // route and then slid along it until it clears every card and every label
      // already placed. Without that nudge a label lands on whichever card
      // happens to sit under the route midpoint.
      // The whole footprint is the obstacle, not just the icon square: a label
      // resting on a caption is as unreadable as one resting on a card.
      scene.label = labelBox ?? placeLabelOnRoute(entry.label.text, points, measureText, [
        ...sceneNodes.map((node) => ({ x: node.x, y: node.y, width: node.width, height: node.height })),
        ...placedLabels,
      ]);
      placedLabels.push(scene.label);
    }
    return scene;
  });

  return normaliseScene(diagram.title, sceneGroups, sceneNodes, sceneEdges);
}

/**
 * Shift every rectangle into the positive quadrant and size the canvas.
 *
 * Bounds come from the produced geometry rather than a computed width, because a
 * label can stick out past the layout box and would otherwise be clipped.
 */
function normaliseScene(
  title: string,
  groups: SceneGroup[],
  nodes: SceneNode[],
  edges: SceneEdge[],
): Scene {
  let minX = 0;
  let minY = 0;
  let maxX = 1;
  let maxY = 1;
  const extend = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const group of groups) extend(group.x + group.width, group.y + group.height);
  for (const node of nodes) extend(node.x + node.width, node.y + node.height);
  for (const edge of edges) {
    for (const point of edge.points) extend(point.x, point.y);
    if (edge.label !== undefined) extend(edge.label.x + edge.label.width, edge.label.y + edge.label.height);
  }

  const shiftX = minX < 0 ? round(ROOT_PAD - minX) : 0;
  const shiftY = minY < 0 ? round(ROOT_PAD - minY) : 0;
  if (shiftX !== 0 || shiftY !== 0) {
    for (const group of groups) {
      group.x = round(group.x + shiftX);
      group.y = round(group.y + shiftY);
    }
    for (const node of nodes) {
      node.x = round(node.x + shiftX);
      node.y = round(node.y + shiftY);
      if (node.card !== undefined) {
        node.card.x = round(node.card.x + shiftX);
        node.card.y = round(node.card.y + shiftY);
      }
    }
    for (const edge of edges) {
      for (const point of edge.points) {
        point.x = round(point.x + shiftX);
        point.y = round(point.y + shiftY);
      }
      if (edge.label !== undefined) {
        edge.label.x = round(edge.label.x + shiftX);
        edge.label.y = round(edge.label.y + shiftY);
      }
    }
  }

  return {
    title,
    width: round(Math.max(1, maxX + shiftX + ROOT_PAD)),
    height: round(Math.max(1, maxY + shiftY + ROOT_PAD)),
    groups,
    nodes,
    edges,
  };
}

/**
 * Lay out a coordinate-free diagram script.
 *
 * @param input Untrusted, JSON-shaped `DiagramSpec`. Validated before use; see
 *   `diagram.schema.json` for the accepted shape.
 * @param measureText Text width for a CSS font string, typically
 *   `ctx.measureText(text).width` after `ctx.font = font`.
 * @returns A `Scene` in absolute coordinates. Groups appear parent-before-child;
 *   nodes and edges keep their input order, and every declared node, edge and
 *   group appears exactly once.
 * @throws Error when the script is invalid (bad ids, references, containment
 *   cycles, enum values, unknown fields, a flow step without a connection) or
 *   when the engine returns no geometry for a declared element.
 */
export async function layoutDiagram(input: unknown, measureText: MeasureText): Promise<Scene> {
  const diagram = validateDiagram(input);
  if (diagram.manual) return layoutManual(diagram, measureText);
  const parentById = new Map<string, string | undefined>(
    diagram.groups.map((group) => [group.id, group.parent]),
  );
  const groupOrder = orderGroups(diagram.groups);
  const subtree = collectSubtreeNodes(diagram.groups, diagram.nodes);

  const placements = new Map<string, NodePlacement>();
  for (const node of diagram.nodes) {
    placements.set(node.id, { node, metrics: measureNode(node, measureText), ports: new Map() });
  }

  const flowEdges = new Set<string>();
  for (let index = 1; index < diagram.flow.length; index += 1) {
    for (const edge of diagram.edges) {
      if (edge.from === diagram.flow[index - 1] && edge.to === diagram.flow[index]) flowEdges.add(edge.id);
    }
  }

  // A group may be laid out in its own run only when no connector crosses the
  // border of that group *or of any group nested inside it*. ELK inherits
  // `hierarchyHandling`, so marking a group `SEPARATE_CHILDREN` also makes every
  // descendant a separate run; a connector that spans one of those borders is
  // then placed in an ancestor run that cannot see the nested node, and ELK
  // rejects the graph. Groups without nodes can never be crossed.
  const descendantIds = (groupId: string): string[] => {
    const result: string[] = [];
    const stack = [groupId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      result.push(current);
      for (const group of diagram.groups) if (group.parent === current) stack.push(group.id);
    }
    return result;
  };
  const borderCrossed = new Map<string, boolean>();
  for (const group of diagram.groups) {
    const members = subtree.get(group.id) ?? new Set<string>();
    borderCrossed.set(
      group.id,
      diagram.edges.some((edge) => members.has(edge.from) !== members.has(edge.to)),
    );
  }
  const closed = new Map<string, boolean>();
  for (const group of diagram.groups) {
    const hasNodes = (subtree.get(group.id)?.size ?? 0) > 0;
    closed.set(group.id, hasNodes && descendantIds(group.id).every((id) => borderCrossed.get(id) !== true));
  }

  /**
   * Direction of the layout run that places a node.
   *
   * A node inside a separately laid out group is positioned by that group's run,
   * so its connectors must follow the group's direction. Otherwise the nearest
   * ancestor direction applies, which is the root direction by default.
   */
  const directionFor = (node: ValidatedNode): Direction => {
    let current = node.group;
    while (current !== undefined) {
      const group = diagram.groups.find((candidate) => candidate.id === current)!;
      if (closed.get(group.id) === true && group.direction !== undefined) return group.direction;
      current = group.parent;
    }
    return diagram.direction;
  };

  /**
   * Direction a group's own content is laid out in.
   *
   * A closed group is placed by its own run, so its declared direction applies;
   * an open group inherits the direction of the enclosing run, which is the
   * parent group's effective direction or the root direction.
   */
  const groupDirection = (group: ValidatedGroup): Direction => {
    if (closed.get(group.id) === true && group.direction !== undefined) return group.direction;
    const parent = group.parent === undefined ? undefined : diagram.groups.find((candidate) => candidate.id === group.parent);
    return parent === undefined ? diagram.direction : groupDirection(parent);
  };

  // Resolve anchors and label sizes for every connector before building the model.
  const edgeInputs = diagram.edges.map((edge, index) => {
    const from = placements.get(edge.from)!;
    const to = placements.get(edge.to)!;
    const sides = selectSides(edge, from.node, to.node, directionFor(from.node));
    for (const [placement, side] of [
      [from, sides.from],
      [to, sides.to],
    ] as const) {
      if (!placement.ports.has(side)) placement.ports.set(side, `p:${placement.node.id}:${side}`);
    }
    const label =
      edge.label === undefined
        ? undefined
        : (() => {
            const measured = measureTextBlock(edge.label, EDGE_FONT, EDGE_LABEL_WRAP, SUBTITLE_LINE_HEIGHT, measureText);
            return {
              text: measured.lines.join("\n"),
              width: Math.max(1, Math.ceil(measured.width)),
              height: Math.max(1, Math.ceil(measured.height)),
            };
          })();
    return { elkId: `e:${index}`, edge, from, to, sides, label, onFlow: flowEdges.has(edge.id), index };
  });

  const elkNodes = new Map<string, ElkGraphNode>();
  for (const group of groupOrder) {
    elkNodes.set(`g:${group.id}`, {
      id: `g:${group.id}`,
      layoutOptions: groupLayoutOptions(
        groupDirection(group),
        closed.get(group.id) === true,
        measureText(group.label, GROUP_FONT),
      ),
      children: [],
    });
  }
  for (const placement of placements.values()) {
    const ports = buildPorts(placement);
    elkNodes.set(`n:${placement.node.id}`, {
      id: `n:${placement.node.id}`,
      width: placement.metrics.width,
      height: placement.metrics.height,
      layoutOptions: ports === undefined || ports.length === 0 ? {} : { "elk.portConstraints": "FIXED_POS" },
      ports,
    });
  }

  for (const group of groupOrder) {
    const element = elkNodes.get(`g:${group.id}`)!;
    for (const child of groupOrder) {
      if (child.parent === group.id) (element.children ?? []).push(elkNodes.get(`g:${child.id}`)!);
    }
    for (const placement of placements.values()) {
      if (placement.node.group === group.id) (element.children ?? []).push(elkNodes.get(`n:${placement.node.id}`)!);
    }
  }

  const root: ElkGraphNode = {
    id: "root",
    layoutOptions: rootLayoutOptions(diagram.direction),
    children: [],
  };
  for (const group of groupOrder) {
    if (group.parent === undefined) (root.children ?? []).push(elkNodes.get(`g:${group.id}`)!);
  }
  for (const placement of placements.values()) {
    if (placement.node.group === undefined) (root.children ?? []).push(elkNodes.get(`n:${placement.node.id}`)!);
  }

  for (const entry of edgeInputs) {
    const container = jointContainer(entry.from.node, entry.to.node, parentById);
    const host = container === undefined ? root : elkNodes.get(`g:${container}`)!;
    (host.edges ??= []).push(
      buildEdge(entry.elkId, entry.edge, entry.from, entry.to, entry.sides, entry.label, entry.onFlow),
    );
  }

  /**
   * Choose the composition strategy.
   *
   * A canvas of several panels is composed panel by panel: one run per panel (so
   * each honours its own direction and may wrap its cards into a grid), then one
   * run that places those panels as fixed boxes. A single run cannot do that —
   * ELK drops a group's `direction` unless the group is separate, and its
   * wrapping pipeline throws when a connector crosses a wrapped group's border —
   * and the one-strip result is what motivated the split.
   *
   * A single panel, or a plain graph of nodes, keeps the single-run path: there
   * is nothing to compose, and that path is the one already covered by tests.
   */
  const topLevelPanels = groupOrder.filter((group) => group.parent === undefined).length;
  if (topLevelPanels >= 2) {
    return layoutComposed(diagram, measureText, {
      groupOrder,
      groupById: new Map(diagram.groups.map((group) => [group.id, group])),
      subtree,
      placements,
      edgeInputs,
      flowEdges,
    });
  }

  const engine = await loadEngine();
  const laidOut = await engine.layout(root);

  const rects = collectRects(laidOut);
  const elkEdges = collectEdges(laidOut, rects);

  const sceneGroups: SceneGroup[] = groupOrder.map((group) => {
    const rect = rects.get(`g:${group.id}`);
    if (rect === undefined) throw new Error(`Layout engine returned no geometry for group "${group.id}"`);
    return {
      id: group.id,
      parent: group.parent,
      label: group.label,
      tone: group.tone,
      dashed: group.dashed,
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
    };
  });

  const sceneNodes: SceneNode[] = diagram.nodes.map((node) => {
    const placement = placements.get(node.id)!;
    const rect = rects.get(`n:${node.id}`);
    if (rect === undefined) throw new Error(`Layout engine returned no geometry for node "${node.id}"`);
    const scene: SceneNode = {
      id: node.id,
      parent: node.group,
      shape: placement.metrics.shape,
      labelLines: placement.metrics.labelLines,
      subtitleLines: placement.metrics.subtitleLines,
      x: round(rect.x),
      y: round(rect.y),
      width: round(placement.metrics.width),
      height: round(placement.metrics.height),
    };
    if (node.icon !== undefined) scene.icon = node.icon;
    if (placement.metrics.card !== null) {
      scene.card = {
        x: round(scene.x + placement.metrics.card.x),
        y: round(scene.y + placement.metrics.card.y),
        width: round(placement.metrics.card.width),
        height: round(placement.metrics.card.height),
      };
    }
    return scene;
  });

  const sceneById = new Map(sceneNodes.map((node) => [node.id, node]));

  const sceneEdges: SceneEdge[] = edgeInputs.map((entry) => {
    const laid = elkEdges.get(entry.elkId);
    if (laid === undefined) throw new Error(`Layout engine returned no geometry for connector "${entry.edge.id}"`);

    const raw: Point[] = [];
    for (const section of orderedSections(laid.edge.sections ?? [])) {
      raw.push({ x: laid.origin.x + section.startPoint.x, y: laid.origin.y + section.startPoint.y });
      for (const bend of section.bendPoints ?? []) {
        raw.push({ x: laid.origin.x + bend.x, y: laid.origin.y + bend.y });
      }
      raw.push({ x: laid.origin.x + section.endPoint.x, y: laid.origin.y + section.endPoint.y });
    }
    if (raw.length < 2) throw new Error(`Layout engine returned an empty route for connector "${entry.edge.id}"`);

    trimToCard(raw, entry.from.metrics, sceneById.get(entry.from.node.id)!, true);
    trimToCard(raw, entry.to.metrics, sceneById.get(entry.to.node.id)!, false);
    const points = orthogonalize(raw);
    if (points.length < 2) {
      throw new Error(`Connector "${entry.edge.id}" collapsed while routing; check its explicit sides`);
    }

    const scene: SceneEdge = {
      id: entry.edge.id,
      source: entry.edge.from,
      target: entry.edge.to,
      kind: entry.edge.kind,
      points,
    };
    if (entry.label !== undefined) {
      const elkLabel = laid.edge.labels?.[0];
      if (elkLabel === undefined) {
        throw new Error(`Layout engine returned no label geometry for connector "${entry.edge.id}"`);
      }
      scene.label = {
        text: entry.label.text,
        x: round(laid.origin.x + num(elkLabel.x)),
        y: round(laid.origin.y + num(elkLabel.y)),
        width: round(entry.label.width),
        height: round(entry.label.height),
      };
    }
    return scene;
  });

  // Translate into the positive quadrant. ELK normally starts at its padding,
  // but a self-loop label can stick out past the origin, so bounds are measured
  // from the produced geometry rather than assumed.
  let minX = 0;
  let minY = 0;
  let maxX = num(laidOut.width);
  let maxY = num(laidOut.height);
  const extend = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const group of sceneGroups) extend(group.x + group.width, group.y + group.height);
  for (const node of sceneNodes) extend(node.x + node.width, node.y + node.height);
  for (const edge of sceneEdges) {
    for (const point of edge.points) extend(point.x, point.y);
    if (edge.label !== undefined) extend(edge.label.x + edge.label.width, edge.label.y + edge.label.height);
  }

  const shiftX = minX < 0 ? round(ROOT_PAD - minX) : 0;
  const shiftY = minY < 0 ? round(ROOT_PAD - minY) : 0;
  if (shiftX !== 0 || shiftY !== 0) {
    for (const group of sceneGroups) {
      group.x = round(group.x + shiftX);
      group.y = round(group.y + shiftY);
    }
    for (const node of sceneNodes) {
      node.x = round(node.x + shiftX);
      node.y = round(node.y + shiftY);
      if (node.card !== undefined) {
        node.card.x = round(node.card.x + shiftX);
        node.card.y = round(node.card.y + shiftY);
      }
    }
    for (const edge of sceneEdges) {
      for (const point of edge.points) {
        point.x = round(point.x + shiftX);
        point.y = round(point.y + shiftY);
      }
      if (edge.label !== undefined) {
        edge.label.x = round(edge.label.x + shiftX);
        edge.label.y = round(edge.label.y + shiftY);
      }
    }
  }

  return {
    title: diagram.title,
    width: round(Math.max(1, maxX + shiftX)),
    height: round(Math.max(1, maxY + shiftY)),
    groups: sceneGroups,
    nodes: sceneNodes,
    edges: sceneEdges,
  };
}
