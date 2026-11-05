import { describe, expect, test } from "bun:test";

import club from "../diagram/club.json";
import { layoutDiagram } from "../src/diagram/layout";
import { theme } from "../src/diagram/theme";
import type { DiagramSpec, MeasureText, Scene, SceneEdge, SceneNode } from "../src/diagram/types";

/**
 * Behavioural tests for the layout pass.
 *
 * These assert what the application depends on: every declared element survives
 * with absolute, finite, orthogonal geometry; captions are real obstacles;
 * groups contain their members; validation failures name the offending path.
 * They deliberately avoid asserting exact coordinates, which belong to ELK and
 * would turn every engine upgrade into a test rewrite.
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

const EPS = 0.76;

function spec(partial: Partial<DiagramSpec> & Pick<DiagramSpec, "nodes">): DiagramSpec {
  return { edges: [], ...partial };
}

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

const insideRect = (inner: { x: number; y: number; width: number; height: number }, outer: { x: number; y: number; width: number; height: number }): boolean =>
  inner.x >= outer.x - EPS &&
  inner.y >= outer.y - EPS &&
  inner.x + inner.width <= outer.x + outer.width + EPS &&
  inner.y + inner.height <= outer.y + outer.height + EPS;

/** True when a segment enters the interior of a rectangle by more than a hair. */
function segmentCrossesRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  const inset = 1.5;
  return (
    Math.max(a.x, b.x) > rect.x + inset &&
    Math.min(a.x, b.x) < rect.x + rect.width - inset &&
    Math.max(a.y, b.y) > rect.y + inset &&
    Math.min(a.y, b.y) < rect.y + rect.height - inset
  );
}

describe("layoutDiagram: scene completeness", () => {
  test("emits every declared node, edge and group exactly once, in input order", async () => {
    const input = spec({
      title: "Platform",
      groups: [
        { id: "edge", label: "Edge", tone: "warm" },
        { id: "app", label: "Application", tone: "cool" },
      ],
      nodes: [
        { id: "visitors", label: "Visitors", subtitle: "browser", shape: "terminal" },
        { id: "proxy", label: "Proxy", icon: "cloudflare", group: "edge" },
        { id: "api", label: "API", icon: "hono", group: "app" },
        { id: "db", label: "PostgreSQL", icon: "postgresql", group: "app" },
        { id: "mailer", label: "Mailer" },
      ],
      edges: [
        { id: "v-p", from: "visitors", to: "proxy" },
        { from: "proxy", to: "api", label: "HTTPS", kind: "primary" },
        { from: "api", to: "db", label: "SQL" },
        { from: "api", to: "mailer", kind: "async" },
      ],
    });

    const scene = await layoutDiagram(input, measure);

    expect(scene.title).toBe("Platform");
    expect(scene.groups.map((group) => group.id)).toEqual(["edge", "app"]);
    expect(scene.nodes.map((node) => node.id)).toEqual(["visitors", "proxy", "api", "db", "mailer"]);
    // Authored ids are preserved verbatim; the unnamed edge gets a stable id.
    expect(scene.edges.map((edge) => edge.id)).toEqual(["v-p", "proxy->api", "api->db", "api->mailer"]);
    expect(scene.edges[2].label?.text).toBe("SQL");
    expect(scene.edges[3].kind).toBe("async");
  });

  test("groups are emitted parent before child and carry their tone and dash flags", async () => {
    const scene = await layoutDiagram(
      spec({
        groups: [
          { id: "inner", label: "Inner", parent: "outer", tone: "cool", dashed: true },
          { id: "outer", label: "Outer", tone: "warm" },
        ],
        nodes: [{ id: "leaf", label: "Leaf", group: "inner" }],
      }),
      measure,
    );

    expect(scene.groups.map((group) => group.id)).toEqual(["outer", "inner"]);
    const inner = scene.groups[1];
    expect(inner.parent).toBe("outer");
    expect(inner.tone).toBe("cool");
    expect(inner.dashed).toBe(true);
    expect(scene.groups[0].dashed).toBe(false);
    expect(scene.nodes[0].parent).toBe("inner");
  });

  test("keeps groups that contain no nodes, so reserved space is not silently dropped", async () => {
    const scene = await layoutDiagram(
      spec({
        groups: [{ id: "reserved", label: "Reserved capacity" }],
        nodes: [{ id: "only", label: "Only node" }],
      }),
      measure,
    );

    const group = scene.groups[0];
    expect(group.id).toBe("reserved");
    expect(group.width).toBeGreaterThan(0);
    expect(group.height).toBeGreaterThan(0);
  });
});

describe("layoutDiagram: determinism and absolute geometry", () => {
  test("produces byte-identical scenes for identical input", async () => {
    const input = spec({
      direction: "down",
      groups: [{ id: "g", label: "Group" }],
      nodes: [
        { id: "a", label: "Alpha", group: "g" },
        { id: "b", label: "Beta", icon: "redis", group: "g" },
        { id: "c", label: "Gamma" },
      ],
      edges: [
        { id: "ab", from: "a", to: "b" },
        { id: "bc", from: "b", to: "c" },
        { id: "ca", from: "c", to: "a" },
      ],
    });

    const first = await layoutDiagram(input, measure);
    const second = await layoutDiagram(input, measure);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("emits finite non-negative absolute coordinates that stay inside the scene", async () => {
    const scene = await layoutDiagram(
      spec({
        groups: [{ id: "g", label: "Group" }],
        nodes: [
          { id: "a", label: "Alpha", group: "g", icon: "redis" },
          { id: "b", label: "Beta", group: "g" },
          { id: "c", label: "Gamma" },
        ],
        edges: [{ id: "ab", from: "a", to: "b", label: "call" }, { id: "bc", from: "b", to: "c" }],
      }),
      measure,
    );

    const rects = [...scene.groups, ...scene.nodes, ...scene.edges.map((edge) => edge.label).filter((label) => label !== undefined)];
    for (const rect of rects) {
      for (const value of [rect.x, rect.y, rect.width, rect.height]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(scene.width + EPS);
      expect(rect.y + rect.height).toBeLessThanOrEqual(scene.height + EPS);
    }
    for (const edge of scene.edges) {
      for (const point of edge.points) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(scene.width + EPS);
        expect(point.y).toBeLessThanOrEqual(scene.height + EPS);
      }
    }
  });

  test("nests every node and child group inside its parent group rectangle", async () => {
    const scene = await layoutDiagram(
      spec({
        groups: [
          { id: "l1", label: "Level one" },
          { id: "l2", label: "Level two", parent: "l1" },
          { id: "l3", label: "Level three", parent: "l2" },
        ],
        nodes: [
          { id: "deep-a", label: "Deep A", group: "l3" },
          { id: "deep-b", label: "Deep B", group: "l3" },
          { id: "mid", label: "Mid", group: "l2" },
          { id: "top", label: "Top", group: "l1" },
          { id: "root", label: "Root" },
        ],
        edges: [
          { id: "e1", from: "root", to: "top" },
          { id: "e2", from: "top", to: "mid" },
          { id: "e3", from: "mid", to: "deep-a" },
          { id: "e4", from: "deep-a", to: "deep-b" },
        ],
      }),
      measure,
    );

    for (const node of scene.nodes) {
      if (node.parent === undefined) continue;
      const parent = scene.groups.find((group) => group.id === node.parent)!;
      expect(insideRect(node, parent)).toBe(true);
    }
    for (const group of scene.groups) {
      if (group.parent === undefined) continue;
      const parent = scene.groups.find((candidate) => candidate.id === group.parent)!;
      expect(insideRect(group, parent)).toBe(true);
    }
  });
});

describe("layoutDiagram: node footprints and captions", () => {
  test("service footprints reserve the whole caption below a centred 64px icon card", async () => {
    const scene = await layoutDiagram(
      spec({
        nodes: [
          { id: "svc", label: "PostgreSQL", subtitle: "application data", icon: "postgresql" },
          { id: "long", label: "A deliberately long service title that must wrap", subtitle: "and a subtitle too", icon: "redis" },
        ],
      }),
      measure,
    );

    for (const node of scene.nodes) {
      expect(node.shape).toBe("service");
      expect(node.card).toBeDefined();
      const card = node.card!;
      expect(card.width).toBe(theme.cardSize);
      expect(card.height).toBe(theme.cardSize);
      expect(card.x).toBeCloseTo(node.x + (node.width - theme.cardSize) / 2, 1);
      expect(card.y).toBeCloseTo(node.y, 1);
      expect(insideRect(card, node)).toBe(true);

      // Height covers card + gap + title lines + gap + subtitle lines.
      const captionHeight =
        8 +
        node.labelLines.length * theme.titleLineHeight +
        (node.subtitleLines.length > 0 ? 3 + node.subtitleLines.length * theme.subtitleLineHeight : 0);
      expect(node.height).toBeCloseTo(theme.cardSize + captionHeight, 1);
      expect(node.width).toBeGreaterThanOrEqual(theme.cardSize);

      // Wrapped lines are real text, never empty padding rows.
      expect(node.labelLines.length).toBeGreaterThan(0);
      expect(node.labelLines.join(" ").replace(/\s+/g, " ")).toBe(
        node.id === "svc" ? "PostgreSQL" : "A deliberately long service title that must wrap",
      );
    }
    // A long title wraps instead of growing the card.
    expect(scene.nodes[1].labelLines.length).toBeGreaterThan(1);
  });

  test("defaults the shape to service when an icon is present and to process otherwise", async () => {
    const scene = await layoutDiagram(
      spec({
        nodes: [
          { id: "icon", label: "Has icon", icon: "github" },
          { id: "plain", label: "No icon" },
          { id: "body", label: "Explicit process", shape: "process" },
          { id: "terminal", label: "Done", shape: "terminal" },
          { id: "decision", label: "Valid?", shape: "decision" },
        ],
      }),
      measure,
    );

    expect(nodeById(scene, "icon").shape).toBe("service");
    expect(nodeById(scene, "icon").card).toBeDefined();
    expect(nodeById(scene, "plain").shape).toBe("process");
    expect(nodeById(scene, "plain").card).toBeUndefined();
    expect(nodeById(scene, "terminal").shape).toBe("terminal");
    expect(nodeById(scene, "decision").shape).toBe("decision");
    // A decision diamond must be large enough to hold its text on the inscribed box.
    const decision = nodeById(scene, "decision");
    expect(decision.width).toBeGreaterThan(decision.height / 4);
  });

  test("routes around captions: no segment crosses a node it does not connect", async () => {
    const scene = await layoutDiagram(club as DiagramSpec, measure);

    for (const edge of scene.edges) {
      for (let index = 1; index < edge.points.length; index += 1) {
        const from = edge.points[index - 1];
        const to = edge.points[index];
        for (const node of scene.nodes) {
          if (edge.source === edge.target && node.id === edge.source) continue;
          if (node.id === edge.source || node.id === edge.target) continue;
          expect(segmentCrossesRect(from, to, node)).toBe(false);
        }
      }
    }
  });
});

describe("layoutDiagram: connectors", () => {
  test("emits one ordered source-to-target polyline of axis-aligned segments", async () => {
    const scene = await layoutDiagram(club as DiagramSpec, measure);

    for (const edge of scene.edges) {
      expect(edge.points.length).toBeGreaterThanOrEqual(2);
      for (let index = 1; index < edge.points.length; index += 1) {
        const from = edge.points[index - 1];
        const to = edge.points[index];
        const horizontal = Math.abs(from.y - to.y) <= 0.01;
        const vertical = Math.abs(from.x - to.x) <= 0.01;
        expect(horizontal || vertical).toBe(true);
      }
    }
  });

  test("attaches each endpoint to the footprint of an incident node", async () => {
    const scene = await layoutDiagram(
      spec({
        nodes: [
          { id: "a", label: "Alpha", icon: "redis" },
          { id: "b", label: "Beta", icon: "hono" },
          { id: "c", label: "Gamma" },
        ],
        edges: [
          { id: "ab", from: "a", to: "b", label: "one" },
          { id: "bc", from: "b", to: "c", label: "two" },
        ],
      }),
      measure,
    );

    for (const edge of scene.edges) {
      const source = nodeById(scene, edge.source);
      const target = nodeById(scene, edge.target);
      expect(insideRect({ x: edge.points[0].x, y: edge.points[0].y, width: 0, height: 0 }, source)).toBe(true);
      const last = edge.points[edge.points.length - 1];
      expect(insideRect({ x: last.x, y: last.y, width: 0, height: 0 }, target)).toBe(true);
    }
  });

  test("meets the visible icon card, not the wider invisible caption box, on horizontal ends", async () => {
    const scene = await layoutDiagram(
      spec({
        nodes: [
          { id: "wide", label: "Fairly wide title", subtitle: "with a subtitle", icon: "redis" },
          { id: "next", label: "Next", icon: "hono" },
        ],
        edges: [{ id: "wide->next", from: "wide", to: "next" }],
      }),
      measure,
    );

    const node = nodeById(scene, "wide");
    const card = node.card!;
    expect(node.width).toBeGreaterThan(card.width);
    const edge = edgeById(scene, "wide->next");
    const start = edge.points[0];
    const cardCenterY = card.y + card.height / 2;
    if (Math.abs(start.y - cardCenterY) <= EPS) {
      expect(start.x).toBeCloseTo(card.x + card.width, 1);
    }
  });

  test("keeps parallel connectors separate and gives each its own label box", async () => {
    const scene = await layoutDiagram(
      spec({
        nodes: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }],
        edges: [
          { id: "one", from: "a", to: "b", label: "first" },
          { id: "two", from: "a", to: "b", label: "second" },
          { id: "three", from: "a", to: "b" },
        ],
      }),
      measure,
    );

    expect(scene.edges).toHaveLength(3);
    expect(new Set(scene.edges.map((edge) => JSON.stringify(edge.points))).size).toBe(3);
    expect(edgeById(scene, "one").label?.text).toBe("first");
    expect(edgeById(scene, "two").label?.text).toBe("second");
    expect(edgeById(scene, "three").label).toBeUndefined();
  });

  test("routes self loops for every direction with a label box", async () => {
    for (const direction of ["right", "down", "left", "up"] as const) {
      const scene = await layoutDiagram(
        spec({
          direction,
          nodes: [{ id: "svc", label: "Service", subtitle: "loop", icon: "redis" }],
          edges: [{ id: "self", from: "svc", to: "svc", label: "retry" }],
        }),
        measure,
      );

      const edge = edgeById(scene, "self");
      expect(edge.source).toBe("svc");
      expect(edge.target).toBe("svc");
      expect(edge.points.length).toBeGreaterThanOrEqual(2);
      expect(edge.label?.text).toBe("retry");
      expect(edge.label!.width).toBeGreaterThan(0);
      expect(edge.label!.height).toBeGreaterThan(0);
      expect(edge.points.some((point) => point.x !== edge.points[0].x || point.y !== edge.points[0].y)).toBe(true);
    }
  });

  test("honours explicit sides", async () => {
    const scene = await layoutDiagram(
      spec({
        direction: "down",
        nodes: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }],
        edges: [{ id: "ab", from: "a", to: "b", fromSide: "east", toSide: "west" }],
      }),
      measure,
    );

    const a = nodeById(scene, "a");
    const b = nodeById(scene, "b");
    const edge = edgeById(scene, "ab");
    const start = edge.points[0];
    const end = edge.points[edge.points.length - 1];

    expect(Math.abs(start.x - (a.x + a.width))).toBeLessThanOrEqual(EPS);
    expect(Math.abs(end.x - b.x)).toBeLessThanOrEqual(EPS);
  });

  test("extracts edge label rectangles that clear every node", async () => {
    const scene = await layoutDiagram(club as DiagramSpec, measure);
    const labelled = scene.edges.filter((edge) => edge.label !== undefined);
    expect(labelled.length).toBeGreaterThan(0);

    for (const edge of labelled) {
      const box = edge.label!;
      expect(insideRect(box, { x: 0, y: 0, width: scene.width, height: scene.height })).toBe(true);
      for (const node of scene.nodes) {
        expect(
          box.x < node.x + node.width && box.x + box.width > node.x && box.y < node.y + node.height && box.y + box.height > node.y,
        ).toBe(false);
      }
    }
  });
});

describe("layoutDiagram: directions, groups and flow", () => {
  test("centres a service when its group heading requires extra width", async () => {
    const scene = await layoutDiagram(spec({
      direction: "right",
      groups: [{ id: "external", label: "External services and integrations" }],
      nodes: [
        { id: "api", label: "API" },
        { id: "mail", label: "Email", icon: "resend", group: "external" },
      ],
      edges: [{ from: "api", to: "mail" }],
    }), measure);
    const group = scene.groups.find((group) => group.id === "external")!;
    const card = nodeById(scene, "mail").card!;
    expect(group.width).toBeGreaterThan(card.width + 36);
    expect(card.x + card.width / 2).toBeCloseTo(group.x + group.width / 2, 1);
  });

  test("lays a chain out along the dominant axis for each direction", async () => {
    for (const direction of ["right", "down", "left", "up"] as const) {
      const scene = await layoutDiagram(
        spec({
          direction,
          nodes: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }, { id: "c", label: "Gamma" }],
          edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
        }),
        measure,
      );

      const [a, b, c] = ["a", "b", "c"].map((id) => nodeById(scene, id));
      const horizontal = direction === "right" || direction === "left";
      const centres = [a, b, c].map((node) => (horizontal ? node.x + node.width / 2 : node.y + node.height / 2));
      const increasing = direction === "right" || direction === "down";
      if (increasing) {
        expect(centres[1]).toBeGreaterThan(centres[0]);
        expect(centres[2]).toBeGreaterThan(centres[1]);
      } else {
        expect(centres[1]).toBeLessThan(centres[0]);
        expect(centres[2]).toBeLessThan(centres[1]);
      }
      // The cross axis stays comparable: a chain is not laid diagonally.
      const cross = [a, b, c].map((node) => (horizontal ? node.y : node.x));
      expect(Math.max(...cross) - Math.min(...cross)).toBeLessThan(Math.max(...centres) - Math.min(...centres));
    }
  });

  test("applies a closed group's own direction", async () => {
    const scene = await layoutDiagram(
      spec({
        direction: "right",
        groups: [{ id: "vertical", label: "Vertical stack", direction: "down" }],
        nodes: [
          { id: "v1", label: "Step one", group: "vertical" },
          { id: "v2", label: "Step two", group: "vertical" },
          { id: "v3", label: "Step three", group: "vertical" },
        ],
        edges: [{ from: "v1", to: "v2" }, { from: "v2", to: "v3" }],
      }),
      measure,
    );

    const steps = ["v1", "v2", "v3"].map((id) => nodeById(scene, id));
    // Downwards inside the group: same column, increasing y.
    for (const step of steps) expect(step.x).toBeCloseTo(steps[0].x, 1);
    expect(steps[1].y).toBeGreaterThan(steps[0].y);
    expect(steps[2].y).toBeGreaterThan(steps[1].y);
  });

  test("still returns complete geometry when a group direction cannot be honoured", async () => {
    // "dok" is crossed by edges to the outside, so ELK must lay it out inside the
    // enclosing run; the documented behaviour is to fall back, never to drop
    // nodes or leave a connector without geometry.
    const scene = await layoutDiagram(
      spec({
        direction: "right",
        groups: [{ id: "hub", label: "Hub", direction: "down" }],
        nodes: [
          { id: "inside", label: "Inside", group: "hub" },
          { id: "outside", label: "Outside" },
        ],
        edges: [{ id: "out-in", from: "outside", to: "inside" }],
      }),
      measure,
    );

    expect(scene.nodes).toHaveLength(2);
    expect(scene.edges).toHaveLength(1);
    expect(scene.edges[0].points.length).toBeGreaterThanOrEqual(2);
    expect(insideRect(nodeById(scene, "inside"), scene.groups[0])).toBe(true);
  });

  test("prefers straight routing for the declared flow without inventing connections", async () => {
    const scene = await layoutDiagram(
      spec({
        nodes: [
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
          { id: "c", label: "Gamma" },
          { id: "side", label: "Side" },
        ],
        edges: [
          { id: "ab", from: "a", to: "b" },
          { id: "bc", from: "b", to: "c" },
          { id: "a-side", from: "a", to: "side" },
        ],
        flow: ["a", "b", "c"],
      }),
      measure,
    );

    // A preference only: the edge set is untouched and every edge still routes.
    expect(scene.edges.map((edge) => edge.id)).toEqual(["ab", "bc", "a-side"]);
    for (const edge of scene.edges) expect(edge.points.length).toBeGreaterThanOrEqual(2);

    // The declared chain is still laid out along the diagram direction.
    const centres = ["a", "b", "c"].map((id) => {
      const node = nodeById(scene, id);
      return node.x + node.width / 2;
    });
    expect(centres[1]).toBeGreaterThan(centres[0]);
    expect(centres[2]).toBeGreaterThan(centres[1]);
  });

  test("lays out the full festival fixture without losing nodes or edges", async () => {
    const scene = await layoutDiagram(club as DiagramSpec, measure);

    const declared = club as DiagramSpec;
    expect(scene.nodes.map((node) => node.id)).toEqual(declared.nodes.map((node) => node.id));
    // Every fixture connector is authored with an id, so ids pass through as-is.
    const declaredIds = declared.edges.map((edge) => edge.id);
    expect(declaredIds.every((id) => typeof id === "string")).toBe(true);
    expect(scene.edges.map((edge) => edge.id)).toEqual(declaredIds as string[]);
    expect(scene.groups.map((group) => group.id).sort()).toEqual((declared.groups ?? []).map((group) => group.id).sort());
    expect(scene.nodes).toHaveLength(35);
    expect(scene.edges).toHaveLength(34);
    expect(scene.width).toBeGreaterThan(0);
    expect(scene.height).toBeGreaterThan(0);
  });

  test("routes the declared festival flow left to right instead of as return loops", async () => {
    const scene = await layoutDiagram(club as DiagramSpec, measure);
    const centre = (id: string) => {
      const node = nodeById(scene, id);
      return node.x + node.width / 2;
    };

    const chain = ["cf.dns", "dok.dokploy", "dok.pub.apigw", "dok.tickets", "dok.tkdb"];
    for (let index = 1; index < chain.length; index += 1) {
      expect(centre(chain[index])).toBeGreaterThan(centre(chain[index - 1]));
    }
    // The chain stays on one axis: a semantic direction, not a diagonal drift.
    const rows = chain.map((id) => nodeById(scene, id).y + nodeById(scene, id).height / 2);
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(scene.height / 2);
  });
});

describe("layoutDiagram: measurement", () => {
  test("uses the caller's measurement callback to size nodes", async () => {
    const input = spec({ nodes: [{ id: "a", label: "Alpha Beta" }] });
    const narrow = await layoutDiagram(input, (text) => text.length * 2);
    const wide = await layoutDiagram(input, (text) => text.length * 30);

    // Wide glyphs must widen the node; that only shows above the minimum width,
    // so the "wide" measurement is deliberately far larger.
    expect(wide.nodes[0].width).toBeGreaterThan(narrow.nodes[0].width);
    expect(wide.nodes[0].width).toBeGreaterThan(theme.cardSize);
  });

  test("wraps using the supplied measurement and returns the rendered lines", async () => {
    const text = "one two three four five six";
    const scene = await layoutDiagram(
      spec({ nodes: [{ id: "a", label: text }] }),
      (value, font) => (/(\d+(?:\.\d+)?)px/.exec(font)?.[1] === "12" ? value.length * 8 : value.length * 6),
    );

    const node = scene.nodes[0];
    expect(node.labelLines.length).toBeGreaterThan(1);
    expect(node.labelLines.join(" ")).toBe(text);
  });
});

describe("layoutDiagram: validation", () => {
  const invalid: Array<[string, unknown, RegExp]> = [
    ["a non-object script", 42, /^Diagram script \(root\): expected an object/],
    ["a missing node list", { edges: [] }, /nodes: expected an array/],
    ["an empty node list", { nodes: [], edges: [] }, /nodes: must declare at least one node/],
    ["a missing edge list", { nodes: [{ id: "a", label: "A" }] }, /edges: expected an array/],
    ["an unknown root field", { nodes: [{ id: "a", label: "A" }], edges: [], extra: 1 }, /unknown field "extra"/],
    ["an unknown node field", { nodes: [{ id: "a", label: "A", width: 100 }], edges: [] }, /nodes\[0\]: unknown field "width"/],
    ["an unknown edge field", { nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "a", colour: "red" }] }, /edges\[0\]: unknown field "colour"/],
    ["an invalid direction", { direction: "northwest", nodes: [{ id: "a", label: "A" }], edges: [] }, /direction: expected one of "right", "down", "left", "up"/],
    ["an empty node id", { nodes: [{ id: " ", label: "A" }], edges: [] }, /nodes\[0\]\.id: must not be empty/],
    ["an empty node label", { nodes: [{ id: "a", label: "" }], edges: [] }, /nodes\[0\]\.label: must not be empty/],
    ["a duplicate node id", { nodes: [{ id: "a", label: "A" }, { id: "a", label: "B" }], edges: [] }, /nodes\[1\]\.id: duplicate node id "a"/],
    ["a node reusing a group id", { groups: [{ id: "g", label: "G" }], nodes: [{ id: "g", label: "A" }], edges: [] }, /id "g" is already used by a group/],
    ["an unknown group reference", { nodes: [{ id: "a", label: "A", group: "ghost" }], edges: [] }, /nodes\[0\]\.group: unknown group "ghost"/],
    ["an unknown edge source", { nodes: [{ id: "a", label: "A" }], edges: [{ from: "b", to: "a" }] }, /edges\[0\]\.from: unknown node "b"/],
    ["an unknown edge target", { nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "b" }] }, /edges\[0\]\.to: unknown node "b"/],
    ["an invalid edge side", { nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "a", toSide: "up" }] }, /edges\[0\]\.toSide: expected one of "north", "east", "south", "west"/],
    ["an invalid shape", { nodes: [{ id: "a", label: "A", shape: "hexagon" }], edges: [] }, /nodes\[0\]\.shape: expected one of "service", "process", "decision", "terminal"/],
    ["an invalid edge kind", { nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "a", kind: "loud" }] }, /edges\[0\]\.kind: expected one of "primary", "secondary", "async"/],
    ["an invalid tone", { groups: [{ id: "g", label: "G", tone: "hot" }], nodes: [{ id: "a", label: "A" }], edges: [] }, /groups\[0\]\.tone: expected one of "warm", "cool", "neutral"/],
    ["a non-boolean dashed flag", { groups: [{ id: "g", label: "G", dashed: "yes" }], nodes: [{ id: "a", label: "A" }], edges: [] }, /groups\[0\]\.dashed: expected a boolean/],
    ["an unknown parent group", { groups: [{ id: "g", label: "G", parent: "ghost" }], nodes: [{ id: "a", label: "A" }], edges: [] }, /unknown group "ghost"/],
    ["a group containment cycle", { groups: [{ id: "x", label: "X", parent: "y" }, { id: "y", label: "Y", parent: "x" }], nodes: [{ id: "a", label: "A" }], edges: [] }, /containment cycle: x -> y -> x/],
    ["a group that is its own parent", { groups: [{ id: "x", label: "X", parent: "x" }], nodes: [{ id: "a", label: "A" }], edges: [] }, /containment cycle: x -> x/],
    ["a duplicate group id", { groups: [{ id: "x", label: "X" }, { id: "x", label: "Y" }], nodes: [{ id: "a", label: "A" }], edges: [] }, /groups\[1\]\.id: duplicate group id "x"/],
    ["a duplicate edge id", { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ id: "e", from: "a", to: "b" }, { id: "e", from: "b", to: "a" }] }, /edges\[1\]\.id: duplicate edge id "e"/],
    ["an invalid icon alias", { nodes: [{ id: "a", label: "A", icon: "Cloud Flare" }], edges: [] }, /nodes\[0\]\.icon: expected a lowercase alias/],
    ["an unknown flow node", { nodes: [{ id: "a", label: "A" }], edges: [], flow: ["a", "ghost"] }, /flow\[1\]: unknown node "ghost"/],
    ["a repeated flow node", { nodes: [{ id: "a", label: "A" }], edges: [], flow: ["a", "a"] }, /flow\[1\]: duplicate node "a" in flow/],
    ["a flow step without a connection", { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "b", to: "a" }], flow: ["a", "b"] }, /no directed connection "a" -> "b"/],
  ];

  for (const [name, input, message] of invalid) {
    test(`rejects ${name}`, async () => {
      await expect(layoutDiagram(input, measure)).rejects.toThrow(message);
    });
  }

  test("accepts connector cycles, which are legal topology", async () => {
    const scene = await layoutDiagram(
      spec({
        nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
        edges: [
          { id: "ab", from: "a", to: "b" },
          { id: "bc", from: "b", to: "c" },
          { id: "ca", from: "c", to: "a" },
        ],
      }),
      measure,
    );

    expect(scene.edges).toHaveLength(3);
    for (const edge of scene.edges) expect(edge.points.length).toBeGreaterThanOrEqual(2);
  });

  test("assigns unique ids to unnamed parallel edges", async () => {
    const scene = await layoutDiagram(
      spec({
        nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
        edges: [{ from: "a", to: "b" }, { from: "a", to: "b" }, { from: "a", to: "b" }],
      }),
      measure,
    );

    const ids = scene.edges.map((edge) => edge.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain("a->b");
  });
});
