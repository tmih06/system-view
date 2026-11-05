import type { Point, Rect } from "./types";

/**
 * Typed boundary around the ELK layout engine.
 *
 * Kept apart from the layout pass so the graph-shaping decisions in `layout.ts`
 * stay readable: this module owns the engine's async loading, the JSON graph and
 * result shapes actually used, and the translation of absolute rectangles and
 * connector polylines out of ELK's nested result tree.
 *
 * The types are structural subsets of ELK's own JSON format, declared here rather
 * than imported so `elkjs` stays an implementation detail of the loader.
 */

/** Subset of ELK's graph model this codebase builds. */
export interface ElkPort {
  id: string;
  width: number;
  height: number;
  /** Fixed position inside the owning node, for `FIXED_POS` ports. */
  x?: number;
  y?: number;
  layoutOptions?: Record<string, string>;
}

export interface ElkLabel {
  text: string;
  width: number;
  height: number;
}

export interface ElkGraphNode {
  id: string;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
  labels?: ElkLabel[];
  ports?: ElkPort[];
  children?: ElkGraphNode[];
  edges?: ElkGraphEdge[];
}

export interface ElkGraphEdge {
  id: string;
  sources: string[];
  targets: string[];
  label?: ElkLabel;
  labels?: ElkLabel[];
  layoutOptions?: Record<string, string>;
}

export interface ElkPoint {
  x: number;
  y: number;
}

export interface ElkSection {
  id: string;
  startPoint: ElkPoint;
  endPoint: ElkPoint;
  bendPoints?: ElkPoint[];
  incomingSections?: string[];
  outgoingSections?: string[];
}

export interface ElkResultEdge {
  id: string;
  sections?: ElkSection[];
  labels?: Array<{ x?: number; y?: number; width?: number; height?: number }>;
}

export interface ElkResultNode {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  ports?: Array<{ id: string; x?: number; y?: number; width?: number; height?: number }>;
  children?: ElkResultNode[];
  edges?: ElkResultEdge[];
}

export interface ElkEngine {
  layout(graph: ElkGraphNode): Promise<ElkResultNode>;
}

interface ElkConstructorModule {
  default?: new () => ElkEngine;
}

let enginePromise: Promise<ElkEngine> | null = null;

/**
 * Load ELK once and reuse the engine.
 *
 * elkjs decides at import time between "browser worker scope" and "CommonJS
 * export" by testing for `document`. Bun and Node define `self` but not
 * `document`, which lands on the worker branch and leaves the fake worker
 * unexported, so construction fails. Supplying a temporary empty `document`
 * during import *and* construction selects the CommonJS branch there; a real
 * browser keeps its own `document` and this branch is never taken. The shim is
 * removed in a `finally`, so no global state leaks into the host page.
 *
 * The `await import()` below is deliberate: a static import is hoisted above the
 * shim, so elkjs would pick its branch before `document` exists and throw under
 * Bun. The specifier is fixed at author time, so the module is still bundled and
 * typechecked; only its evaluation timing is deferred.
 */
export function loadEngine(): Promise<ElkEngine> {
  enginePromise ??= (async () => {
    const host = globalThis as { document?: unknown };
    const needsShim = typeof host.document === "undefined";
    if (needsShim) host.document = {};
    try {
      const module = (await import("elkjs/lib/elk.bundled.js")) as unknown as ElkConstructorModule;
      const Constructor = module.default;
      if (typeof Constructor !== "function") {
        throw new Error('Layout engine unavailable: "elkjs/lib/elk.bundled.js" exported no constructor');
      }
      return new Constructor();
    } finally {
      if (needsShim) delete host.document;
    }
  })();
  return enginePromise;
}

/** ELK treats a missing number as absent; scene geometry must never hold NaN. */
export function num(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Absolute rectangle of every ELK node, keyed by element id. */
export function collectRects(root: ElkResultNode): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  const walk = (node: ElkResultNode, originX: number, originY: number): void => {
    const x = originX + num(node.x);
    const y = originY + num(node.y);
    rects.set(node.id, { x, y, width: num(node.width), height: num(node.height) });
    for (const child of node.children ?? []) walk(child, x, y);
  };
  walk(root, 0, 0);
  return rects;
}

/** Every edge in every container, paired with its container's absolute origin. */
export function collectEdges(
  root: ElkResultNode,
  rects: Map<string, Rect>,
): Map<string, { edge: ElkResultEdge; origin: Rect }> {
  const edges = new Map<string, { edge: ElkResultEdge; origin: Rect }>();
  const walk = (node: ElkResultNode): void => {
    const origin = rects.get(node.id) ?? { x: 0, y: 0, width: 0, height: 0 };
    for (const edge of node.edges ?? []) edges.set(edge.id, { edge, origin });
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return edges;
}

/** Order an edge's sections head-to-tail, following ELK's section links. */
export function orderedSections(sections: ElkSection[]): ElkSection[] {
  if (sections.length <= 1) return sections;
  const byId = new Map(sections.map((section) => [section.id, section]));
  const hasIncoming = new Set(sections.flatMap((section) => section.incomingSections ?? []));
  const head = sections.find((section) => !hasIncoming.has(section.id));
  if (head === undefined) return sections;
  const ordered: ElkSection[] = [];
  const seen = new Set<string>();
  let current: ElkSection | undefined = head;
  while (current !== undefined && !seen.has(current.id)) {
    ordered.push(current);
    seen.add(current.id);
    const nextId: string | undefined = (current.outgoingSections ?? [])[0];
    current = nextId === undefined ? undefined : byId.get(nextId);
  }
  return ordered.length === sections.length ? ordered : sections;
}

/**
 * Absolute polyline of one routed edge.
 *
 * Sections are stitched head-to-tail and offset by the container's origin.
 */
export function edgePolyline(edge: ElkResultEdge, origin: Rect): Point[] {
  const points: Point[] = [];
  for (const section of orderedSections(edge.sections ?? [])) {
    points.push({ x: origin.x + section.startPoint.x, y: origin.y + section.startPoint.y });
    for (const bend of section.bendPoints ?? []) points.push({ x: origin.x + bend.x, y: origin.y + bend.y });
    points.push({ x: origin.x + section.endPoint.x, y: origin.y + section.endPoint.y });
  }
  return points;
}
