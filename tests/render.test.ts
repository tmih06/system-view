import { describe, expect, test } from "bun:test";

import { layoutDiagram } from "../src/diagram/layout";
import { renderSvg } from "../src/diagram/svg";
import { darkTheme, theme } from "../src/diagram/theme";
import type { DiagramSpec, MeasureText } from "../src/diagram/types";

const measure: MeasureText = (text, font) => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 12);
  return text.length * size * 0.55;
};

const spec: DiagramSpec = {
  direction: "right",
  groups: [{ id: "app", label: "Application", tone: "cool" }],
  nodes: [
    { id: "browser", label: "Browser", shape: "terminal" },
    { id: "api", label: "API", icon: "hono", group: "app" },
  ],
  edges: [{ from: "browser", to: "api", label: "HTTPS", kind: "primary" }],
};

const icons = { hono: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" };

describe("renderSvg palettes", () => {
  test("repainting a palette never changes scene geometry", async () => {
    const scene = await layoutDiagram(spec, measure);
    const light = renderSvg(scene, icons, { palette: theme });
    const dark = renderSvg(scene, icons, { palette: darkTheme });
    const geometry = (svg: string) => [...svg.matchAll(/d="([^"]+)"/g)].map((match) => match[1]);
    expect(geometry(dark)).toEqual(geometry(light));
    expect(dark).toContain(darkTheme.primary);
    expect(dark).not.toContain(`fill="${theme.background}"`);
    expect(light).toContain(theme.primary);
  });
});
