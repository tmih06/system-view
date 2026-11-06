import type { Direction, EdgeKind, Point, Rect } from "./types";

/**
 * Deterministic placement of a composed diagram from measured sizes.
 *
 * The caller measures every card and every panel heading; this module answers
 * where each panel, sub-panel and card sits. It never measures text, never reads
 * an id for meaning and never consults an authored fixture: geometry is a
 * function of the measured sizes, the declared structure and the declared flow.
 *
 * The result is one absolute rectangle per element, keyed `g:<id>` for a panel
 * and `n:<id>` for a card. Panel rectangles include a heading strip, and the
 * heading's measured width is an input, so a panel is never narrower than its own
 * label.
 *
 * The shape of the result:
 *
 * - A leaf panel (cards only) is a uniform grid. Every cell takes the largest
 *   measured card on the canvas, so all panels share one pitch and read as one
 *   table; cards sit at the cell's top-left so lanes share a baseline.
 * - A leaf panel holding two or more canvas-flow cards reserves one lane for
 *   exactly those cards, in flow order, on the panel's leading edge. The lane is
 *   a row on a horizontal canvas and a column on a vertical one, so it always
 *   lies across the axis the wires travel.
 * - A panel holding both direct cards and nested panels uses a narrow card rail
 *   beside a compact stack of nested panels. Nested panels keep their measured
 *   size instead of being inflated to one common cell, which is what used to grow
 *   a tall blank column inside the parent. A rail card wired into the stack is
 *   translated onto the line of the card it drives.
 * - Top-level panels that are structural (> 3 cards), carry the request path, or
 *   carry a primary wire form one row in declaration order. Panels are then
 *   translated until flow members share one line. Small satellite panels hang
 *   under the panel they connect to most strongly; fully disconnected panels take
 *   their own band at the origin.
 *
 * Reversed canvas directions mirror the top-level composition, never a panel's
 * interior: an `up` canvas stacks panels bottom to top while each panel keeps its
 * heading on top and its own declared reading order.
 *
 * Nothing here stretches a card or invents a panel size: alignment is always a
 * translation, every gutter inside a panel is at least 36 px, and the gutter
 * between top-level panels is at least 48 px.
 */
export interface PlacementGroup {
  id: string;
  parent?: string;
  direction?: Direction;
  /** Explicit cards per row; wins over the direction-derived grid shape. */
  columns?: number;
  /** Measured width of the panel heading, in pixels. */
  labelWidth: number;
}

export interface PlacementNode {
  id: string;
  group?: string;
  /** Measured footprint width; a card may be widened to its grid cell. */
  width: number;
  height: number;
  /** Declaration position among all nodes; the member reading order. */
  order: number;
}

export interface PlacementEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

/** Heading strip. At least 48 keeps a north wire escape clear of the text. */
const PAD_TOP = 48;
const PAD_SIDE = 18;
const PAD_BOTTOM = 18;
/** Pitch between card cells inside one panel. */
const CELL_GAP = 36;
/** Gap between sibling nested panels in a stack. */
const STACK_GAP = 36;
/** Gap between a card rail and the nested-panel stack beside it. */
const RAIL_GAP = 36;
/** Minimum gutter between top-level panels, satellites included. */
const PANEL_GAP = 48;
/** Room a heading needs beyond the panel's side padding. */
const LABEL_GUTTER = 12;
/** A `down`/`up` leaf with more cards than this wraps into a grid. */
const GRID_ROWS_BEFORE_WRAP = 6;

/**
 * Direction a panel lays its members out in when the author did not say.
 *
 * A panel takes the direction perpendicular to the run it sits in, so a
 * horizontal canvas of panels reads as columns of members.
 */
const PERPENDICULAR: Record<Direction, Direction> = {
  right: "down",
  left: "down",
  down: "right",
  up: "right",
};

/** One direct member of a panel, positioned relative to that panel's origin. */
interface Area {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A panel's extent plus its direct members' relative rectangles. */
interface PanelLayout {
  width: number;
  height: number;
  areas: Area[];
}

/** A top-level element: a root panel, or a card declared outside every panel. */
interface CanvasItem {
  key: string;
  width: number;
  height: number;
  /** Declaration position; the reading order of the canvas row. */
  order: number;
}

interface Context {
  groups: readonly PlacementGroup[];
  nodes: readonly PlacementNode[];
  edges: readonly PlacementEdge[];
  groupById: Map<string, PlacementGroup>;
  nodeById: Map<string, PlacementNode>;
  nodesOf: Map<string | undefined, PlacementNode[]>;
  childrenOf: Map<string | undefined, PlacementGroup[]>;
  /** Every card in a panel's subtree; classifies and connects panels. */
  descendants: Map<string, Set<string>>;
  /** Built deepest-first, so a parent can read its children's sizes. */
  layouts: Map<string, PanelLayout>;
  flowIndex: Map<string, number>;
  /** One card cell for the whole canvas; see {@link commonCell}. */
  cell: { width: number; height: number };
}

/** Rect of an item placed at `at`. */
function rectAt(at: Point, width: number, height: number): Rect {
  return { x: at.x, y: at.y, width, height };
}


/**
 * Honour the group's direction, otherwise alternate the parent's axis.
 * Input containment is already validated by layoutDiagram.
 */
function effectiveDirection(context: Context, groupId: string, canvasDirection: Direction): Direction {
  const group = context.groupById.get(groupId)!;
  if (group.direction !== undefined) return group.direction;
  const enclosing = group.parent === undefined
    ? canvasDirection
    : effectiveDirection(context, group.parent, canvasDirection);
  return PERPENDICULAR[enclosing];
}

/**
 * Cards per row for a leaf panel.
 *
 * `columns` states the panel's shape directly. Otherwise a horizontal direction
 * keeps all cards in one row and a vertical one uses a single column until the
 * panel is tall enough that a squarish grid reads better. Reversed directions
 * share the same shape; their offsets are mirrored after packing.
 */
function columnsFor(group: PlacementGroup, count: number, direction: Direction): number {
  if (count <= 0) return 1;
  if (group.columns !== undefined) return Math.max(1, Math.min(Math.floor(group.columns), count));
  if (direction === "right" || direction === "left") return count;
  return count <= GRID_ROWS_BEFORE_WRAP ? 1 : Math.ceil(Math.sqrt(count));
}

/**
 * Mirror packed offsets for a reversed direction.
 *
 * `left` and `up` panels keep their declaration order in memory and are read
 * backwards on screen, which is what the author asked for by naming that
 * direction. Mirroring the offsets is enough because every cell has one size.
 */
function mirrorAreas(areas: Area[], innerWidth: number, innerHeight: number, direction: Direction): void {
  if (direction === "left") {
    for (const area of areas) area.x = PAD_SIDE + innerWidth - (area.x - PAD_SIDE) - area.width;
  }
  if (direction === "up") {
    for (const area of areas) area.y = PAD_TOP + innerHeight - (area.y - PAD_TOP) - area.height;
  }
}

/** A card's cell in a panel grid: zero-based row and column. */
interface Cell {
  node: PlacementNode;
  row: number;
  column: number;
}

/**
 * Cells for a panel's direct cards.
 *
 * Declaration order fills the grid row-major, and `columns` caps a row, which is
 * the shape the author declared. On top of that, a panel carrying two or more
 * canvas flow members reserves a lane for exactly those cards, in flow order, on
 * the panel's leading edge — the top for a horizontal canvas, the first column
 * for a vertical one. That is what lets a wire crossing panels meet the flow
 * without stepping around an unrelated card.
 *
 * Cards declared before the earliest flow member go in front of the reserved
 * lane when there is room for a lane before it (horizontal canvas); on a vertical
 * canvas the leading column belongs to the flow, so they follow it. A single flow
 * member is not a lane: reserving one cell would cost the panel a whole lane.
 *
 * @returns Sparse cells plus the grid's row and column counts.
 */
function gridCells(
  members: readonly PlacementNode[],
  flowIndex: Map<string, number>,
  columns: number,
  horizontalFlow: boolean,
): { cells: Cell[]; rows: number; columns: number } {
  const cap = Math.max(1, columns);
  const inFlow = members.filter((member) => flowIndex.has(member.id));
  const cells: Cell[] = [];

  if (inFlow.length < 2) {
    members.forEach((node, index) => {
      cells.push({ node, row: Math.floor(index / cap), column: index % cap });
    });
    return { cells, rows: Math.ceil(members.length / cap), columns: cap };
  }

  const lane = [...inFlow].sort((a, b) => flowIndex.get(a.id)! - flowIndex.get(b.id)!);
  const laneStart = lane[0].order;
  const before: PlacementNode[] = [];
  const after: PlacementNode[] = [];
  for (const member of members) {
    if (flowIndex.has(member.id)) continue;
    if (member.order < laneStart) before.push(member);
    else after.push(member);
  }

  if (horizontalFlow) {
    // Lanes are rows: side inputs declared first keep rows above the flow row.
    const rows: PlacementNode[][] = [];
    for (let index = 0; index < before.length; index += cap) rows.push(before.slice(index, index + cap));
    rows.push(lane);
    for (let index = 0; index < after.length; index += cap) rows.push(after.slice(index, index + cap));
    rows.forEach((row, rowIndex) => {
      row.forEach((node, column) => cells.push({ node, row: rowIndex, column }));
    });
    return { cells, rows: rows.length, columns: Math.max(1, ...rows.map((row) => row.length)) };
  }

  // Lanes are columns: the flow owns the leading column, one card per row, and
  // everything else fills the remaining cells row-major around it.
  const flowRows = lane.length;
  const total = Math.max(flowRows, Math.ceil(members.length / cap));
  const taken = new Set<string>();
  lane.forEach((node, index) => {
    cells.push({ node, row: index, column: 0 });
    taken.add(`${index},0`);
  });
  let cursor = 0;
  for (const node of [...before, ...after]) {
    while (taken.has(`${Math.floor(cursor / cap)},${cursor % cap}`)) cursor += 1;
    const row = Math.floor(cursor / cap);
    const column = cursor % cap;
    cells.push({ node, row, column });
    taken.add(`${row},${column}`);
    cursor += 1;
  }
  const rows = Math.max(
    total,
    Math.max(...cells.map((cell) => cell.row)) + 1,
  );
  return { cells, rows, columns: Math.max(1, ...cells.map((cell) => cell.column + 1)) };
}

/** Minimum width a panel needs to show its heading beside the side padding. */
function labelMinWidth(group: PlacementGroup): number {
  return PAD_SIDE * 2 + group.labelWidth + LABEL_GUTTER;
}

/**
 * Uniform grid for a panel that holds cards only.
 *
 * Every cell is the canvas card cell, so the panel reads as part of one table.
 * Cards occupy the cell's top-left, which keeps the first lane of every panel on
 * the same line — the property the canvas relies on when it aligns flow members
 * across panels.
 */
function gridLayout(
  members: readonly PlacementNode[],
  columns: number,
  minimumWidth: number,
  direction: Direction,
  cell: { width: number; height: number },
  flowIndex: Map<string, number>,
  horizontalFlow: boolean,
): PanelLayout {
  if (members.length === 0) {
    return { width: minimumWidth, height: PAD_TOP + PAD_BOTTOM, areas: [] };
  }
  const grid = gridCells(members, flowIndex, columns, horizontalFlow);
  const innerWidth = grid.columns * cell.width + (grid.columns - 1) * CELL_GAP;
  const innerHeight = grid.rows * cell.height + (grid.rows - 1) * CELL_GAP;
  const areas: Area[] = grid.cells.map((entry) => ({
    key: `n:${entry.node.id}`,
    x: PAD_SIDE + entry.column * (cell.width + CELL_GAP),
    y: PAD_TOP + entry.row * (cell.height + CELL_GAP),
    width: cell.width,
    height: cell.height,
  }));
  mirrorAreas(areas, innerWidth, innerHeight, direction);
  return {
    width: Math.max(PAD_SIDE * 2 + innerWidth, minimumWidth),
    height: PAD_TOP + innerHeight + PAD_BOTTOM,
    areas,
  };
}

/** Nested panels stacked vertically at their own measured sizes. */
function stackBlock(context: Context, children: readonly PlacementGroup[]): { width: number; height: number; areas: Area[] } {
  const areas: Area[] = [];
  let y = 0;
  let widest = 0;
  for (const child of children) {
    const layout = context.layouts.get(child.id);
    if (layout === undefined) continue;
    areas.push({ key: `g:${child.id}`, x: 0, y, width: layout.width, height: layout.height });
    widest = Math.max(widest, layout.width);
    y += layout.height + STACK_GAP;
  }
  return { width: widest, height: Math.max(0, y - STACK_GAP), areas };
}

/** Panel of nested panels only: one compact stack under the heading. */
function stackLayout(context: Context, children: readonly PlacementGroup[], minimumWidth: number, direction: Direction): PanelLayout {
  const block = stackBlock(context, children);
  const areas = block.areas.map((area) => ({ ...area, x: area.x + PAD_SIDE, y: area.y + PAD_TOP }));
  mirrorAreas(areas, block.width, block.height, direction);
  return {
    width: Math.max(PAD_SIDE * 2 + block.width, minimumWidth),
    height: PAD_TOP + block.height + PAD_BOTTOM,
    areas,
  };
}

/** First rectangle for `key` inside `areas`, descending into nested panels. */
function offsetWithin(context: Context, areas: readonly Area[], key: string): Rect | undefined {
  for (const area of areas) {
    if (area.key === key) return { x: area.x, y: area.y, width: area.width, height: area.height };
    if (!area.key.startsWith("g:")) continue;
    const layout = context.layouts.get(area.key.slice(2));
    if (layout === undefined) continue;
    const inner = offsetWithin(context, layout.areas, key);
    if (inner !== undefined) {
      return { x: area.x + inner.x, y: area.y + inner.y, width: inner.width, height: inner.height };
    }
  }
  return undefined;
}

/** Connectors with `nodeId` at either end, strongest kind first. */
function edgesOf(context: Context, nodeId: string): PlacementEdge[] {
  const result: PlacementEdge[] = [];
  for (const edge of context.edges) {
    if (edge.from === nodeId || edge.to === nodeId) result.push(edge);
  }
  return result.sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
}

/** Wire strength: a primary request path outweighs a secondary link. */
function kindRank(kind: EdgeKind): number {
  return kind === "primary" ? 0 : kind === "secondary" ? 1 : 2;
}

/**
 * Panel holding both direct cards and nested panels.
 *
 * This is the case the equal-cell layout could not express: sizing every member
 * as one cell of a uniform grid gave a one-card sub-panel the same box as an
 * eight-card one, so the parent grew a blank rectangle as tall as the tallest
 * child. Here the direct cards form a narrow rail and the sub-panels keep their
 * measured sizes in a compact stack beside it.
 *
 * Which way "beside" points follows the canvas, because that is the axis the
 * request path travels: on a horizontal canvas the rail stands left of the stack,
 * so the card that enters the panel and the card it drives share a top edge; on a
 * vertical canvas the rail stands above the stack and is nudged sideways onto the
 * driven card's column, so they share a left edge. Either way a rail card wired
 * into the stack is translated onto its target's line — never stretched — and the
 * rail keeps declaration order at one cell pitch.
 */
function mixedLayout(
  context: Context,
  cards: readonly PlacementNode[],
  children: readonly PlacementGroup[],
  minimumWidth: number,
  direction: Direction,
  verticalFlow: boolean,
): PanelLayout {
  const block = stackBlock(context, children);
  // The rail matches the canvas pitch, so a direct card and a nested card read as
  // the same kind of object even though one sits beside the stack.
  const railWidth = context.cell.width;

  /**
   * Stack card this rail card should line up with.
   *
   * The next canvas-flow member inside the stack wins, because that is the line a
   * reader follows: a request enters the panel at its rail card and continues
   * into the nested panel it drives. Without flow information the strongest wire
   * wins. A rail card with no wire into the stack keeps its declared place.
   */
  const alignTarget = (card: PlacementNode): Rect | undefined => {
    const here = context.flowIndex.get(card.id);
    let best: { inner: Rect; score: number; kind: number } | undefined;
    for (const edge of edgesOf(context, card.id)) {
      const other = edge.from === card.id ? edge.to : edge.from;
      const inner = offsetWithin(context, block.areas, `n:${other}`);
      if (inner === undefined) continue;
      const ahead = context.flowIndex.get(other);
      const score = here !== undefined && ahead !== undefined && ahead > here ? ahead : Number.MAX_SAFE_INTEGER;
      const kind = kindRank(edge.kind);
      if (best === undefined || score < best.score || (score === best.score && kind < best.kind)) {
        best = { inner, score, kind };
      }
    }
    return best?.inner;
  };

  const rail: Area[] = [];
  const areas: Area[] = [];
  let innerWidth: number;
  let innerHeight: number;

  if (verticalFlow) {
    // Rail row above the stack. Its x follows the driven card's column, so the
    // path drops through the shared column instead of stepping sideways.
    let railX = PAD_SIDE;
    let cursor = PAD_TOP;
    for (const card of cards) {
      const target = alignTarget(card);
      if (target !== undefined) railX = PAD_SIDE + target.x;
      rail.push({ key: `n:${card.id}`, x: railX, y: cursor, width: railWidth, height: context.cell.height });
      cursor += context.cell.height + CELL_GAP;
    }
    const stackX = PAD_SIDE;
    const stackAreas = block.areas.map((area) => ({
      key: area.key,
      x: stackX + area.x,
      y: cursor + area.y,
      width: area.width,
      height: area.height,
    }));
    innerWidth = Math.max(railX - PAD_SIDE + railWidth, block.width);
    innerHeight = cursor - PAD_TOP + block.height;
    areas.push(...rail, ...stackAreas);
  } else {
    // Rail column left of the stack; a rail card is translated down onto the row
    // of the card it drives.
    let cursor = PAD_TOP;
    let railBottom = PAD_TOP;
    for (const card of cards) {
      const target = alignTarget(card);
      const y = Math.max(cursor, target === undefined ? cursor : PAD_TOP + target.y);
      rail.push({ key: `n:${card.id}`, x: PAD_SIDE, y, width: railWidth, height: context.cell.height });
      cursor = y + context.cell.height + CELL_GAP;
      railBottom = y + context.cell.height;
    }
    const stackX = PAD_SIDE + railWidth + (block.width > 0 ? RAIL_GAP : 0);
    for (const area of block.areas) {
      areas.push({ key: area.key, x: stackX + area.x, y: PAD_TOP + area.y, width: area.width, height: area.height });
    }
    innerWidth = railWidth + (block.width > 0 ? RAIL_GAP + block.width : 0);
    innerHeight = Math.max(railBottom - PAD_TOP, block.height);
    areas.unshift(...rail);
  }

  mirrorAreas(areas, innerWidth, innerHeight, direction);
  return {
    width: Math.max(PAD_SIDE * 2 + innerWidth, minimumWidth),
    height: PAD_TOP + innerHeight + PAD_BOTTOM,
    areas,
  };
}

/**
 * One card cell for the whole canvas.
 *
 * Every grid cell in the composition takes the largest measured card, so cards
 * line up on a single pitch across panels instead of each panel inventing its
 * own. A shared pitch is what makes two panels read as one table, and it is why
 * the reference shows identical boxes everywhere; the caller recentres an icon
 * inside the widened card. The cell never shrinks below a card's own measured
 * footprint, so no caption is clipped.
 */
function commonCell(nodes: readonly PlacementNode[]): { width: number; height: number } {
  let width = 1;
  let height = 1;
  for (const node of nodes) {
    width = Math.max(width, node.width);
    height = Math.max(height, node.height);
  }
  return { width, height };
}

/** Build the lookup tables every pass needs. */
function buildContext(
  groups: readonly PlacementGroup[],
  nodes: readonly PlacementNode[],
  edges: readonly PlacementEdge[],
  flow: readonly string[],
): Context {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const nodesOf = new Map<string | undefined, PlacementNode[]>();
  const childrenOf = new Map<string | undefined, PlacementGroup[]>();
  const descendants = new Map<string, Set<string>>(groups.map((group) => [group.id, new Set<string>()]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const flowIndex = new Map<string, number>();
  flow.forEach((id, index) => {
    if (!flowIndex.has(id)) flowIndex.set(id, index);
  });

  const context: Context = {
    groups,
    nodes,
    edges,
    groupById,
    nodeById,
    nodesOf,
    childrenOf,
    descendants,
    layouts: new Map(),
    flowIndex,
    cell: commonCell(nodes),
  };

  for (const node of nodes) {
    const group = node.group;
    const siblings = nodesOf.get(group) ?? [];
    siblings.push(node);
    nodesOf.set(group, siblings);
    // A card belongs to every enclosing panel's subtree, innermost first.
    let current = group;
    while (current !== undefined) {
      descendants.get(current)!.add(node.id);
      current = groupById.get(current)!.parent;
    }
  }
  for (const group of groups) {
    const parent = group.parent;
    const siblings = childrenOf.get(parent) ?? [];
    siblings.push(group);
    childrenOf.set(parent, siblings);
  }
  for (const list of nodesOf.values()) list.sort((a, b) => a.order - b.order);
  return context;
}

/** Depth of a validated panel, root panels counting as one. */
function depthOf(context: Context, groupId: string): number {
  let depth = 0;
  let current: string | undefined = groupId;
  while (current !== undefined) {
    depth += 1;
    current = context.groupById.get(current)!.parent;
  }
  return depth;
}

/** Build every panel's interior, deepest first so parents can read children. */
function buildPanels(context: Context, direction: Direction): void {
  const deepestFirst = [...context.groups].sort(
    (a, b) => depthOf(context, b.id) - depthOf(context, a.id) || a.id.localeCompare(b.id),
  );
  for (const group of deepestFirst) {
    const cards = context.nodesOf.get(group.id) ?? [];
    const children = context.childrenOf.get(group.id) ?? [];
    const panelDirection = effectiveDirection(context, group.id, direction);
    const minimumWidth = labelMinWidth(group);
    let layout: PanelLayout;
    if (cards.length > 0 && children.length > 0) {
      layout = mixedLayout(
        context,
        cards,
        children,
        minimumWidth,
        panelDirection,
        !flowHorizontal(direction),
      );
    } else if (children.length > 0) {
      layout = stackLayout(context, children, minimumWidth, panelDirection);
    } else {
      layout = gridLayout(
        cards,
        columnsFor(group, cards.length, panelDirection),
        minimumWidth,
        panelDirection,
        context.cell,
        context.flowIndex,
        flowHorizontal(direction),
      );
    }
    context.layouts.set(group.id, layout);
  }
}

/** A top-level element with its absolute rectangle. */
interface PlacedItem {
  key: string;
  item: CanvasItem;
  x: number;
  y: number;
}

/**
 * Top-level items in declaration order: root panels and loose cards.
 *
 * A panel has no index of its own in a script, so it takes the earliest position
 * of any card inside it. That is what keeps a canvas in the order the script
 * declares even when it mixes loose cards and panels: the cards declared before
 * Cloudflare stay before Cloudflare. A panel with no cards at all sorts after the
 * content it cannot place, keeping declaration order among such panels.
 */
function canvasItems(context: Context): CanvasItem[] {
  const items: CanvasItem[] = [];
  let emptyPanels = 0;
  for (const group of context.childrenOf.get(undefined) ?? []) {
    const layout = context.layouts.get(group.id)!;
    let order = Number.POSITIVE_INFINITY;
    for (const id of context.descendants.get(group.id) ?? []) {
      const declared = context.nodeById.get(id);
      if (declared !== undefined) order = Math.min(order, declared.order);
    }
    if (!Number.isFinite(order)) order = context.nodes.length + emptyPanels;
    emptyPanels += 1;
    items.push({ key: `g:${group.id}`, width: layout.width, height: layout.height, order });
  }
  for (const node of context.nodesOf.get(undefined) ?? []) {
    items.push({ key: `n:${node.id}`, width: node.width, height: node.height, order: node.order });
  }
  return items.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

/** Cards inside an item's subtree; a loose card is its own single member. */
function memberIds(context: Context, key: string): Set<string> {
  if (key.startsWith("n:")) return new Set([key.slice(2)]);
  return context.descendants.get(key.slice(2)) ?? new Set<string>();
}

/** True when the item carries at least one card of the canvas flow. */
function carriesFlow(context: Context, key: string): boolean {
  for (const id of memberIds(context, key)) if (context.flowIndex.has(id)) return true;
  return false;
}

/** True when a primary wire touches the item's subtree. */
function touchesPrimary(context: Context, key: string): boolean {
  const members = memberIds(context, key);
  for (const edge of context.edges) {
    if (edge.kind !== "primary") continue;
    if (members.has(edge.from) || members.has(edge.to)) return true;
  }
  return false;
}

/**
 * True when an item belongs in the main row.
 *
 * "Major" is structural, never nominal: more than three cards is a panel with a
 * body large enough to read as a section; a panel on the request path is the
 * spine the reader follows; a panel carrying a primary wire is part of the
 * backbone even when it is small. Everything else is a satellite and hangs under
 * whatever it connects to.
 */
function isMajor(context: Context, key: string): boolean {
  if (key.startsWith("n:")) return true;
  return memberIds(context, key).size > 3 || carriesFlow(context, key) || touchesPrimary(context, key);
}

/**
 * Wire weight between two items' cards.
 *
 * A primary path counts 3, a secondary link 2, an async notice 1, so the panel a
 * satellite actually serves wins over an incidental async mention.
 */
function connectionWeight(context: Context, from: Set<string>, to: Set<string>): number {
  let total = 0;
  for (const edge of context.edges) {
    const forward = from.has(edge.from) && to.has(edge.to);
    const backward = from.has(edge.to) && to.has(edge.from);
    if (!forward && !backward) continue;
    total += edge.kind === "primary" ? 3 : edge.kind === "secondary" ? 2 : 1;
  }
  return total;
}

/** Absolute rectangle of a card once its top-level item has an origin. */
function nodeRect(context: Context, item: PlacedItem, nodeId: string): Rect | undefined {
  if (item.key.startsWith("n:")) {
    return item.key === `n:${nodeId}`
      ? { x: item.x, y: item.y, width: item.item.width, height: item.item.height }
      : undefined;
  }
  const layout = context.layouts.get(item.key.slice(2));
  if (layout === undefined) return undefined;
  const inner = offsetWithin(context, layout.areas, `n:${nodeId}`);
  if (inner === undefined) return undefined;
  return { x: item.x + inner.x, y: item.y + inner.y, width: inner.width, height: inner.height };
}

/** Top-level item containing a card in the validated containment tree. */
function itemOfNode(context: Context, node: PlacementNode): string {
  if (node.group === undefined) return `n:${node.id}`;
  const group = context.groupById.get(node.group)!;
  let current = group;
  for (;;) {
    const parent = current.parent;
    if (parent === undefined) return `g:${current.id}`;
    current = context.groupById.get(parent)!;
  }
}

/** True when the canvas reads left to right, so the flow runs horizontally. */
function flowHorizontal(direction: Direction): boolean {
  return direction === "right" || direction === "left";
}

/**
 * Translate top-level items until the canvas flow shares one line.
 *
 * Panels start with their first row at the same top offset, so a flow that only
 * uses the first row is already aligned. A panel whose flow member sits below an
 * earlier side row, or whose size differs from its neighbour's, is shifted as a
 * whole. Alignment is therefore a translation: no panel is stretched, no card is
 * resized and no gutter is consumed. Each item moves at most once, which keeps
 * the result stable when the flow revisits a panel.
 */
function alignFlow(context: Context, placed: PlacedItem[], direction: Direction): void {
  const byKey = new Map(placed.map((entry) => [entry.key, entry]));
  const sequence: Array<{ item: PlacedItem; node: PlacementNode }> = [];
  for (const id of context.flowIndex.keys()) {
    const node = context.nodeById.get(id);
    if (node === undefined) continue;
    const item = byKey.get(itemOfNode(context, node));
    if (item !== undefined) sequence.push({ item, node });
  }
  sequence.sort((a, b) => context.flowIndex.get(a.node.id)! - context.flowIndex.get(b.node.id)!);

  const moved = new Set<string>();
  for (let index = 1; index < sequence.length; index += 1) {
    const previous = sequence[index - 1];
    const current = sequence[index];
    if (previous.item === current.item || moved.has(current.item.key)) continue;
    const exit = nodeRect(context, previous.item, previous.node.id);
    const entry = nodeRect(context, current.item, current.node.id);
    if (exit === undefined || entry === undefined) continue;
    if (flowHorizontal(direction)) current.item.y += exit.y - entry.y;
    else current.item.x += exit.x - entry.x;
    moved.add(current.item.key);
  }
}

/**
 * Place every element and return absolute rectangles keyed `g:<id>` / `n:<id>`.
 *
 * The main row holds the major panels in declaration order, so the canvas keeps
 * the reading order the script declares instead of a solver's layer order.
 * Satellites hang below the major panel they talk to most, aligned to its left
 * edge; a disconnected satellite drops to a loose row below the left edge, which
 * is where a reader looks for something the diagram does not otherwise tie in.
 *
 * Reversed canvas directions mirror the finished composition: the reading order
 * reverses, every relative alignment and gutter survives, and no rule needs a
 * second code path.
 *
 * @param groups Panels with measured heading widths, parents before children.
 * @param nodes Cards with measured footprints and declaration order.
 * @param edges Connectors, used only for strength and flow classification.
 * @param flow Node ids on the request path, in reading order.
 * @param direction Canvas direction; `left`/`up` mirror the composition.
 */
export function placePanels(
  groups: readonly PlacementGroup[],
  nodes: readonly PlacementNode[],
  edges: readonly PlacementEdge[],
  flow: readonly string[],
  direction: Direction,
): Map<string, Rect> {
  const context = buildContext(groups, nodes, edges, flow);
  buildPanels(context, direction);
  const items = canvasItems(context);
  const horizontal = flowHorizontal(direction);

  /**
   * Main row.
   *
   * Major items follow declaration order along the reading axis, so the canvas
   * keeps the script's order rather than a solver's layer order. Both axes start
   * at zero; `alignFlow` then slides panels into the request path.
   */
  const row: PlacedItem[] = [];
  let cursor = 0;
  for (const item of items) {
    if (!isMajor(context, item.key)) continue;
    row.push({ key: item.key, item, x: horizontal ? cursor : 0, y: horizontal ? 0 : cursor });
    cursor += (horizontal ? item.width : item.height) + PANEL_GAP;
  }
  alignFlow(context, row, direction);

  /** Extent of the main row along each axis, after flow alignment. */
  let rowWidth = 0;
  let rowHeight = 0;
  for (const entry of row) {
    rowWidth = Math.max(rowWidth, entry.x + entry.item.width);
    rowHeight = Math.max(rowHeight, entry.y + entry.item.height);
  }

  // --- Satellites: beside the major panel they talk to most ---
  const owned = new Map<string, CanvasItem[]>();
  const unowned: CanvasItem[] = [];
  for (const item of items) {
    if (isMajor(context, item.key)) continue;
    const members = memberIds(context, item.key);
    let owner: string | undefined;
    let best = 0;
    for (const candidate of row) {
      const weight = connectionWeight(context, members, memberIds(context, candidate.key));
      if (weight > best) {
        best = weight;
        owner = candidate.key;
      }
    }
    if (owner === undefined) {
      unowned.push(item);
      continue;
    }
    const list = owned.get(owner) ?? [];
    list.push(item);
    owned.set(owner, list);
  }

  /**
   * Hanging band under (or beside) the main row.
   *
   * A satellite starts on its owner's front edge — the owner's left edge for a
   * horizontal canvas, its top edge for a vertical one — so a section reads as a
   * column of its own rather than a canvas of loose boxes. A second satellite is
   * pushed along the reading axis by its predecessor, which keeps the band
   * ordered and non-overlapping; the band's own offset is one gutter past the
   * main row.
   */
  const satellites: PlacedItem[] = [];
  let bandCursor = 0;
  let bandExtent = 0;
  for (const owner of row) {
    for (const item of owned.get(owner.key) ?? []) {
      const along = Math.max(horizontal ? owner.x : owner.y, bandCursor);
      const across = (horizontal ? rowHeight : rowWidth) + PANEL_GAP;
      satellites.push({
        key: item.key,
        item,
        x: horizontal ? along : across,
        y: horizontal ? across : along,
      });
      bandCursor = along + (horizontal ? item.width : item.height) + PANEL_GAP;
      bandExtent = Math.max(bandExtent, across + (horizontal ? item.height : item.width));
    }
  }

  // --- Disconnected satellites: their own band past the far edge, at the origin ---
  const loose: PlacedItem[] = [];
  const looseAcross = (satellites.length > 0 ? bandExtent : horizontal ? rowHeight : rowWidth) + PANEL_GAP;
  let looseCursor = 0;
  for (const item of unowned) {
    loose.push({
      key: item.key,
      item,
      x: horizontal ? looseCursor : looseAcross,
      y: horizontal ? looseAcross : looseCursor,
    });
    looseCursor += (horizontal ? item.width : item.height) + PANEL_GAP;
  }

  /**
   * Absolute rectangles for every element.
   *
   * A reversed canvas mirrors whole top-level items, never their contents: an
   * `up` canvas stacks panels bottom to top while each panel keeps its heading at
   * the top and its own declared reading order. Mirroring the card rectangles
   * instead would turn a `down` panel upside down, which is not what the author
   * asked for and would move a card under the heading strip.
   */
  const tops = [...row, ...satellites, ...loose];
  let extentWidth = 0;
  let extentHeight = 0;
  for (const entry of tops) {
    extentWidth = Math.max(extentWidth, entry.x + entry.item.width);
    extentHeight = Math.max(extentHeight, entry.y + entry.item.height);
  }
  const mirrored = tops.map((entry) => {
    let x = entry.x;
    let y = entry.y;
    if (direction === "left") x = extentWidth - entry.x - entry.item.width;
    if (direction === "up") y = extentHeight - entry.y - entry.item.height;
    return { entry, origin: { x, y } };
  });
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const { origin } of mirrored) {
    minX = Math.min(minX, origin.x);
    minY = Math.min(minY, origin.y);
  }
  const rects = new Map<string, Rect>();
  const emit = (key: string, at: Point, width: number, height: number): void => {
    rects.set(key, rectAt(at, width, height));
    if (!key.startsWith("g:")) return;
    const layout = context.layouts.get(key.slice(2));
    if (layout === undefined) return;
    for (const area of layout.areas) {
      emit(area.key, { x: at.x + area.x, y: at.y + area.y }, area.width, area.height);
    }
  };
  if (!Number.isFinite(minX)) return rects;
  for (const { entry, origin } of mirrored) {
    emit(entry.key, { x: origin.x - minX, y: origin.y - minY }, entry.item.width, entry.item.height);
  }
  return rects;
}
