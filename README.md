# d2-rich-icons

Coordinate-free system and flow diagrams in a browser. Write JSON on the left;
see an automatically laid-out diagram on the right. SVG brand icons, two-tier
captions, tinted groups, and orthogonal connectors preserve the reference's
visual language without tracing its coordinates.

## Website

Requires [Bun](https://bun.sh/) (tested with 1.4.4). No D2 installation, server-side
layout service, API keys, or native graphics packages are needed for the website.

```sh
bun install --frozen-lockfile
bun run dev
```

Open the URL printed by Bun. It starts at `http://127.0.0.1:3000` and tries the
next port when one is occupied. `PORT=3007 bun run dev` changes the starting port;
`HOST` overrides the bind address. Only address-in-use errors trigger fallback,
and only in development; production startup errors are not retried.

- Two full-height panels, initially split equally: script left, diagram right.
  Drag the divider's centered pill to resize; drag it to the left edge to collapse
  the script, then drag the pill back to reopen. Double-click to restore 50/50.
  The focused divider also supports arrow keys, Home (collapse), and End (expand).
  Resizing is continuous and preserves diagram pan and zoom; use Fit view to recenter.
  The split is stored in `localStorage`, so a reload restores it.
- No header, example picker, status bars, footer, or export menu.
  A compact bottom-left view toolbar provides zoom out, zoom in, fit view, and a
  light/dark theme toggle.
- Dragging glides to a stop and zoom eases to its target; starting another gesture
  stops the motion immediately. `prefers-reduced-motion` disables both.
- The workspace opens on the club architecture, traced from
  `out/club-editable.svg` into `diagram/club.manual.json`: identical panel
  bounds, card positions, and connector bends (35 nodes, 34 connections).
- Layout updates after editing; **Ctrl/Cmd + Enter** runs it again.
- Drag the whiteboard to pan, scroll to zoom, and double-click to fit.
  The dotted background follows the camera and stays at least 20px apart when zoomed out.
- The theme applies to the editor, canvas, and diagram instantly: switching palettes
  repaints the existing scene instead of re-running layout, so the camera never moves.
  The choice persists in `localStorage`, defaulting to the OS preference.
- Invalid input shows a plain error below the editor and keeps the last valid diagram.

The script is not autosaved. Copy it from the editor before reloading to keep edits.

## Agent-facing script

[diagram.schema.json](diagram.schema.json) defines the input; the running site
serves it at `/schema.json`. Describe groups, nodes, connections, and optional
semantic preferences—no coordinates needed:

```json
{
  "title": "My application",
  "direction": "right",
  "groups": [
    { "id": "app", "label": "Application", "tone": "cool" }
  ],
  "nodes": [
    { "id": "browser", "label": "Browser", "shape": "terminal" },
    { "id": "api", "label": "API", "subtitle": "Hono", "icon": "hono", "group": "app" },
    { "id": "db", "label": "PostgreSQL", "icon": "postgresql", "group": "app" }
  ],
  "edges": [
    { "from": "browser", "to": "api", "label": "HTTPS", "kind": "primary" },
    { "from": "api", "to": "db", "label": "SQL" }
  ],
  "flow": ["browser", "api", "db"]
}
```

| Field | Meaning |
|---|---|
| `direction` | `right`, `down`, `left`, or `up` |
| `groups[].parent` | Parent group ID for nested regions |
| `groups[].tone` | `warm`, `cool`, or `neutral`; `dashed` controls the outline |
| `nodes[].group` | Containing group ID |
| `nodes[].shape` | `service`, `process`, `decision`, or `terminal`; defaults to service with an icon, otherwise process |
| `nodes[].icon` | Local SVG alias, such as `cloudflare`, `hono`, `redis`, or `postgresql` |
| `edges[].kind` | `primary` (blue), `secondary` (gray), or `async` (dashed) |
| `edges[].fromSide`, `toSide` | Optional `north`, `east`, `south`, or `west` connection anchors |
| `flow` | Preferred main chain; every consecutive pair must already have a directed connection |
| `layout` | `auto` (default) or `manual` |
| `nodes[].x`, `nodes[].y` | Manual placement; required on every node in manual mode |
| `nodes[].width`, `nodes[].height` | Optional minimum box size; captions may enlarge it |
| `groups[].x/y/width/height` | Manual panel rectangle; all four required together |
| `edges[].via` | Manual interior bends; endpoints are derived from node borders |
| `edges[].fromAnchor`, `toAnchor` | Manual attachment points as fractions of the source/target box |
| `edges[].labelAt` | Manual label anchor: horizontal centre and text baseline |

IDs must be unique and references must resolve. Unknown fields are rejected;
coordinates are rejected in `auto` mode and required in `manual` mode. `flow` is a preference, not a guarantee of exact
alignment. A group-specific direction is supported for closed groups; groups
with connections crossing their boundaries follow the enclosing direction.

ELK computes the layout from measured text and the graph. Service footprints
include captions so routing can avoid them. Cycles, parallel connections,
self-loops, and disconnected components are supported. Dense graphs can still
have crossings and long return paths; this is automatic layout, not a promise
of reproducing a particular hand-arranged composition.

## Layout modes

`auto` runs ELK from the graph alone and rejects coordinates. `manual` places
nodes from their authored `x`/`y`, takes group rectangles verbatim, routes each
connector through its `via` points, and derives endpoints by intersecting the
centre-to-centre line with each node's border.

Manual exists because automatic layout cannot reproduce a hand-composed
reference: ELK honours a group's own `direction` only when that group is laid
out in a separate run, and a separate run cannot host connectors crossing its
border.

In manual mode the authored `width`/`height` are authoritative rather than
minimums. Connector anchors are fractions of the authored box, so re-measuring
a box would move every endpoint off its traced point and make wires overlap or
double back. Authored polylines are drawn verbatim when they are already
axis-aligned; a route with a diagonal segment is rewritten as a 90-degree
staircase, and midpoints that would reverse the direction are collapsed.

`diagram/club.json` is the same topology in auto mode, and
`diagram/club.manual.json` is the traced composition built from
`diagram/club.drawio`. `src/diagram/`
contains the layout module, shared theme tokens, and pure SVG/draw.io exporters.
The website uses the layout and SVG renderer in the browser. The draw.io exporter
remains available as `renderDrawio(scene, icons)` in `src/diagram/drawio.ts`, without
adding controls to the workspace.

## Cloudflare Pages

The production site is **fully static**:

```sh
bun run build       # builds dist/ with HTML, JS, CSS, SVG icons, and schema.json
bun run preview     # serves dist/ through Wrangler Pages locally
```

For a later Pages Git deployment, use:

| Setting | Value |
|---|---|
| Framework preset | None |
| Root directory | Repository root |
| Build command | `bun install --frozen-lockfile && bun run build` |
| Build output directory | `dist` |
| `BUN_VERSION` | `1.4.4` |
| `SKIP_DEPENDENCY_INSTALL` | `1` (the build command installs from `bun.lock`) |

`wrangler.jsonc` declares `dist` as the Pages output. No Pages Functions, Worker,
bindings, secrets, or running Bun server are needed in production. All required
icons are copied from `icons/*.svg`; builds do not fetch external icon services.
Keep those SVG files in the repository. A static `404.html` ensures unknown icon
aliases fail instead of receiving the application's HTML with status 200.

No deployment is performed by the build or preview commands. When ready to
deploy a built directory manually:

```sh
bunx wrangler pages deploy dist
```

The configured Pages project name is `d2-rich-icons`; change it in
`wrangler.jsonc` if you choose another name.

Cloudflare references: [build settings](https://developers.cloudflare.com/pages/configuration/build-image/),
[Pages configuration](https://developers.cloudflare.com/pages/functions/wrangler-configuration/),
and [static routing](https://developers.cloudflare.com/pages/configuration/serving-pages/).

## Manually traced reference (visual benchmark)

Open **[diagram/club.drawio](diagram/club.drawio)** in
[diagrams.net](https://app.diagrams.net/) using **File → Open From → Device**.
This version traces the original image's card positions, panel bounds, connector
bends, and arrow directions: 35 service cards and 34 directed connections.
Labels are in English; SVG icons are embedded. Some icons are generic substitutes.

The DNS → Dokploy → API → Tickets → PostgreSQL backbone stays on one horizontal
line. The public-web region contains the site, API, tickets, portal, and their
data stores, matching the original containment.

Placement and connector waypoints are explicitly traced, not auto-laid-out.
Drag a region to move its contents, drag a service to move its card and captions,
and select a connector to edit its waypoints. Connectors remain attached to
service anchors, but arbitrary card moves may require adjusting their bends.

Preview snapshots: [SVG](out/club-editable.svg) · [PNG](out/club-editable.png).
After editing, use **File → Export as → SVG/PNG** in diagrams.net; enable
**Grid** in the export dialog if desired. These snapshots are separate from
the older D2 experiment, `diagram/club.d2`. `scripts/build.sh` only rebuilds
the D2 diagrams; it does not overwrite the editable recreation or its snapshots.


```
icons/          brand logos, normalized to 512x512 SVG (generated)
theme.d2        design system: colours, card/tile/panel/edge classes
diagram/demo.d2 the demo diagram
scripts/        icon fetching, build, grid injection
out/            rendered SVG + PNG
```

## Legacy D2 quickstart

New here? **[GUIDE.md](GUIDE.md)** is the full walkthrough — recipes, layout
rules, customisation, troubleshooting.

```sh
./scripts/icons.sh --all            # fetch + normalize every icon
./scripts/build.sh                  # -> out/demo.svg, out/demo.png
./scripts/build.sh demo             # one diagram
```

`D2=/path/to/d2 ./scripts/build.sh` if `d2` is not on `PATH`.

## Writing a diagram

```d2
...@../theme.d2
direction: right

app: My Stack {
  class: boundary                  # dashed panel = your own boundary
  web: {class: tile; ic: "" {class: tile-icon; icon: ../icons/nextjs.png}; nm: Web {class: tile-name}; sb: Next.js {class: tile-sub}}
  api: {class: tile; ic: "" {class: tile-icon; icon: ../icons/hono.png}; nm: API {class: tile-name}; sb: Hono {class: tile-sub}}

  web -> api: RPC {class: edge}
}
```

| Class | Use |
|---|---|
| `tile` | wrapper; holds the icon card plus caption rows |
| `tile-icon` | the white squircle that holds the logo |
| `tile-name` | bold caption line |
| `tile-sub` | mono sublabel, one size down and muted |
| `panel` | warm tint — third-party / vendor-managed |
| `boundary` | dashed cool tint — your own boundary |
| `cluster` | untinted grouping |
| `edge`, `edge-accent`, `edge-dashed` | connection styles |

Edges attach to the **tile**, not the tile's icon child, so D2 routes them
from the card edge rather than through the caption.

## Icons

`scripts/icons.sh <alias>...` resolves an alias to an svgl.app logo and
re-seats it on a square 512×512 canvas with the artwork in a common inner box,
so a grid of cards reads as evenly weighted. Brand logos arrive trimmed very
differently (`github` 8192×8192 full-bleed, `go` 1656×624, `docker` 192×192).

Output is **normalized SVG by default**:

```sh
./scripts/icons.sh --all                    # icons/*.svg
SVGL_FORMAT=png ./scripts/icons.sh --all    # icons/*.png
```

SVG is the default because it is 5.7× smaller in the rendered output (50 KB vs
288 KB for the demo) and keeps exact colours. Rasterizing with `resvg` turns
`color(display-p3 …)` into **black** — Vite's purple logo becomes a black
parallelogram. librsvg handles it correctly, so if you do build PNGs, prefer
`rsvg-convert` over `resvg`.

PNG remains available for exactly one reason: **`d2 in.d2 out.png` fails with
SVG icons for 10 of the 39 logos.** D2's own rasterizer reuses its SVG
importer, which rejects:

```
<linearGradient> is missing required attribute "gradientUnits"   cloudflare-workers grafana sqlite node
unknown element <mask>                                          nextjs vite
<path> has unsupported style property                           kubernetes
unsupported paint server <radialGradient>                       python supabase
```

Wrapping the logo in an outer `<svg>` does not help — the importer recurses
into nested elements and rejects them the same way (measured: still 29/39).
So if your workflow needs `d2 out.png`, generate PNG icons with
`SVGL_FORMAT=png`. Otherwise stay on SVG and label the D2 source accordingly: SVG
renders fine with any external rasterizer, and `scripts/build.sh` uses
`rsvg-convert`.

Run `./scripts/icons.sh --list` for the alias table. To add an alias, append to
`ALIAS` in `scripts/icons.sh`.

## Background grid

D2's built-in `fill-pattern` options are horizontal stripe sets, not a square
grid. `scripts/grid.py` injects one after render:

```sh
python3 scripts/grid.py out/demo.svg --cell 24 --color "#E9EDF3"
```

It replaces the root background rect with a tint plus a `pattern`-filled
overlay. Idempotent: the pattern is replaced, never duplicated.

## Things that will bite you

All verified against D2 v0.9.0 and current `main`:

- **A markdown label suppresses the shape's own rect.** `label: |md ... |` on a
  node without an explicit `shape:` renders the text and *drops the box*. Set
  `shape: rectangle` (or use the `card`/`tile-icon` classes, which do).
- **One font size per label.** A label's markdown body inherits the node's
  `font-size`; headings and code spans scale relative to it. That is why the
  caption is two separate transparent nodes (`tile-name`, `tile-sub`) instead
  of one markdown label — it is the only way to get bold 13px over mono 10px.
- **Code spans get a pill.** Markdown `` `x` `` renders on theme colour `N6`.
  `theme.d2` overrides `N6` to `transparent`, otherwise every sublabel sits on
  a grey chip.
- **`icon.near` and `label.near` use different vocabularies.** Icons accept
  `center-center`, `top-left`, `outside-top-left`; labels accept
  `bottom-center`, `outside-bottom-center`, etc. Mixing them is a compile
  error, not a fallback.
- **Container icons collide with container labels.** A panel with both an
  `icon:` and a label overlaps them at every `near` combination. Panels here
  are text-only headers.
- **`stroke-width` is an integer 0–15.** `stroke-width: 1.5` is a compile
  error.

## Requirements

`d2`, `rsvg-convert` (librsvg), `resvg` (icon fetching), `curl`, `python3`.
ImageMagick only if you build PNG icons (`SVGL_FORMAT=png`).

```sh
pacman -S d2 librsvg resvg curl python
```

## Troubleshooting

**`could not locate the root background rect`** — `grid.py` matches the root
rect by the inner `<svg class="… d2-svg" viewBox="…">`. If D2 changes that
markup, render once without the grid step (`D2=… d2 diagram/demo.d2 out.svg`)
and inspect the head of the file.

**Edge labels overlap the connector** — D2 puts a label on the straight segment
between two cards and does not reserve space for it. `grid-gap` must exceed the
label's width, which is why the demo uses 96 rather than 26.

**An icon renders as a black blob** — one svgl export (Vite) uses
`color(display-p3 …)` and `resvg` falls back to black. The default SVG icon
path is unaffected; only `SVGL_FORMAT=png` hits this. Rasterize with
`rsvg-convert` instead, or use SVG icons.
