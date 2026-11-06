export type Direction = "right" | "down" | "left" | "up";
export type Side = "north" | "east" | "south" | "west";
export type Tone = "warm" | "cool" | "neutral";
export type Shape = "service" | "process" | "decision" | "terminal";
export type EdgeKind = "primary" | "secondary" | "async";

export interface GroupSpec {
  id: string;
  label: string;
  parent?: string;
  tone?: Tone;
  dashed?: boolean;
  direction?: Direction;
  /**
   * Cards per row when the panel is laid out as a grid.
   *
   * A panel is a visual cluster, so its shape is an authoring decision: a
   * ten-card region reads as two columns of five, not one column of ten. This
   * states that shape directly instead of hoping a solver derives it.
   */
  columns?: number;
  /** Explicit panel geometry; required for every node and group in manual mode. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}
export interface NodeSpec {
  id: string;
  label: string;
  subtitle?: string;
  icon?: string;
  group?: string;
  shape?: Shape;
  /** Top-left corner in canvas space. Present on every node switches to manual layout. */
  x?: number;
  y?: number;
  /** Authored box size. Authoritative in manual layout, a minimum in auto. */
  width?: number;
  height?: number;
  /** Authored icon card offset from the node origin; manual layout only. */
  cardX?: number;
  cardY?: number;
  cardWidth?: number;
  cardHeight?: number;
}
export interface EdgeSpec {
  id?: string;
  from: string;
  to: string;
  label?: string;
  kind?: EdgeKind;
  fromSide?: Side;
  toSide?: Side;
  /** Explicit interior bend points for manual layout; endpoints are derived. */
  via?: Point[];
  /** Manual attachment point on the source box, as fractions of its width/height. */
  fromAnchor?: Point;
  /** Manual attachment point on the target box, as fractions of its width/height. */
  toAnchor?: Point;
  /** Authored label offset from the route midpoint, in pixels. */
  labelOffset?: Point;
  /** Authored absolute label anchor: horizontal centre and text baseline. */
  labelAt?: Point;
}
/**
 * Geometry shared by every node.
 *
 * A hand-composed diagram usually gives every card the same box and icon square,
 * so repeating them per node is noise that must stay in sync. A node may still
 * override any field individually.
 */
export interface NodeDefaults {
  width?: number;
  height?: number;
  cardX?: number;
  cardY?: number;
  cardWidth?: number;
  cardHeight?: number;
}

export interface DiagramSpec {
  title?: string;
  direction?: Direction;
  groups?: GroupSpec[];
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  /** Prefer straight routing along these existing consecutive connections. */
  flow?: string[];
  /** Box and icon-card geometry shared by every node in manual mode. */
  defaults?: NodeDefaults;
  /**
   * `"manual"` places nodes from their explicit `x`/`y` and skips automatic
   * layout; `"auto"` (the default) ignores no coordinates because none are
   * allowed. Manual is what reproduces a hand-composed reference.
   */
  layout?: "auto" | "manual";
}
export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }
export interface SceneGroup extends Rect {
  id: string;
  parent?: string;
  label: string;
  tone: Tone;
  dashed: boolean;
}
export interface SceneNode extends Rect {
  id: string;
  parent?: string;
  shape: Shape;
  icon?: string;
  labelLines: string[];
  subtitleLines: string[];
  /** Absolute visible icon-card rectangle; only service nodes have one. */
  card?: Rect;
}
export interface SceneEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  points: Point[];
  label?: Rect & { text: string };
}
export interface Scene {
  title: string;
  width: number;
  height: number;
  groups: SceneGroup[];
  nodes: SceneNode[];
  edges: SceneEdge[];
}
export type IconMap = Record<string, string>;
export type MeasureText = (text: string, font: string) => number;
