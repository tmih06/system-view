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
}
export interface NodeSpec {
  id: string;
  label: string;
  subtitle?: string;
  icon?: string;
  group?: string;
  shape?: Shape;
}
export interface EdgeSpec {
  id?: string;
  from: string;
  to: string;
  label?: string;
  kind?: EdgeKind;
  fromSide?: Side;
  toSide?: Side;
}
export interface DiagramSpec {
  title?: string;
  direction?: Direction;
  groups?: GroupSpec[];
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  /** Prefer straight routing along these existing consecutive connections. */
  flow?: string[];
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
