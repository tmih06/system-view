import { describe, expect, test } from "bun:test";

import club from "../diagram/club.manual.json";
import { layoutDiagram } from "../src/diagram/layout";
import type { DiagramSpec, MeasureText, Scene } from "../src/diagram/types";

/**
 * Manual layout is what reproduces a hand-composed reference: ELK can honour a
 * group's own direction only when that group is laid out separately, which
 * forbids connectors that cross its border. These tests pin the authored
 * geometry surviving the pass unchanged.
 */

const measure: MeasureText = (text, font) => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 12);
  let units = 0;
  for (const character of text) units += character === " " ? 0.3 : 0.55;
  return units * size;
};

const spec = (partial: Record<string, unknown>): DiagramSpec => partial as unknown as DiagramSpec;

describe("layoutDiagram: manual layout", () => {
  test("places every node at its authored corner and keeps the traced composition", async () => {
    const input = club as DiagramSpec;
    const scene = await layoutDiagram(input, measure);

    expect(scene.nodes).toHaveLength(35);
    expect(scene.edges).toHaveLength(34);
    expect(scene.groups).toHaveLength(9);
    for (const node of input.nodes) {
      const placed = scene.nodes.find((candidate) => candidate.id === node.id)!;
      expect(placed.x).toBe(node.x!);
      expect(placed.y).toBe(node.y!);
    }
    // The reference canvas is 1568x1354; the traced geometry must stay close.
    expect(scene.width).toBeGreaterThan(1500);
    expect(scene.width).toBeLessThan(1650);
    expect(scene.height).toBeGreaterThan(1280);
    expect(scene.height).toBeLessThan(1420);
  });

  test("routes every connector on axis-aligned segments with no U-turns", async () => {
    const scene = await layoutDiagram(club as DiagramSpec, measure);
    for (const edge of scene.edges) {
      const points = edge.points;
      for (let index = 1; index < points.length; index += 1) {
        const a = points[index - 1];
        const b = points[index];
        expect(Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01).toBe(true);
      }
      for (let index = 2; index < points.length; index += 1) {
        const a = points[index - 2];
        const b = points[index - 1];
        const c = points[index];
        const first = { x: b.x - a.x, y: b.y - a.y };
        const second = { x: c.x - b.x, y: c.y - b.y };
        const lengths = Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y);
        if (lengths < 1) continue;
        const dot = (first.x * second.x + first.y * second.y) / lengths;
        expect(dot).toBeGreaterThan(-0.9);
      }
    }
  });

  test("keeps labels clear of icon cards and of each other", async () => {
    const scene = await layoutDiagram(club as DiagramSpec, measure);
    const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    const labels = scene.edges.flatMap((edge) => (edge.label ? [{ id: edge.id, box: edge.label }] : []));
    for (const { id, box } of labels) {
      for (const node of scene.nodes) {
        expect(overlaps(box, node.card ?? node), `${id} overlaps ${node.id}`).toBe(false);
      }
    }
    for (let index = 0; index < labels.length; index += 1) {
      for (let other = index + 1; other < labels.length; other += 1) {
        expect(overlaps(labels[index].box, labels[other].box), `${labels[index].id} overlaps ${labels[other].id}`).toBe(false);
      }
    }
  });

  test("aligns same-group nodes on a common card grid", async () => {
    const scene = await layoutDiagram(club as DiagramSpec, measure);
    const byGroup = new Map<string, typeof scene.nodes>();
    for (const node of scene.nodes) {
      if (!node.parent) continue;
      byGroup.set(node.parent, [...(byGroup.get(node.parent) ?? []), node]);
    }
    for (const nodes of byGroup.values()) {
      // Uniform card size is what keeps columns and rows visually aligned.
      const widths = new Set(nodes.map((node) => Math.round(node.card!.width)));
      expect(widths.size).toBe(1);
    }
  });

  test("anchors connectors on the node border rather than its centre", async () => {
    const scene: Scene = await layoutDiagram(spec({
      layout: "manual",
      nodes: [
        { id: "a", label: "Alpha", x: 0, y: 0 },
        { id: "b", label: "Beta", x: 400, y: 0 },
      ],
      edges: [{ from: "a", to: "b" }],
    }), measure);
    const a = scene.nodes[0];
    expect(scene.edges[0].points[0].x).toBeCloseTo(a.x + a.width, 1);
  });

  test("requires coordinates on every node in manual mode", async () => {
    await expect(layoutDiagram(spec({
      layout: "manual",
      nodes: [{ id: "a", label: "Alpha" }],
      edges: [],
    }), measure)).rejects.toThrow(/manual layout requires x and y/);
  });

  test("rejects half-specified points instead of guessing", async () => {
    await expect(layoutDiagram(spec({
      nodes: [{ id: "a", label: "Alpha", x: 10 }],
      edges: [],
    }), measure)).rejects.toThrow(/x and y must be given together/);
  });
});
