import { describe, expect, test } from "bun:test";

import { placePanels } from "../src/diagram/placement";
import type { PlacementEdge, PlacementGroup, PlacementNode } from "../src/diagram/placement";
import type { Direction, Rect } from "../src/diagram/types";

/**
 * Behavioural tests for measured placement.
 *
 * Placement answers one question: given measured card footprints, measured panel
 * headings and a declared structure, where does everything sit? The properties
 * that matter are relational — rows share a top edge, cells share a pitch,
 * nested panels keep their own size, flow members line up across panels, and no
 * rectangle swallows another. No exact coordinate is pinned, so the composition
 * stays free to change while those relationships hold.
 */

/** Gutter the module guarantees inside a panel and between panels. */
const MIN_INSIDE_GAP = 36;
const MIN_PANEL_GAP = 48;

const group = (id: string, overrides: Partial<PlacementGroup> = {}): PlacementGroup => ({
  id,
  labelWidth: 60,
  ...overrides,
});

const node = (id: string, overrides: Partial<PlacementNode> = {}): PlacementNode => ({
  id,
  width: 100,
  height: 100,
  order: 0,
  ...overrides,
});

/** Build nodes with sequential declaration order, optionally inside one panel. */
const nodesIn = (
  groupId: string | undefined,
  entries: Array<[id: string, width?: number, height?: number]>,
): PlacementNode[] =>
  entries.map(([id, width = 100, height = 100], index) =>
    node(id, { group: groupId, width, height, order: index }),
  );

const edge = (from: string, to: string, kind: PlacementEdge["kind"] = "secondary"): PlacementEdge => ({
  from,
  to,
  kind,
});

/** Rect for a key, failing loudly when placement skipped the element. */
function rect(placed: Map<string, Rect>, key: string): Rect {
  const found = placed.get(key);
  if (found === undefined) throw new Error(`test: placement produced no rect for "${key}"`);
  return found;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** True when `inner` lies entirely within `outer`, allowing for float noise. */
function contains(outer: Rect, inner: Rect, slack = 0.01): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}

const place = (
  groups: PlacementGroup[],
  nodes: PlacementNode[],
  edges: PlacementEdge[] = [],
  flow: string[] = [],
  direction: Direction = "right",
): Map<string, Rect> => placePanels(groups, nodes, edges, flow, direction);

describe("placement: leaf grids", () => {
  test("packs a leaf panel into uniform cells with one pitch and a shared top edge", () => {
    const groups = [group("p", { columns: 2, labelWidth: 80 })];
    const nodes = nodesIn("p", [
      ["a", 100, 90],
      ["b", 140, 120],
      ["c", 110, 100],
      ["d", 120, 95],
      ["e", 100, 100],
    ]);
    const placed = place(groups, nodes);

    const panel = rect(placed, "g:p");
    const boxes = nodes.map((entry) => rect(placed, `n:${entry.id}`));
    for (const box of boxes) expect(contains(panel, box)).toBe(true);

    // Cells take the widest and tallest card, so pairs share an x and a width.
    expect(boxes[0].x).toBe(boxes[2].x);
    expect(boxes[1].x).toBe(boxes[3].x);
    expect(boxes[0].y).toBe(boxes[1].y);
    expect(boxes[2].y).toBe(boxes[3].y);
    expect(boxes[0].width).toBe(boxes[1].width);

    // Row and column pitches are constant, and at least one inside gutter apart.
    const columnPitch = boxes[1].x - boxes[0].x;
    expect(columnPitch).toBeGreaterThanOrEqual(MIN_INSIDE_GAP);
    const rowPitch = boxes[2].y - boxes[0].y;
    expect(rowPitch).toBeGreaterThanOrEqual(MIN_INSIDE_GAP);
    expect(boxes[3].x - boxes[2].x).toBe(columnPitch);
    expect(boxes[4].y - boxes[2].y).toBe(rowPitch);

    // The fifth card starts the last row at the first column, top-aligned.
    expect(boxes[4].x).toBe(boxes[0].x);
    expect(boxes[4].y).toBeGreaterThan(boxes[2].y);
  });

  test("honours explicit columns over the direction-derived shape", () => {
    const wide = placePanels(
      [group("p", { direction: "right", labelWidth: 60 })],
      nodesIn("p", [["a"], ["b"], ["c"], ["d"]]),
      [],
      [],
      "right",
    );
    const tall = placePanels(
      [group("p", { direction: "down", labelWidth: 60 })],
      nodesIn("p", [["a"], ["b"], ["c"], ["d"]]),
      [],
      [],
      "down",
    );
    const grid = placePanels(
      [group("p", { direction: "right", columns: 2, labelWidth: 60 })],
      nodesIn("p", [["a"], ["b"], ["c"], ["d"]]),
      [],
      [],
      "right",
    );

    // `right` puts a row of four, `down` a column, `columns` a two-wide grid.
    expect(rect(wide, "g:p").width).toBeGreaterThan(rect(wide, "g:p").height);
    expect(rect(tall, "g:p").height).toBeGreaterThan(rect(tall, "g:p").width);
    const first = rect(grid, "n:a");
    const third = rect(grid, "n:c");
    expect(third.x).toBe(first.x);
    expect(third.y).toBeGreaterThan(first.y);
    expect(rect(grid, "g:p").height).toBeGreaterThan(rect(wide, "g:p").height);
  });

  test("shares one card pitch across sibling panels", () => {
    const groups = [
      group("left", { direction: "right", labelWidth: 60 }),
      group("right", { direction: "right", labelWidth: 60 }),
    ];
    const nodes = [
      ...nodesIn("left", [["narrow", 80, 90], ["wide", 150, 110]]),
      ...nodesIn("right", [["plain", 100, 100], ["tall", 90, 140]]).map((entry, index) => ({
        ...entry,
        order: 2 + index,
      })),
    ];
    const placed = place(groups, nodes);

    // Every cell takes the canvas-wide pitch, so panels read as one table. The
    // caller recentres the icon inside the widened card.
    const expected = rect(placed, "n:wide");
    expect(expected.width).toBe(150);
    expect(expected.height).toBe(140);
    for (const id of ["narrow", "plain", "tall"]) {
      const box = rect(placed, `n:${id}`);
      expect(box.width).toBe(expected.width);
      expect(box.height).toBe(expected.height);
    }
    // A card is never shrunk below its own measured footprint.
    for (const entry of nodes) {
      const box = rect(placed, `n:${entry.id}`);
      expect(box.width).toBeGreaterThanOrEqual(entry.width);
      expect(box.height).toBeGreaterThanOrEqual(entry.height);
    }
  });

  test("mirrors a reversed panel direction without changing its cell sizes", () => {
    const rightward = placePanels(
      [group("p", { direction: "right", labelWidth: 60 })],
      nodesIn("p", [["a"], ["b"], ["c"]]),
      [],
      [],
      "right",
    );
    const leftward = placePanels([group("p", { direction: "left", labelWidth: 60 })], nodesIn("p", [["a"], ["b"], ["c"]]), [], [], "right");

    const forward = ["a", "b", "c"].map((id) => rect(rightward, `n:${id}`));
    const backward = ["a", "b", "c"].map((id) => rect(leftward, `n:${id}`));
    expect(forward[0].x).toBeLessThan(forward[2].x);
    expect(backward[0].x).toBeGreaterThan(backward[2].x);
    for (let index = 0; index < 3; index += 1) {
      expect(backward[index].width).toBe(forward[index].width);
      expect(backward[index].height).toBe(forward[index].height);
      expect(backward[index].y).toBe(forward[index].y);
    }
  });
});

describe("placement: nested panels", () => {
  test("keeps unequal nested panels compact instead of inflating them to one cell", () => {
    const groups = [
      group("host", { direction: "down", labelWidth: 120 }),
      group("tall", { parent: "host", direction: "down", labelWidth: 70 }),
      group("short", { parent: "host", direction: "right", labelWidth: 70 }),
    ];
    const nodes = [
      node("rail", { group: "host", width: 130, height: 110, order: 0 }),
      node("t1", { group: "tall", order: 1 }),
      node("t2", { group: "tall", order: 2 }),
      node("t3", { group: "tall", order: 3 }),
      node("s1", { group: "short", order: 4 }),
    ];
    const placed = place(groups, nodes);

    const host = rect(placed, "g:host");
    const tall = rect(placed, "g:tall");
    const short = rect(placed, "g:short");

    // Each nested panel keeps its own measured height: the one-card panel stays
    // much shorter than the three-card one instead of matching it.
    expect(short.height).toBeLessThan(tall.height);
    // Stacking costs one gutter between them, not one full cell of blank space.
    expect(short.y).toBe(tall.y + tall.height + MIN_INSIDE_GAP);
    expect(host.height).toBeLessThan(tall.height + short.height + 4 * MIN_INSIDE_GAP);

    // The direct card rides a narrow rail to the left of the stack, never under it.
    const railCard = rect(placed, "n:rail");
    expect(railCard.x + railCard.width).toBeLessThanOrEqual(tall.x);
    expect(tall.x - (railCard.x + railCard.width)).toBeGreaterThanOrEqual(MIN_INSIDE_GAP);
    expect(tall.x).toBe(short.x);
    for (const key of ["n:rail", "g:tall", "g:short"]) expect(contains(host, rect(placed, key))).toBe(true);
  });

  test("aligns a rail card with the nested card it drives", () => {
    const groups = [
      group("host", { direction: "down", labelWidth: 90 }),
      group("inner", { parent: "host", direction: "down", labelWidth: 60 }),
    ];
    const nodes = [
      node("gateway", { group: "host", height: 100, order: 0 }),
      node("first", { group: "inner", order: 1 }),
      node("second", { group: "inner", order: 2 }),
    ];
    const placed = place(groups, nodes, [edge("gateway", "second", "primary")], ["gateway", "second"]);

    const gateway = rect(placed, "n:gateway");
    const second = rect(placed, "n:second");
    // A translation, not a stretch: same size, same top edge.
    expect(gateway.y).toBe(second.y);
    expect(gateway.height).toBe(100);
    expect(rect(placed, "n:first").y).toBeLessThan(second.y);
  });

  test("nests a multi-level structure without escapes or overlaps", () => {
    const groups = [
      group("outer", { direction: "down", labelWidth: 120 }),
      group("middle", { parent: "outer", direction: "down", labelWidth: 80 }),
      group("leaf", { parent: "middle", columns: 2, labelWidth: 60 }),
    ];
    const nodes = [
      node("door", { group: "outer", order: 0 }),
      node("hall", { group: "middle", order: 1 }),
      node("room1", { group: "leaf", order: 2 }),
      node("room2", { group: "leaf", order: 3 }),
      node("room3", { group: "leaf", order: 4 }),
    ];
    const placed = place(groups, nodes);

    const outer = rect(placed, "g:outer");
    const middle = rect(placed, "g:middle");
    const leaf = rect(placed, "g:leaf");
    expect(contains(outer, middle)).toBe(true);
    expect(contains(middle, leaf)).toBe(true);
    for (const entry of nodes.filter((candidate) => candidate.group === "leaf")) {
      expect(contains(leaf, rect(placed, `n:${entry.id}`))).toBe(true);
    }
    expect(overlaps(rect(placed, "n:door"), middle)).toBe(false);
  });
});

describe("placement: flow", () => {
  test("reserves a contiguous lane for flow members and keeps them off the first column", () => {
    const groups = [group("p", { columns: 2, labelWidth: 60 })];
    // `early` is declared first, so it would normally occupy the lane; the flow
    // members must still get their own unobstructed row starting at column zero.
    const nodes = nodesIn("p", [["early"], ["x"], ["y"], ["late"]]);
    const placed = place(groups, nodes, [], ["x", "y"]);

    const first = rect(placed, "n:x");
    const second = rect(placed, "n:y");
    const early = rect(placed, "n:early");
    expect(first.y).toBe(second.y);
    expect(first.x).toBeLessThan(second.x);
    expect(early.y).toBeLessThan(first.y);
    expect(early.x).toBe(first.x);
    // Nothing sits between the two flow members on their lane.
    const gap = second.x - (first.x + first.width);
    expect(gap).toBeGreaterThanOrEqual(MIN_INSIDE_GAP);
    expect(gap).toBeLessThanOrEqual(MIN_INSIDE_GAP + 0.5);
  });

  test("translates whole panels so the request path shares one line", () => {
    const groups = [
      group("one", { columns: 1, labelWidth: 70 }),
      group("two", { columns: 1, labelWidth: 70 }),
      group("three", { columns: 1, labelWidth: 70 }),
    ];
    const nodes = [
      node("a", { group: "one", order: 0 }),
      node("a2", { group: "one", order: 1 }),
      node("b", { group: "two", order: 2 }),
      node("c", { group: "three", order: 3 }),
    ];
    const placed = place(groups, nodes, [edge("a", "b", "primary"), edge("b", "c", "primary")], ["a", "b", "c"]);

    const tops = ["a", "b", "c"].map((id) => rect(placed, `n:${id}`).y);
    expect(tops[1]).toBe(tops[0]);
    expect(tops[2]).toBe(tops[0]);
    // Panels themselves were translated, not resized: first card keeps its height.
    expect(rect(placed, "n:a").height).toBe(100);
    // `a2` stays below `a` inside its own panel, so the panel is tall enough.
    expect(rect(placed, "n:a2").y).toBe(rect(placed, "n:a").y + 100 + MIN_INSIDE_GAP);
  });
});

describe("placement: canvas composition", () => {
  test("hangs a small satellite under the panel it talks to most", () => {
    const groups = [
      group("main", { columns: 2, labelWidth: 90 }),
      group("aux", { direction: "down", labelWidth: 50 }),
      group("iso", { direction: "down", labelWidth: 50 }),
      group("other", { direction: "down", labelWidth: 70 }),
    ];
    const nodes = [
      node("m1", { group: "main", order: 0 }),
      node("m2", { group: "main", order: 1 }),
      node("m3", { group: "main", order: 2 }),
      node("m4", { group: "main", order: 3 }),
      node("a1", { group: "aux", order: 4 }),
      node("i1", { group: "iso", order: 5 }),
      node("o1", { group: "other", order: 6 }),
      node("o2", { group: "other", order: 7 }),
    ];
    const placed = place(groups, nodes, [
      edge("m2", "a1", "secondary"),
      // `other` is unrelated to `aux`, so it must not drag `aux` away from `main`.
      edge("o1", "o2", "secondary"),
      edge("m1", "o2", "async"),
    ]);

    const main = rect(placed, "g:main");
    const aux = rect(placed, "g:aux");
    const iso = rect(placed, "g:iso");
    const other = rect(placed, "g:other");

    // Satellites hang below the row, the first one under its owner's left edge.
    expect(aux.x).toBe(main.x);
    expect(aux.y).toBeGreaterThanOrEqual(main.y + main.height + MIN_PANEL_GAP - 0.01);
    // A second satellite shares that band and is pushed along it, not stacked on top.
    expect(other.y).toBe(aux.y);
    expect(other.x).toBeGreaterThanOrEqual(aux.x + aux.width + MIN_PANEL_GAP - 0.01);
    // The disconnected panel drops to the bottom-left band.
    expect(iso.x).toBe(0);
    expect(iso.y).toBeGreaterThanOrEqual(aux.y + aux.height);
    for (const box of [aux, iso, other]) expect(overlaps(box, main)).toBe(false);
    expect(overlaps(aux, other)).toBe(false);
  });

  test("lays major panels in declaration order with panel gutters", () => {
    const groups = [
      group("first", { columns: 2, labelWidth: 80 }),
      group("second", { columns: 2, labelWidth: 80 }),
      group("third", { columns: 2, labelWidth: 80 }),
    ];
    const nodes = [
      ...nodesIn("first", [["a1"], ["a2"], ["a3"], ["a4"]]),
      ...nodesIn("second", [["b1"], ["b2"], ["b3"], ["b4"]]).map((entry, index) => ({ ...entry, order: 4 + index })),
      ...nodesIn("third", [["c1"], ["c2"], ["c3"], ["c4"]]).map((entry, index) => ({ ...entry, order: 8 + index })),
    ];
    const placed = place(groups, nodes);

    const first = rect(placed, "g:first");
    const second = rect(placed, "g:second");
    const third = rect(placed, "g:third");
    expect(first.x).toBeLessThan(second.x);
    expect(second.x).toBeLessThan(third.x);
    expect(second.x - (first.x + first.width)).toBeGreaterThanOrEqual(MIN_PANEL_GAP - 0.01);
    expect(third.x - (second.x + second.width)).toBeGreaterThanOrEqual(MIN_PANEL_GAP - 0.01);
    // Panels are top-aligned as a row unless the flow asked otherwise.
    expect(second.y).toBe(first.y);
    expect(third.y).toBe(first.y);
  });

  test("mirrors the whole canvas for a reversed direction and keeps order stable", () => {
    const groups = [
      group("left", { columns: 2, labelWidth: 60 }),
      group("right", { columns: 2, labelWidth: 60 }),
    ];
    const nodes = [...nodesIn("left", [["l1"], ["l2"], ["l3"], ["l4"]]), ...nodesIn("right", [["r1"], ["r2"], ["r3"], ["r4"]]).map((entry, index) => ({ ...entry, order: 4 + index }))];
    const forward = place(groups, nodes, [], [], "right");
    const backward = place(groups, nodes, [], [], "left");

    const leftForward = rect(forward, "g:left");
    const rightForward = rect(forward, "g:right");
    const leftBackward = rect(backward, "g:left");
    const rightBackward = rect(backward, "g:right");

    expect(leftForward.x).toBeLessThan(rightForward.x);
    expect(leftBackward.x).toBeGreaterThan(rightBackward.x);
    // Mirroring preserves sizes, gutters and the vertical relationship.
    expect(leftBackward.width).toBe(leftForward.width);
    expect(rightBackward.width).toBe(rightForward.width);
    expect(leftBackward.x - (rightBackward.x + rightBackward.width)).toBeCloseTo(
      rightForward.x - (leftForward.x + leftForward.width),
      6,
    );
    expect(leftBackward.y).toBe(leftForward.y);
    // Every card stays inside its own panel after the mirror.
    for (const entry of nodes) {
      expect(contains(rect(backward, `g:${entry.group}`), rect(backward, `n:${entry.id}`))).toBe(true);
    }
  });
});
