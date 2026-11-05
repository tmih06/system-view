# system-view

Turn a short JSON description of a system into a clear diagram, in the browser.
Write the script on the left, see the laid-out diagram on the right.

No coordinates, no design tools, no server: the browser does the layout.

**[Try it](#run-it-locally)** · [Script format](#script-format) · [Icons](#icons)

## Run it locally

Requires [Bun](https://bun.sh) 1.3 or newer.

```sh
bun install --frozen-lockfile
bun run dev
```

Open the printed URL (it starts at <http://127.0.0.1:3000> and moves to the next
free port if that one is taken). `PORT=3007 bun run dev` picks the port yourself.

## What it does

- **Script on the left, diagram on the right.** Edit the JSON and the diagram
  updates as you type; **Ctrl/Cmd + Enter** forces a re-run.
- **Two-tier captions and brand icons.** Each card shows a logo, a name, and a
  muted subtitle. Icons are local SVG files, so nothing is fetched at runtime.
- **Tinted groups.** Warm, cool, and neutral panels read as regions, and groups
  can nest.
- **Orthogonal connectors.** Wires run along the axes with clean corners and
  never cut through a card.
- **Pan, zoom, and themes.** Drag to pan, scroll to zoom, double-click to fit.
  The light/dark toggle recolours the existing diagram without moving it.
- **Errors are readable.** Invalid JSON shows a plain message under the editor
  and keeps the last good diagram on screen.

The script is not saved automatically — copy it out before you reload.

## Script format

The full schema is in [`diagram.schema.json`](diagram.schema.json), and the
running site serves it at `/schema.json`. A small example:

```json
{
  "title": "My application",
  "direction": "right",
  "groups": [{ "id": "app", "label": "Application", "tone": "cool" }],
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
| `direction` | `right`, `down`, `left`, or `up`; which way the flow reads |
| `groups[]` | Tinted regions, optionally nested with `parent` |
| `groups[].tone` | `warm`, `cool`, or `neutral`; `dashed` outlines the region |
| `nodes[]` | One card each; `group` places it inside a region |
| `nodes[].shape` | `service` (default with an icon), `process`, `decision`, or `terminal` |
| `nodes[].icon` | A local icon name, such as `cloudflare`, `redis`, or `postgresql` |
| `edges[]` | Directed connections between node ids |
| `edges[].kind` | `primary` (blue), `secondary` (grey), or `async` (dashed) |
| `edges[].fromSide` / `toSide` | Pin an end to `north`, `east`, `south`, or `west` |
| `flow` | A preferred main chain; each step must already have a connection |

Layout is automatic. Cycles, parallel connections, self-loops, and disconnected
pieces all work. Dense graphs can still produce crossings: it is automatic
layout, not a promise to reproduce a particular hand-arranged picture.

### Hand-placed diagrams

Set `"layout": "manual"` when you need exact positions — to match a reference
drawing, for example. Every node then needs `x`/`y`, groups need `x`/`y`/`width`/
`height`, and connectors may carry `via` bends, `fromAnchor`/`toAnchor`
attachment points, and `labelAt` label anchors. Manual mode refuses to draw
overlapping cards, a label on top of a card, or two labels on top of each other.

The built-in "Club architecture" example is a manual diagram traced from a
reference image, which is why it reproduces that layout exactly.

## Icons

Brand logos live in [`icons/`](icons) as normalised 512×512 SVGs. A node names
one by alias: `"icon": "redis"`. Icons are drawn as-is, so adding a logo means
dropping an SVG into that folder — no build step, no network call.

## Deploy

The site is fully static. `bun run build` writes `dist/` with the HTML, JS, CSS,
icons, and schema; `bun run preview` serves it through Wrangler.

Cloudflare Pages settings: build command `bun install --frozen-lockfile && bun run build`,
output directory `dist`, and `BUN_VERSION=1.4.4`.

## Contributing

See [CONTEXT.md](CONTEXT.md) for how the project is put together.
