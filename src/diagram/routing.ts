import type { EdgeKind, Point, Rect, SceneEdge, SceneGroup, SceneNode, Side } from "./types";

/** Validated connector fields needed by the geometry router. */
export interface WireSpec {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  fromSide?: Side;
  toSide?: Side;
}

const CLEARANCE = 10;
const BEND_COST = 24;
const SIDES: Side[] = ["east", "west", "north", "south"];
const NORMAL: Record<Side, Point> = {
  east: { x: 1, y: 0 }, west: { x: -1, y: 0 },
  north: { x: 0, y: -1 }, south: { x: 0, y: 1 },
};
interface Port { points: Point[]; axis: number; cost: number }
interface Segment { a: Point; b: Point }
interface QueueEntry { state: number; cost: number; rank: number }

/** Min-heap for A*: equal scores retain deterministic state order. */
class Queue {
  private entries: QueueEntry[] = [];
  private less(a: QueueEntry, b: QueueEntry): boolean {
    return a.rank < b.rank || (a.rank === b.rank && a.state < b.state);
  }
  push(entry: QueueEntry): void {
    let at = this.entries.length;
    this.entries.push(entry);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!this.less(entry, this.entries[parent])) break;
      this.entries[at] = this.entries[parent];
      at = parent;
    }
    this.entries[at] = entry;
  }
  pop(): QueueEntry | undefined {
    const first = this.entries[0];
    const last = this.entries.pop();
    if (last === undefined || this.entries.length === 0) return first;
    let at = 0;
    while (at * 2 + 1 < this.entries.length) {
      let child = at * 2 + 1;
      if (child + 1 < this.entries.length && this.less(this.entries[child + 1], this.entries[child])) child += 1;
      if (!this.less(this.entries[child], last)) break;
      this.entries[at] = this.entries[child];
      at = child;
    }
    this.entries[at] = last;
    return first;
  }
}

/** Manhattan length in scene pixels. */
function distance(a: Point, b: Point): number { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }

/** Exact interior intersection; travelling along an obstacle boundary is legal. */
function intersects(a: Point, b: Point, r: Rect): boolean {
  if (a.y === b.y) return a.y > r.y + 0.01 && a.y < r.y + r.height - 0.01 && Math.max(a.x, b.x) > r.x + 0.01 && Math.min(a.x, b.x) < r.x + r.width - 0.01;
  return a.x > r.x + 0.01 && a.x < r.x + r.width - 0.01 && Math.max(a.y, b.y) > r.y + 0.01 && Math.min(a.y, b.y) < r.y + r.height - 0.01;
}

/** Expand footprints so a wire never hugs a caption or card border. */
function expand(r: Rect, gap: number): Rect {
  return { x: r.x - gap, y: r.y - gap, width: r.width + gap * 2, height: r.height + gap * 2 };
}

/** Drop duplicates and merge straight runs without changing any route segment. */
function simplify(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const p of points) {
    const a = result.at(-1);
    if (a && distance(a, p) < 0.01) continue;
    const b = result.at(-2);
    if (a && b && ((a.x === b.x && p.x === a.x) || (a.y === b.y && p.y === a.y))) result.pop();
    result.push(p);
  }
  return result;
}

/**
 * Candidate visible ports and their caption-safe escape stubs.
 *
 * East/west use the icon centre, not the footprint centre. A service's south
 * port first turns in the gap above its caption, so the wire touches the icon
 * without drawing through its text. Explicit sides limit the candidates.
 */
function ports(node: SceneNode, toward: SceneNode, side: Side | undefined, offset: number, used: Point[]): Port[] {
  const r = node.card ?? node;
  const dx = toward.x + toward.width / 2 - r.x - r.width / 2;
  const dy = toward.y + (toward.card?.height ?? toward.height) / 2 - r.y - r.height / 2;
  const limit = Math.min(r.width, r.height) / 4;
  const shifts = [...new Set([offset, offset - 12, offset + 12].map(value =>
    Math.max(-limit, Math.min(limit, value))))];
  return (side ? [side] : SIDES.filter(s => !(node.card && s === "south"))).flatMap(s => shifts.map(shift => {
    const n = NORMAL[s];
    const vertical = n.y !== 0;
    const p = { x: r.x + r.width / 2 + n.x * r.width / 2 + (vertical ? shift : 0), y: r.y + r.height / 2 + n.y * r.height / 2 + (vertical ? 0 : shift) };
    let path: Point[];
    if (s === "south" && node.card) {
      path = [p, { x: p.x, y: p.y + 4 }, { x: node.x + node.width + CLEARANCE, y: p.y + 4 }];
    } else {
      const gate = s === "east" ? { x: node.x + node.width + CLEARANCE, y: p.y }
        : s === "west" ? { x: node.x - CLEARANCE, y: p.y }
        : s === "north" ? { x: p.x, y: node.y - CLEARANCE }
        : { x: p.x, y: node.y + node.height + CLEARANCE };
      path = [p, gate];
    }
    const facing = n.x * dx + n.y * dy;
    // Wrong-facing ports cost two bends. Twelve-pixel slots leave room for
    // arrowheads; occupancy outweighs saving a few pixels of wire. The smaller
    // offset bias keeps unused ports centred without forcing a long detour.
    const occupied = used.reduce((sum, point) => sum + Math.max(0, 12 - distance(point, p)) * 12, 0);
    const cost = path.slice(1).reduce((sum, p, i) => sum + distance(path[i], p), 0) +
      (facing < 0 ? BEND_COST * 2 : 0) + Math.abs(shift - offset) * 0.3 + occupied;
    return { points: path, axis: path.at(-1)!.y === path.at(-2)!.y ? 0 : 1, cost };
  }));
}

/** Penalty for sharing wire pixels or crossing a previous connector. */
function congestion(a: Point, b: Point, segments: Segment[]): number {
  let cost = 0;
  const horizontal = a.y === b.y;
  for (const s of segments) {
    const otherHorizontal = s.a.y === s.b.y;
    if (horizontal === otherHorizontal) {
      const separation = horizontal ? Math.abs(a.y - s.a.y) : Math.abs(a.x - s.a.x);
      if (separation >= 7) continue;
      const lo = horizontal ? Math.max(Math.min(a.x, b.x), Math.min(s.a.x, s.b.x)) : Math.max(Math.min(a.y, b.y), Math.min(s.a.y, s.b.y));
      const hi = horizontal ? Math.min(Math.max(a.x, b.x), Math.max(s.a.x, s.b.x)) : Math.min(Math.max(a.y, b.y), Math.max(s.a.y, s.b.y));
      cost += Math.max(0, hi - lo) * (separation < 1 ? 2 : 0.5);
    } else {
      const h = horizontal ? { a, b } : s;
      const v = horizontal ? s : { a, b };
      if (v.a.x > Math.min(h.a.x, h.b.x) && v.a.x < Math.max(h.a.x, h.b.x) && h.a.y > Math.min(v.a.y, v.b.y) && h.a.y < Math.max(v.a.y, v.b.y)) cost += 18;
    }
  }
  return cost;
}

/**
 * Multi-source, multi-target A* on adjacent visibility-grid intersections.
 *
 * The state includes incoming axis: a bend has a real cost, and a thousand-pixel
 * jump is never treated as equivalent to a ten-pixel step. Goal costs include
 * the final port stub. No unchecked through-obstacle fallback is returned.
 */
function shortestRoute(starts: Port[], ends: Port[], obstacles: Rect[], previous: Segment[]): Point[] {
  const unique = (values: number[]) => [...new Set(values.map(v => Math.round(v * 100) / 100))].sort((a, b) => a - b);
  const gates = [...starts, ...ends].map(p => p.points.at(-1)!);
  const xs = unique([...gates.map(p => p.x), ...obstacles.flatMap(r => [r.x, r.x + r.width]), ...previous.filter(s => s.a.x === s.b.x).flatMap(s => [s.a.x - 8, s.a.x + 8])]);
  const ys = unique([...gates.map(p => p.y), ...obstacles.flatMap(r => [r.y, r.y + r.height]), ...previous.filter(s => s.a.y === s.b.y).flatMap(s => [s.a.y - 8, s.a.y + 8])]);
  const nx = xs.length;
  const count = nx * ys.length * 2;
  const costs = new Float64Array(count).fill(Infinity);
  const parent = new Int32Array(count).fill(-1);
  const startPort = new Int32Array(count).fill(-1);
  const queue = new Queue();
  const point = (state: number): Point => { const cell = state >> 1; return { x: xs[cell % nx], y: ys[Math.floor(cell / nx)] }; };
  const cellOf = (p: Point) => ys.indexOf(Math.round(p.y * 100) / 100) * nx + xs.indexOf(Math.round(p.x * 100) / 100);
  const goals = new Map<number, number[]>();
  for (let i = 0; i < ends.length; i++) {
    const cell = cellOf(ends[i].points.at(-1)!);
    goals.set(cell, [...(goals.get(cell) ?? []), i]);
  }
  const heuristic = (p: Point): number => Math.min(...ends.map(e => distance(p, e.points.at(-1)!) + e.cost));
  const blocked = (p: Point) => obstacles.some(r => p.x > r.x + 0.01 && p.x < r.x + r.width - 0.01 && p.y > r.y + 0.01 && p.y < r.y + r.height - 0.01);
  for (let i = 0; i < starts.length; i++) {
    const port = starts[i], p = port.points.at(-1)!;
    if (blocked(p)) continue;
    const state = cellOf(p) * 2 + port.axis;
    if (port.cost >= costs[state]) continue;
    costs[state] = port.cost; startPort[state] = i;
    queue.push({ state, cost: port.cost, rank: port.cost + heuristic(p) });
  }
  let bestCost = Infinity, bestState = -1, bestEnd = -1;
  let current: QueueEntry | undefined;
  while ((current = queue.pop()) !== undefined) {
    if (current.rank >= bestCost) break;
    const { state, cost } = current;
    if (cost > costs[state]) continue;
    const cell = state >> 1, xi = cell % nx, yi = Math.floor(cell / nx), p = point(state);
    for (const endIndex of goals.get(cell) ?? []) {
      const end = ends[endIndex];
      const total = cost + end.cost + ((state & 1) === end.axis ? 0 : BEND_COST);
      if (total < bestCost) { bestCost = total; bestState = state; bestEnd = endIndex; }
    }
    const neighbors: Array<[number, number]> = [];
    if (xi > 0) neighbors.push([cell - 1, 0]);
    if (xi + 1 < nx) neighbors.push([cell + 1, 0]);
    if (yi > 0) neighbors.push([cell - nx, 1]);
    if (yi + 1 < ys.length) neighbors.push([cell + nx, 1]);
    for (const [nextCell, axis] of neighbors) {
      const next = nextCell * 2 + axis, q = point(next);
      if (blocked(q) || obstacles.some(r => intersects(p, q, r))) continue;
      const nextCost = cost + distance(p, q) + (axis === (state & 1) ? 0 : BEND_COST) + congestion(p, q, previous);
      if (nextCost >= costs[next]) continue;
      costs[next] = nextCost; parent[next] = state; startPort[next] = startPort[state];
      queue.push({ state: next, cost: nextCost, rank: nextCost + heuristic(q) });
    }
  }
  if (bestState < 0) throw new Error("No caption-safe connector route between the selected ports");
  const path: Point[] = [];
  for (let at = bestState; at >= 0; at = parent[at]) path.push(point(at));
  path.reverse();
  return simplify([...starts[startPort[bestState]].points, ...path, ...ends[bestEnd].points.toReversed()]);
}

/**
 * Route a composed scene after all placement is final. Wires attach to visible
 * shapes; captions, headings and unrelated panels remain hard obstacles. Main
 * flow reserves its short routes first, then secondary/async wires use free
 * lanes. Results retain input order. Input scenes are never mutated.
 */
export function routeWires(nodes: SceneNode[], groups: SceneGroup[], edges: WireSpec[], flow: readonly string[], headings: Rect[]): SceneEdge[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const groupById = new Map(groups.map(g => [g.id, g]));
  const ancestry = (n: SceneNode): Set<string> => {
    const result = new Set<string>();
    for (let id = n.parent; id !== undefined; id = groupById.get(id)?.parent) result.add(id);
    return result;
  };
  const isFlow = (e: WireSpec) => flow.some((id, i) => i > 0 && id === e.to && flow[i - 1] === e.from);
  const priority = (e: WireSpec) => isFlow(e) ? 0 : e.kind === "primary" ? 1 : e.kind === "secondary" ? 2 : 3;
  const ordered = edges.map((edge, index) => ({ edge, index })).sort((a, b) => priority(a.edge) - priority(b.edge) || a.index - b.index);
  const segments: Segment[] = [];
  const usedPorts = new Map<string, Point[]>();
  const result = new Map<string, SceneEdge>();
  for (const { edge } of ordered) {
    const from = byId.get(edge.from)!, to = byId.get(edge.to)!;
    const allowed = new Set([...ancestry(from), ...ancestry(to)]);
    const obstacles = [
      ...nodes.map(n => expand(n, CLEARANCE)),
      ...groups.filter(g => !allowed.has(g.id)).map(g => expand(g, CLEARANCE)),
      ...headings.map(r => expand(r, 4)),
    ];
    const parallel = edges.filter(e => e.from === edge.from && e.to === edge.to);
    const offset = (parallel.indexOf(edge) - (parallel.length - 1) / 2) * 10;
    let fromSide = edge.fromSide, toSide = edge.toSide;
    if (from === to) { fromSide ??= "east"; toSide ??= fromSide === "north" ? "west" : "north"; }
    const starts = ports(from, to, fromSide, offset, usedPorts.get(from.id) ?? []);
    const ends = ports(to, from, toSide, offset, usedPorts.get(to.id) ?? []);
    // Only this wire's own stubs may enter its endpoint footprint. Every other
    // shape and every unrelated heading must also clear the escape segment.
    const freeStubs = (ports: Port[], own: SceneNode) => ports.filter(port => port.points.slice(1).every((p, i) =>
      nodes.every(n => n === own || !intersects(port.points[i], p, expand(n, 2))) &&
      groups.every(g => allowed.has(g.id) || !intersects(port.points[i], p, expand(g, 2))) &&
      headings.every(r => !intersects(port.points[i], p, r)),
    ));
    const points = shortestRoute(freeStubs(starts, from), freeStubs(ends, to), obstacles, segments);
    result.set(edge.id, { id: edge.id, source: edge.from, target: edge.to, kind: edge.kind, points });
    const fromPorts = usedPorts.get(from.id) ?? [];
    fromPorts.push(points[0]);
    usedPorts.set(from.id, fromPorts);
    const toPorts = usedPorts.get(to.id) ?? [];
    toPorts.push(points.at(-1)!);
    usedPorts.set(to.id, toPorts);
    for (let i = 1; i < points.length; i++) segments.push({ a: points[i - 1], b: points[i] });
  }
  return edges.map(e => result.get(e.id)!);
}
