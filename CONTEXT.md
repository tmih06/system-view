# CONTEXT

Everything needed to work on this repository: how the pieces fit, which
invariants are load-bearing, and where the traps are. Read this before changing
layout, rendering, or the example fixtures.

## What this is

A browser app that turns a JSON description of a system into a diagram. The
script is the only input; all geometry is derived. Three parts:

```
web/                browser app: editor, whiteboard, entry point
src/diagram/        the engine: validation, layout, SVG and draw.io export
diagram/            example scripts, plus a draw.io reference used to trace one
scripts/            build, icon fetch, trace generator, grid injection
tests/              behavioural tests over the engine
```

## Vocabulary

| Term | Meaning |
|---|---|
| **script** | The JSON a user writes. Validated against `diagram.schema.json`. |
| **spec** | The validated form of a script (`DiagramSpec` in `types.ts`). |
| **scene** | Layout output: absolute rectangles and polylines. Theme-independent. |
| **node** | One card. A *service* has an icon card plus captions; other shapes are text bodies. |
| **group** | A tinted panel. Groups nest, so a group can contain groups and nodes. |
| **edge** | A directed connector. Labels are optional. |
| **footprint** | A node's full box *including* its caption. This is the obstacle the router avoids. |
| **defaults** | Per-document box and card geometry shared by every node; a node may override any field. |
| **card** | The visible icon square inside a service footprint. |
| **flow** | An optional preferred chain of nodes; a routing preference, never a new connection. |
| **auto / manual** | Automatic layout, or explicit authored coordinates. |

## The pipeline

`layoutDiagram(input, measureText)` in `src/diagram/layout.ts`:

1. **Validate** (`validateDiagram`) — untrusted JSON to a typed `ValidatedDiagram`.
   Unknown fields are errors, ids must be unique, references must resolve, group
   containment must be acyclic, coordinates are rejected in auto mode and
   required in manual mode.
2. **Measure** (`measureNode`) — every caption is wrapped and measured through
   the caller's `measureText` callback, producing each node's footprint.
3. **Layout** — `layoutManual` uses authored geometry; `layoutAutomatic` hands a
   sized graph to [ELK](https://eclipse.dev/elk/) (`elkjs`) and translates the
   result.
4. **Emit** — a `Scene` with absolute coordinates. Groups come parent-first;
   nodes and edges keep their input order and appear exactly once.

The renderers (`svg.ts`, `drawio.ts`) only paint a `Scene`. They never derive
geometry, which is why a theme switch can recolour without re-running layout.

## Invariants that must stay true

- **A composed canvas routes crossing connectors around cards.** A wire that
  crosses panel borders is drawn by `routeAround`, a visibility-grid search that
  treats cards and non-incident panels as obstacles. A naive L or Z shape cuts
  through whatever sits between the two cards, which is why the search exists; a
  test asserts no segment crosses a node it does not connect.
- **`Scene` is theme-independent.** Layout uses the light `theme` metrics;
  palettes only change paint. `tests/render.test.ts` pins this: both palettes
  must emit identical path data.
- **Footprints are obstacles.** ELK routes around node rectangles, which is how
  captions stay clear of wires. Shrinking a footprint to the card re-introduces
  wires through captions.
- **`manual` geometry is authoritative, not a minimum.** Authored `width`/`height`
  and `cardX`/`cardY` are exact, because anchors are fractions of the authored
  box. Re-measuring would move every endpoint off its traced point.
- **Shared geometry lives in `defaults`.** When every node has the same box and
  icon square, declaring it once keeps the script about geometry that differs. A
  node override wins, and the card rectangle stays relative to the node origin so
  a width override does not move the icon.
- **Manual output is self-checking.** `assertManualGeometry` throws on
  overlapping cards, a label over a card, or two labels over each other, so no
  export can contain them.
- **`diagram/club.manual.json` is generated, never hand-edited.**
  `bun run trace` regenerates it from `diagram/club.drawio`, and a test fails if
  the committed file differs from fresh output.
- **`elkjs` is loaded through a `document` shim** (`loadEngine`). elkjs picks its
  browser vs CommonJS branch at import time by testing `document`; Bun defines
  `self` but not `document`, so the shim is required and removed again in a
  `finally`. This is why the import is dynamic — a static import is hoisted above
  the shim.

## Layout modes

`auto` has two strategies, chosen by graph shape. A canvas holding **two or more
panels** is composed in layers: one ELK run per panel decides its interior (so
each honours its own `direction` and a card-heavy panel wraps into a grid), then
one run places those panels as fixed boxes. A single panel or a plain node graph
uses one run, which is simpler and is what the existing tests cover.

The split exists because the two features cannot coexist in one run: ELK honours
a group's `direction` only when that group is its own run, and its wrapping
pipeline throws as soon as a connector crosses the border of a wrapped group.

Useful mental model:

- The layered algorithm places nodes in layers along `direction` and routes
  orthogonally.
- Ports are pinned per side (`FIXED_POS`), so east/west endpoints sit at icon-card
  height rather than the middle of the taller caption box. `trimToCard` then pulls
  endpoints onto the visible card edge so a wire does not stop beside the caption.
- In the one-run strategy a group's own `direction` is honoured only when the
  group is *closed* — no connector crosses its border, directly or through a
  nested group. ELK cannot lay out a self-directed subtree in its own run and
  still route crossing connectors, so an open group follows the enclosing
  direction. The composed strategy has no such limit.
- `flow` raises routing priority along the declared chain. It never adds an edge
  and never guarantees exact alignment.

`manual` places nodes at their authored `x`/`y`, takes group rectangles verbatim,
draws each connector through its `via` points, and derives endpoints by
intersecting the centre-to-centre line with the node border. Authored polylines
that are already axis-aligned are drawn verbatim; a diagonal segment is rewritten
as a 90° staircase, and midpoints that would reverse direction are collapsed.

## Files worth knowing

| Path | Role |
|---|---|
| `src/diagram/types.ts` | The shared contract: spec, scene, and geometry types. |
| `src/diagram/layout.ts` | Validation, measurement, both layout modes, and the two auto strategies. |
| `src/diagram/elk.ts` | ELK loading (with the `document` shim) and result translation. |
| `src/diagram/svg.ts` | `renderSvg`; also `orderGroups`, which both exporters share. |
| `src/diagram/drawio.ts` | `renderDrawio` — editable draw.io export, no UI entry point. |
| `src/diagram/theme.ts` | Metrics and both palettes. Metrics are identical across palettes. |
| `web/main.tsx` | App state: debounced decode, layout, icon loading, theme persistence. |
| `web/Whiteboard.tsx` | Camera, pan/zoom/fit, toolbar. Owns no layout logic. |
| `scripts/trace-club.ts` | Deterministic `club.drawio` → `club.manual.json` converter. |
| `scripts/build.ts` | Static build: bundle, copy icons, schema, and `404.html`. |
| `scripts/check-dist.ts` | Verifies the built `dist/` is complete; run in CI. |

## Icons

`icons/*.svg` are normalised to a 512×512 canvas with the artwork in a common
inner box, so a grid of cards reads as evenly weighted. A node references one by
alias (`"icon": "redis"`). `renderSvg` inlines each as a `data:` URI, and a
missing alias is a hard error rather than a silently iconless card.

## Commands

```sh
bun run dev        # dev server with hot reload
bun run typecheck  # tsc --noEmit over src, web, tests, scripts
bun test           # behavioural tests
bun run build      # static site into dist/
bun run trace      # regenerate diagram/club.manual.json
bun scripts/check-dist.ts   # verify a built dist/
```

## Testing approach

Tests assert behaviour, not coordinates: axis-aligned routes, endpoints on the
right footprint, labels clear of cards, groups containing their members, and
validation errors naming the offending path. Exact coordinates belong to ELK and
would turn every engine upgrade into a rewrite.

`tests/manual.test.ts` additionally pins the traced fixture: it must equal fresh
output from `scripts/trace-club.ts`, and every traced node must carry an icon or
an explicit body shape plus its authored box size.

## CI

`.github/workflows/ci.yml` runs the same gates as local development: frozen
install, typecheck, tests with coverage, `bun audit`, the static build, and
`scripts/check-dist.ts`. Keep it in step with the scripts above.
