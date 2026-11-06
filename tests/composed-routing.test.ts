import { describe, expect, test } from "bun:test";

import { layoutDiagram } from "../src/diagram/layout";
import { theme } from "../src/diagram/theme";
import type {
  DiagramSpec,
  MeasureText,
  Point,
  Rect,
  Scene,
  SceneEdge,
  SceneGroup,
  SceneNode,
  Side,
} from "../src/diagram/types";

/**
 * Behavioural tests for the composed layout path.
 *
 * A script with two or more top-level panels is composed panel by panel instead
 * of in one graph run, so it needs its own guarantees: panels read as aligned
 * tables, connectors meet the icon a reader actually sees, explicit sides are
 * honoured, short wires take the short way, and labels stay off text.
 *
 * Every fixture is deliberately tiny and every assertion relates published
 * scene rectangles (icon cards, footprints, rotated panel headings) to each
 * other. No internal helper is called and no exact coordinate is pinned, so a
 * better router may move geometry freely — but it may not put a wire on a
 * caption or leave a self loop folded onto itself.
 */

/** Deterministic stand-in for canvas measurement: wide glyphs cost more. */
const measure: MeasureText = (text, font) => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 12);
  let units = 0;
  for (const character of text) {
    if (character === " ") units += 0.3;
    else if (/[A-Z]/.test(character)) units += 0.72;
    else units += 0.55;
  }
  return units * size;
};

/** Font the renderer paints panel headings in; the layout measures with it too. */
const GROUP_FONT = `bold ${theme.groupSize}px ${theme.fontFamily}`;

/**
 * Distance a connector endpoint may sit from the border it claims to touch.
 *
 * A pixel, not an exact value: every emitted coordinate is rounded to
 * hundredths from differently-derived intermediates, so demanding bit equality
 * would fail correct geometry for arithmetic reasons.
 */
const TOUCH_SLACK = 1;

const spec = (partial: Partial<DiagramSpec> & Pick<DiagramSpec, "nodes">): DiagramSpec => ({
  edges: [],
  ...partial,
});

function nodeById(scene: Scene, id: string): SceneNode {
  const node = scene.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`test: node "${id}" missing from scene`);
  return node;
}

function edgeById(scene: Scene, id: string): SceneEdge {
  const edge = scene.edges.find((candidate) => candidate.id === id);
  if (edge === undefined) throw new Error(`test: edge "${id}" missing from scene`);
  return edge;
}

/** Two rectangles overlap when they share interior area; touching borders do not. */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Area swept when a polyline is closed back onto itself (shoelace formula). */
function polygonArea(points: Point[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    total += current.x * next.y - next.x * current.y;
  }
  return Math.abs(total) / 2;
}

/** True when a point sits on a rectangle's border, whatever the side. */
function touchesBorder(point: Point, box: Rect, slack = TOUCH_SLACK): boolean {
  const onVertical =
    (Math.abs(point.x - box.x) <= slack || Math.abs(point.x - (box.x + box.width)) <= slack) &&
    point.y >= box.y - slack &&
    point.y <= box.y + box.height + slack;
  const onHorizontal =
    (Math.abs(point.y - box.y) <= slack || Math.abs(point.y - (box.y + box.height)) <= slack) &&
    point.x >= box.x - slack &&
    point.x <= box.x + box.width + slack;
  return onVertical || onHorizontal;
}

/** True when a point sits on the requested side of the node's visible box. */
function pointOnSide(point: Point, node: SceneNode, side: Side, slack = TOUCH_SLACK): boolean {
  const box = node.card ?? node;
  const withinX = point.x >= box.x - slack && point.x <= box.x + box.width + slack;
  const withinY = point.y >= box.y - slack && point.y <= box.y + box.height + slack;
  switch (side) {
    case "east":
      return Math.abs(point.x - (box.x + box.width)) <= slack && withinY;
    case "west":
      return Math.abs(point.x - box.x) <= slack && withinY;
    case "south":
      return Math.abs(point.y - (box.y + box.height)) <= slack && withinX;
    case "north":
      return Math.abs(point.y - box.y) <= slack && withinX;
  }
}

/** True when a rectangle is fully inside the canvas. */
function insideScene(scene: Scene, rect: Rect): boolean {
  return (
    rect.x >= -TOUCH_SLACK &&
    rect.y >= -TOUCH_SLACK &&
    rect.x + rect.width <= scene.width + TOUCH_SLACK &&
    rect.y + rect.height <= scene.height + TOUCH_SLACK
  );
}

/**
 * Rectangle a panel heading paints in.
 *
 * `src/diagram/svg.ts` draws it at `group.x + 16` with the text baseline at
 * `group.y + 24`, in the group font. A connector label drawn there is as
 * unreadable as one drawn over a card, and no node or group rectangle exposes
 * the collision, so the box follows the painting contract.
 */
const GROUP_LABEL_OFFSET_X = 16;
const GROUP_LABEL_BASELINE_Y = 24;

function headingRect(group: SceneGroup): Rect {
  const ascent = theme.groupSize;
  const descent = Math.ceil(theme.groupSize * 0.3);
  return {
    x: group.x + GROUP_LABEL_OFFSET_X,
    y: group.y + GROUP_LABEL_BASELINE_Y - ascent,
    width: measure(group.label, GROUP_FONT),
    height: ascent + descent,
  };
}

/** Assert two coordinates coincide within the rounding slack. */
function expectNear(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(TOUCH_SLACK);
}

describe("layoutDiagram: composed panels align their icon columns", () => {
  test("centres each icon in its cell so columns line up despite unequal captions", async () => {
    const scene = await layoutDiagram(
      spec({
        direction: "right",
        groups: [
          { id: "services", label: "Services", direction: "down", columns: 2 },
          { id: "support", label: "Support", direction: "down" },
        ],
        nodes: [
          { id: "s1", label: "A", icon: "redis", group: "services" },
          { id: "s2", label: "A considerably longer service caption", icon: "hono", group: "services" },
          { id: "s3", label: "B", icon: "github", group: "services" },
          { id: "s4", label: "Another quite long service caption", icon: "postgresql", group: "services" },
          { id: "helper", label: "Helper", icon: "redis", group: "support" },
        ],
        edges: [{ id: "s1-helper", from: "s1", to: "helper" }],
      }),
      measure,
    );

    // The panel is a two-column table whose cells are widened to the longest
    // caption. The caption is painted centred on the cell, so the icon must be
    // centred on the cell too: an icon hugging the left edge of a widened cell
    // sits off-centre above its own caption and breaks the column.
    const cells = ["s1", "s2", "s3", "s4"].map((id) => nodeById(scene, id));
    for (const node of cells) {
      expect(node.card, `${node.id} is a service with an icon card`).toBeDefined();
      const card = node.card!;
      expectNear(card.x + card.width / 2, node.x + node.width / 2, `${node.id} icon centre in cell`);
    }

    const [topLeft, topRight, bottomLeft, bottomRight] = cells.map((node) => ({
      x: node.card!.x + node.card!.width / 2,
      y: node.card!.y + node.card!.height / 2,
    }));
    // Reading a panel means seeing straight lines: each column shares one x and
    // each row shares one y, no matter how different the captions are.
    expectNear(topLeft.x, bottomLeft.x, "left column icon centres");
    expectNear(topRight.x, bottomRight.x, "right column icon centres");
    expectNear(topLeft.y, topRight.y, "top row icon centres");
    expectNear(bottomLeft.y, bottomRight.y, "bottom row icon centres");
    // And the grid really has two columns, not one stretched column.
    expect(Math.abs(topLeft.x - topRight.x), "column separation").toBeGreaterThan(theme.cardSize);
  });
});

describe("layoutDiagram: composed connectors meet the visible icon", () => {
  test("a horizontal connector inside a panel attaches to the icon card sides, not the caption box", async () => {
    const scene = await layoutDiagram(
      spec({
        direction: "right",
        groups: [
          { id: "row", label: "Services", direction: "right" },
          { id: "far", label: "Far", direction: "down" },
        ],
        nodes: [
          { id: "caller", label: "Caller", subtitle: "sends it", icon: "redis", group: "row" },
          { id: "callee", label: "A much longer callee caption", subtitle: "receives it", icon: "hono", group: "row" },
          { id: "away", label: "Away", icon: "github", group: "far" },
        ],
        edges: [{ id: "call", from: "caller", to: "callee" }],
      }),
      measure,
    );

    const from = nodeById(scene, "caller");
    const to = nodeById(scene, "callee");
    const fromCard = from.card!;
    const toCard = to.card!;
    // The fixture only means something if card and footprint differ: the caption
    // is wider than the icon, so a footprint-pinned endpoint stops beside the
    // caption and a card-pinned one touches the symbol.
    expect(fromCard.width, "caption widens the footprint").toBeLessThan(from.width);

    const edge = edgeById(scene, "call");
    const start = edge.points[0];
    const end = edge.points[edge.points.length - 1];

    // Direct neighbours in one row must meet the visible icon at its side
    // centres: a wire that stops at a caption's edge visibly floats beside the
    // symbol, and one that runs at caption height slices through the text.
    expectNear(start.x, fromCard.x + fromCard.width, "start on the icon's east side");
    expectNear(start.y, fromCard.y + fromCard.height / 2, "start at icon centre height");
    expectNear(end.x, toCard.x, "end on the icon's west side");
    expectNear(end.y, toCard.y + toCard.height / 2, "end at icon centre height");
    // The footprint centre is measurably below the icon centre here, so the
    // height assertions cannot both hold for a caption-level attachment.
    expect(from.y + from.height / 2 - (fromCard.y + fromCard.height / 2)).toBeGreaterThan(4);
  });

  test("a horizontal connector across panels attaches at the icon side centres", async () => {
    const scene = await layoutDiagram(
      spec({
        direction: "right",
        groups: [
          { id: "west", label: "West", direction: "down" },
          { id: "east", label: "East", direction: "down" },
        ],
        nodes: [
          { id: "a", label: "A", icon: "redis", group: "west" },
          { id: "b", label: "B", icon: "hono", group: "east" },
        ],
        edges: [{ id: "flow", from: "a", to: "b" }],
      }),
      measure,
    );

    const from = nodeById(scene, "a");
    const to = nodeById(scene, "b");
    const fromCard = from.card!;
    const toCard = to.card!;
    // The caption makes each footprint taller than its icon, so an endpoint at
    // footprint-centre height lands below the visible symbol.
    expect(from.height, "caption extends the footprint").toBeGreaterThan(fromCard.height + 8);

    const edge = edgeById(scene, "flow");
    const start = edge.points[0];
    const end = edge.points[edge.points.length - 1];

    expectNear(start.x, fromCard.x + fromCard.width, "start on the icon's east side");
    expectNear(start.y, fromCard.y + fromCard.height / 2, "start at icon centre height");
    expectNear(end.x, toCard.x, "end on the icon's west side");
    expectNear(end.y, toCard.y + toCard.height / 2, "end at icon centre height");
  });
});

describe("layoutDiagram: composed connectors honour explicit sides", () => {
  test("keeps authored fromSide/toSide inside a panel and across panel borders", async () => {
    const scene = await layoutDiagram(
      spec({
        direction: "right",
        groups: [
          { id: "stack", label: "Stack", direction: "down" },
          { id: "pair", label: "Pair", direction: "down" },
        ],
        nodes: [
          { id: "top", label: "Top", shape: "process", group: "stack" },
          { id: "bottom", label: "Bottom", shape: "process", group: "stack" },
          { id: "below", label: "Below", shape: "process", group: "pair" },
        ],
        edges: [
          // Same-panel edge authored to leave and re-enter on the east side.
          { id: "inside", from: "top", to: "bottom", fromSide: "east", toSide: "east" },
          // Cross-panel edge authored top-to-bottom while the panels sit side by
          // side, so honouring it costs a deliberate detour.
          { id: "cross", from: "top", to: "below", fromSide: "south", toSide: "north" },
        ],
      }),
      measure,
    );

    const cases: Array<{ id: string; from: string; to: string; fromSide: Side; toSide: Side }> = [
      { id: "inside", from: "top", to: "bottom", fromSide: "east", toSide: "east" },
      { id: "cross", from: "top", to: "below", fromSide: "south", toSide: "north" },
    ];

    for (const entry of cases) {
      const from = nodeById(scene, entry.from);
      const to = nodeById(scene, entry.to);
      // Body shapes have no icon card, so "side" can only mean the visible
      // border and no card-versus-footprint reading is possible.
      expect(from.card, `${entry.from} is a body shape`).toBeUndefined();
      expect(to.card, `${entry.to} is a body shape`).toBeUndefined();

      const edge = edgeById(scene, entry.id);
      const start = edge.points[0];
      const end = edge.points[edge.points.length - 1];

      expect(pointOnSide(start, from, entry.fromSide), `${entry.id} leaves on ${entry.fromSide}`).toBe(true);
      expect(pointOnSide(end, to, entry.toSide), `${entry.id} enters on ${entry.toSide}`).toBe(true);
    }
  });
});

describe("layoutDiagram: composed connectors take the short way", () => {
  test("a short unobstructed connection does not detour around the panels", async () => {
    const scene = await layoutDiagram(
      spec({
        direction: "right",
        groups: [
          { id: "tall", label: "Tall", direction: "down" },
          { id: "short", label: "Short", direction: "down" },
        ],
        nodes: [
          { id: "a0", label: "A0", icon: "redis", group: "tall" },
          { id: "a1", label: "A1", icon: "redis", group: "tall" },
          { id: "a2", label: "A2", icon: "redis", group: "tall" },
          { id: "b0", label: "B0", icon: "hono", group: "short" },
          { id: "b1", label: "B1", icon: "hono", group: "short" },
        ],
        // The source sits below the target with empty gutter between the two
        // panels, so the wire can simply rise through that gutter. Circling the
        // tall panel and entering from above is the failure this guards.
        edges: [{ id: "call", from: "a2", to: "b0", label: "call" }],
      }),
      measure,
    );

    const source = nodeById(scene, "a2");
    const target = nodeById(scene, "b0");
    const edge = edgeById(scene, "call");
    const start = edge.points[0];
    const end = edge.points[edge.points.length - 1];

    // Measured against the endpoints the router itself chose, so any legitimate
    // side choice is accepted: only wasted travel is penalised.
    const direct = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
    let length = 0;
    for (let index = 1; index < edge.points.length; index += 1) {
      length +=
        Math.abs(edge.points[index].x - edge.points[index - 1].x) +
        Math.abs(edge.points[index].y - edge.points[index - 1].y);
    }

    // One node gap of slack covers stepping clear of both cards and turning;
    // a route that circles a panel costs several times as much.
    expect(length, `wire length ${length} against a direct ${direct}`).toBeLessThanOrEqual(direct + 48);
    expect(touchesBorder(start, source.card ?? source), "wire starts on the visible source").toBe(true);
    expect(touchesBorder(end, target.card ?? target), "wire ends on the visible target").toBe(true);

    // And the detour it should not take leaves the composition: every point
    // stays inside the canvas and inside the panels' shared extent.
    const left = Math.min(...scene.groups.map((group) => group.x));
    const top = Math.min(...scene.groups.map((group) => group.y));
    const right = Math.max(...scene.groups.map((group) => group.x + group.width));
    const bottom = Math.max(...scene.groups.map((group) => group.y + group.height));
    for (const point of edge.points) {
      expect(insideScene(scene, { ...point, width: 0, height: 0 }), `point ${JSON.stringify(point)} on canvas`).toBe(
        true,
      );
      expect(point.x, `x of ${JSON.stringify(point)} within the panels`).toBeGreaterThanOrEqual(left - TOUCH_SLACK);
      expect(point.y, `y of ${JSON.stringify(point)} within the panels`).toBeGreaterThanOrEqual(top - TOUCH_SLACK);
      expect(point.x, `x of ${JSON.stringify(point)} within the panels`).toBeLessThanOrEqual(right + TOUCH_SLACK);
      expect(point.y, `y of ${JSON.stringify(point)} within the panels`).toBeLessThanOrEqual(bottom + TOUCH_SLACK);
    }
  });
});

describe("layoutDiagram: composed self loops and parallel connectors", () => {
  test("a self loop has real extent, stays on canvas and attaches to its node", async () => {
    const scene = await layoutDiagram(
      spec({
        direction: "right",
        groups: [
          { id: "core", label: "Core", direction: "down" },
          { id: "edge", label: "Edge", direction: "down" },
        ],
        nodes: [
          { id: "alpha", label: "Alpha", icon: "redis", group: "core" },
          { id: "gamma", label: "Gamma", icon: "github", group: "edge" },
        ],
        edges: [
          { id: "loop", from: "alpha", to: "alpha", label: "retry" },
          { id: "out", from: "alpha", to: "gamma" },
        ],
      }),
      measure,
    );

    const node = nodeById(scene, "alpha");
    const loop = edgeById(scene, "loop");

    // A loop that leaves and returns along the same pixels is a stub a reader
    // cannot see, and its label has nowhere to sit but off-canvas.
    const distinct = new Set(loop.points.map((point) => `${point.x},${point.y}`));
    expect(distinct.size, "distinct loop points").toBeGreaterThanOrEqual(3);
    const xs = loop.points.map((point) => point.x);
    const ys = loop.points.map((point) => point.y);
    expect(Math.max(...xs) - Math.min(...xs), "loop width").toBeGreaterThanOrEqual(12);
    expect(Math.max(...ys) - Math.min(...ys), "loop height").toBeGreaterThanOrEqual(12);
    expect(polygonArea(loop.points), "loop encloses area").toBeGreaterThan(0);

    expect(touchesBorder(loop.points[0], node.card ?? node), "loop starts on its node").toBe(true);
    expect(touchesBorder(loop.points[loop.points.length - 1], node.card ?? node), "loop ends on its node").toBe(true);
    for (const point of loop.points) {
      expect(insideScene(scene, { ...point, width: 0, height: 0 }), `loop point ${JSON.stringify(point)}`).toBe(true);
    }

    expect(loop.label, "self loop has a label box").toBeDefined();
    expect(insideScene(scene, loop.label!), "label inside the canvas").toBe(true);
    for (const other of scene.nodes) {
      expect(overlaps(loop.label!, other), `label clear of ${other.id}`).toBe(false);
    }
  });

  test("parallel connectors keep separate routes and separate labels inside and across panels", async () => {
    const scene = await layoutDiagram(
      spec({
        direction: "right",
        groups: [
          { id: "core", label: "Core", direction: "down" },
          { id: "edge", label: "Edge", direction: "down" },
        ],
        nodes: [
          { id: "alpha", label: "Alpha", icon: "redis", group: "core" },
          { id: "beta", label: "Beta", icon: "hono", group: "core" },
          { id: "gamma", label: "Gamma", icon: "github", group: "edge" },
        ],
        edges: [
          { id: "inner-one", from: "alpha", to: "beta", label: "first" },
          { id: "inner-two", from: "alpha", to: "beta", label: "second" },
          { id: "outer-one", from: "alpha", to: "gamma", label: "out one" },
          { id: "outer-two", from: "alpha", to: "gamma", label: "out two" },
        ],
      }),
      measure,
    );

    const pairs: Array<{ from: string; to: string; first: string; second: string }> = [
      // Both ends inside one panel: the panel draws these routes itself.
      { from: "alpha", to: "beta", first: "inner-one", second: "inner-two" },
      // Ends in different panels: the composition routes these across the gutter.
      { from: "alpha", to: "gamma", first: "outer-one", second: "outer-two" },
    ];

    for (const pair of pairs) {
      const from = nodeById(scene, pair.from);
      const to = nodeById(scene, pair.to);
      const first = edgeById(scene, pair.first);
      const second = edgeById(scene, pair.second);

      // Two connectors painted on the same polyline read as one wire, which is
      // the classic composed-mode collapse.
      expect(JSON.stringify(first.points), `${pair.first} and ${pair.second} differ`).not.toBe(
        JSON.stringify(second.points),
      );

      expect(first.label, `${pair.first} has a label box`).toBeDefined();
      expect(second.label, `${pair.second} has a label box`).toBeDefined();
      expect(overlaps(first.label!, second.label!), `${pair.first} label clear of ${pair.second}`).toBe(false);

      for (const edge of [first, second]) {
        expect(touchesBorder(edge.points[0], from.card ?? from), `${edge.id} starts on ${pair.from}`).toBe(true);
        expect(touchesBorder(edge.points[edge.points.length - 1], to.card ?? to), `${edge.id} ends on ${pair.to}`).toBe(true);
      }
    }
  });
});

describe("layoutDiagram: composed connector labels keep clear", () => {
  test("no label covers a node footprint or a panel heading", async () => {
    const scene = await layoutDiagram(
      spec({
        direction: "right",
        groups: [
          { id: "one", label: "Panel one heading text", direction: "down", columns: 2 },
          { id: "two", label: "Panel two heading text", direction: "down", columns: 2 },
        ],
        nodes: [
          ...Array.from({ length: 3 }, (_, index) => ({ id: `a${index}`, label: "A", icon: "redis", group: "one" })),
          ...Array.from({ length: 3 }, (_, index) => ({ id: `b${index}`, label: "B", icon: "hono", group: "two" })),
        ],
        edges: [
          ...Array.from({ length: 3 }, (_, index) => ({
            id: `a${index}-b${index}`,
            from: `a${index}`,
            to: `b${index}`,
            label: "a connector label",
          })),
          // A return wire across the gutter: its label is slid along the route
          // rather than placed by the panel that owns it.
          { id: "topcross", from: "b0", to: "a2", label: "long label crossing the top channel" },
        ],
      }),
      measure,
    );

    const labelled = scene.edges.filter((edge) => edge.label !== undefined);
    expect(labelled.length, "fixture has labelled connectors").toBeGreaterThan(0);
    // Both panels contribute a heading, so a label pushed into the shared
    // heading band is caught whichever side it drifts to.
    expect(scene.groups.map((group) => group.id)).toEqual(["one", "two"]);

    for (const edge of labelled) {
      const label = edge.label!;
      expect(insideScene(scene, label), `${edge.id} label inside the canvas`).toBe(true);

      for (const node of scene.nodes) {
        // The whole footprint is an obstacle: a label resting on a caption is as
        // unreadable as one resting on the icon.
        expect(overlaps(label, node), `${edge.id} label clear of node ${node.id}`).toBe(false);
      }
      for (const group of scene.groups) {
        expect(overlaps(label, headingRect(group)), `${edge.id} label clear of heading ${group.id}`).toBe(false);
      }
    }
  });
});
