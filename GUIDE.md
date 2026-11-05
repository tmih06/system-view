# Guide

Everything here was run against D2 v0.9.0. Start with [Five minutes](#five-minutes),
then read the recipe you need.

- [Setup](#setup)
- [Five minutes](#five-minutes)
- [The two node recipes](#the-two-node-recipes)
- [Panels](#panels)
- [Edges](#edges)
- [Icons](#icons)
- [Rendering](#rendering)
- [Customising the look](#customising-the-look)
- [Recipes](#recipes)
- [Troubleshooting](#troubleshooting)

---

## Setup

```sh
pacman -S d2 librsvg resvg curl python
```

`d2` must be ≥ 0.9.0 (`d2 --version`). If it is not on `PATH`, every command
below accepts `D2=/path/to/d2`:

```sh
D2=~/.local/opt/d2/prefix/bin/d2 ./scripts/build.sh
```

Fetch the icon set once:

```sh
./scripts/icons.sh --all      # ~30s, writes icons/*.svg
```

---

## Five minutes

Create `diagram/hello.d2`:

```d2
...@../theme.d2
direction: right

web: {class: card; icon: ../icons/nextjs.svg; label: |md
  **Web**

  `Next.js`
|}
api: {class: card; icon: ../icons/hono.svg; label: |md
  **API**

  `Hono`
|}

web -> api: RPC {class: edge}
```

Build it:

```sh
./scripts/build.sh hello
# -> out/hello.svg, out/hello.png
```

Three things to notice:

1. `...@../theme.d2` imports the design system. The `...@` (three dots) is D2's
   "import and merge" verb — it must be **three dots**, not two. It is one more
   than the `..` path prefix, which catches everyone once.
2. `icon:` paths are resolved relative to `theme.d2`'s directory only when the
   icon lives in an imported file. Here it is relative to the `.d2` file.
3. `{class: edge}` on the connection is what gives it the muted grey styling
   and the non-italic label.

---

## The two node recipes

Both render a logo with a bold name and a mono sublabel. They differ in whether
the caption sits **inside** or **below** the card.

### `card` — caption inside the box

```d2
a: {class: card; icon: ../icons/redis.svg; label: |md
  **Cache**

  `Redis`
|}
```

- Fixed 116×132, radius 22, 12px caption.
- Use when every node has a similar label length, or when the diagram should
  stay compact.

### `tile` — caption below the box

```d2
a: {
  class: tile
  ic: "" {class: tile-icon; icon: ../icons/redis.svg}
  nm: Cache {class: tile-name}
  sb: Redis {class: tile-sub}
}
```

- Three stacked rows: icon card, bold 13px name, mono 10px sublabel.
- This is what the reference design uses. It lets the caption be wider than the
  card without clipping.
- `ic`, `nm`, `sb` are arbitrary names — only the class matters. `label: ""`
  on `tile` suppresses the wrapper's own label, so keep it.
- **Connect tile to tile** (`a -> b`), not `a.ic -> b.ic` — see [Edges](#edges).

`card-small` is a 92×108 version of `card` for dense grids.

---

## Panels

Wrap nodes in a container and add a class:

```d2
edge: Cloudflare {          # `edge` is a reserved word — name carefully
  class: panel              # warm tint, solid border
  worker: {class: card-small; icon: ../icons/cloudflare-workers.svg; label: |md
    **Worker**

    `runtime`
  |}
}
```

| Class | Look | Means |
|---|---|---|
| `panel` | warm cream, solid tan border | third-party / vendor-managed |
| `boundary` | pale blue, dashed border | your own boundary |
| `cluster` | no fill, no border, grey label | untinted grouping |

Labels sit at the panel's top-left and overlap its border slightly — that is
D2's `label.near: top-left` behaviour, not a bug.

**Panel names cannot be D2 keywords.** These fail as a node key:

```
style  label  shape  direction  left  top  width  height  tooltip
grid-columns  grid-rows  icon
```

These are fine (verified): `edge  class  right  note  near  link  app`.

The error looks like `unexpected text after map`, `reserved keywords are
prohibited`, or a type error such as `non-integer height`. Quoting fixes it —
`"left": {...}` works — otherwise pick another word.

### Grids inside panels

```d2
p: My App {
  class: panel
  grid-columns: 2     # forces a 2-wide grid
  grid-gap: 96
  a: {class: card-small; ...}
  b: {class: card-small; ...}
  c: {class: card-small; ...}
  d: {class: card-small; ...}
}
```

`grid-columns` / `grid-rows` make the container a fixed grid. Without them D2
uses the layout engine's own flow (`tala` here).

**`grid-gap` must exceed your widest edge label** — D2 does not reserve space
for connection labels, so a 26px gap puts `write` on top of the arrow. The demo
uses 96.

---

## Edges

```d2
a -> b: RPC {class: edge}
a -> b: read {class: edge-dashed}
a -> b: HTTPS {class: edge-accent}
a -> b                        # no class = D2 defaults, blue
```

| Class | Look |
|---|---|
| `edge` | 1px `#B4BECC`, 10px grey label, not italic |
| `edge-dashed` | same, dashed |
| `edge-accent` | 1px `#2563EB` blue, blue label |

`italic: false` is set explicitly in every edge class because D2 renders edge
labels in italic by default, which clashes with the rest of the type.

To draw an edge from a card inside a panel to one in another panel, use the
full path:

```d2
app.api -> edge.worker: HTTPS {class: edge-accent}
```

With `tile` nodes, connect the **tiles**:

```d2
web -> api        # right: leaves from the card's edge
web.ic -> api.ic  # wrong: cuts straight through both captions
```

---

## Icons

```sh
./scripts/icons.sh --list              # show all aliases
./scripts/icons.sh redis postgresql    # fetch two
./scripts/icons.sh --all               # fetch every alias
```

Then reference them from a diagram:

```d2
a: {class: card; icon: ../icons/redis.svg; ...}
```

Icons are normalized: trimmed, then re-seated on a 512×512 canvas with the
artwork in a 384px inner box, so logos with wildly different cropping
(`github` 8192² full-bleed vs `go` 1656×624) read as evenly weighted in a grid.

### Adding a logo svgl.app has but the script does not

Append to `ALIAS` in `scripts/icons.sh`:

```bash
[fly]="Fly.io"
```

The value must match svgl's `title` field exactly
(`curl -s https://api.svgl.app | python3 -m json.tool | grep '"title"'`).

### Adding a logo svgl.app does not have

Drop a file into `icons/` yourself. Any of `.svg`, `.png` work; keep it square
and roughly 512px so it matches the others.

### PNG instead of SVG

Only needed if you must run `d2 in.d2 out.png` directly — D2's own rasterizer
rejects 10 of the 39 logos as SVG (see [Rendering](#rendering)).

```sh
SVGL_FORMAT=png ./scripts/icons.sh --all
sed -i 's|icons/\([a-z-]*\)\.svg|icons/\1.png|g' diagram/*.d2
```

**Both steps are required.** The script writes `icons/x.png` and deletes
`icons/x.svg`, but your `.d2` files still say `.svg` — nothing rewrites them for
you. Forgetting the `sed` gives you a compile error about a missing file, or
worse, silently stale icons if both files exist.

To go back to SVG:

```sh
./scripts/icons.sh --all
sed -i 's|icons/\([a-z-]*\)\.png|icons/\1.svg|g' diagram/*.d2
```

---

## Rendering

### The supported path

```sh
./scripts/build.sh            # every diagram/*
./scripts/build.sh demo       # one, by base name
SCALE=3 ./scripts/build.sh    # 3x PNG
```

It runs three steps:

1. `d2 diagram/x.d2 out/x.svg`
2. `python3 scripts/grid.py out/x.svg` — injects the graph-paper background
3. `rsvg-convert -z 2 out/x.svg out/x.png`

Everything after step 1 is optional. Plain `d2 diagram/x.d2 out/x.svg` gives you
the diagram without the grid, and is perfectly valid.

### Live preview

```sh
d2 --watch --browser 0 diagram/demo.d2 /tmp/preview.svg
# -> http://127.0.0.1:PORT, reloads on save
```

`--browser 0` stops D2 opening a browser. Note this path skips the grid, so the
preview will not show the background.

### Grid options

```sh
python3 scripts/grid.py out/x.svg --cell 32 --color "#DDE3EC"
python3 scripts/grid.py out/x.svg --strip      # remove it again
```

Default is 24px cells in `#E9EDF3`. The step is idempotent — re-running replaces
the grid rather than stacking a second one.

### PNG without the script

```sh
d2 diagram/demo.d2 out.svg
rsvg-convert -z 2 -o out.png out.svg
```

Use `rsvg-convert`, not `resvg`: `resvg` renders `color(display-p3 …)` as black,
which breaks Vite's logo.

---

## Customising the look

Everything visual lives in `theme.d2`. Edit it and rebuild.

### Colours

The `theme-overrides` block maps D2's palette onto Tailwind-ish slate values:

| Key | Used for | Default |
|---|---|---|
| `B1` | connection strokes, borders | `#B4BECC` |
| `B2` | edge label text | `#7A8697` |
| `N1` | primary text | `#16202E` |
| `N2` | secondary text | `#7A8697` |
| `N6` | markdown code-span pill | `transparent` |
| `N7` | page background | `#FFFFFF` |

**Leave `N6: transparent`.** Markdown `` `code` `` renders on `N6`; any other
value puts a grey chip behind every sublabel.

### Card size and shape

```d2
card: {
  width: 116      # change both to resize
  height: 132
  style: {
    border-radius: 22
    stroke: "#E4E8EE"
    font-size: 12   # controls the caption; the mono line is 0.85x of this
  }
}
```

### Adding your own class

```d2
classes: {
  card-danger: {
    shape: rectangle
    width: 116
    height: 132
    icon.near: top-center
    label.near: bottom-center
    style: {fill: "#FEF2F2"; stroke: "#FCA5A5"; border-radius: 22; font-size: 12}
  }
}
```

`shape: rectangle` is required whenever the label is markdown — without it D2
drops the card's rect entirely.

---

## Recipes

### A logo with only a name, no sublabel

```d2
a: {class: card; icon: ../icons/redis.svg; label: Redis}
```

### A sublabel without the mono treatment

Markdown `` `code` `` is what makes it mono, but a two-line markdown label
**clips instead of wrapping** — even on a 160px-wide card, `ephemeral store`
is cut off at the card edge. Do not use markdown for the sublabel.

Define a sans-serif variant of the tile sublabel and use the `tile` recipe:

```d2
...@../theme.d2

classes: {
  tile-sub-sans: {
    width: 132
    height: 15
    label.near: center-center
    style: {fill: transparent; stroke: transparent; stroke-width: 0; font-size: 10; font-color: "#7A8697"}
  }
}

a: {
  class: tile
  ic: "" {class: tile-icon; icon: ../icons/redis.svg}
  nm: Cache {class: tile-name}
  sb: ephemeral store {class: tile-sub-sans}
}
```

`tile` nodes are real text nodes, so labels size to their content and never
clip. Keep `width` on the sublabel at or above the longest string you expect.

### Two panels side by side

`direction: right` does **not** do this. With `direction: right` and a
cross-panel edge the panels still stack vertically, on all three layout engines
(tala, elk, dagre — verified). Use explicit coordinates:

```d2
app: My App {
  class: boundary
  top: 0
  left: 0
  api: {class: card-small; icon: ../icons/hono.svg; label: API}
}
cf: Cloudflare {
  class: panel
  top: 0
  left: 260      # panel width + gap
  worker: {class: card-small; icon: ../icons/cloudflare-workers.svg; label: Worker}
}
app.api -> cf.worker: HTTPS {class: edge-accent}
```

`top`/`left` pin each panel's top-left corner and D2 lays out the contents
inside. Leave at least the panel's width between `left` values or they overlap.
Any node that should participate in normal flow must not have `top`/`left`.

### Long edge label

Labels do not wrap. Either shorten the text or widen the gap between the nodes
it connects (`grid-gap`, or `width:` on the cards).

---

## Troubleshooting

**`unexpected text after map` / `reserved keywords are prohibited`**
The node name is a D2 keyword. See the list under [Panels](#panels). Quote it
or rename it.

**`icon.near` → `invalid "near" field`**
Icons and labels use different vocabularies:

| | values |
|---|---|
| `icon.near` | `top-left` `top-center` … `center-center` … `outside-top-left` … |
| `label.near` | `top-left` `top-center` … `bottom-center` … `outside-bottom-center` … |

`outside-top-left` is valid for `icon.near` but **not** for `label.near`.

**The card renders with no border**
The label is markdown and `shape:` is missing. Add `shape: rectangle`, or use
`card` / `tile-icon`, which set it.

**A grey chip appears behind the sublabel**
`N6` in `theme.d2` is no longer `transparent`. Restore it.

**The sublabel is the same size as the name**
Both are in one label. Split them into two nodes (`tile`), or accept the single
size — one markdown label has exactly one font size.

**A markdown sublabel is cut off at the card edge**
Markdown labels do not wrap and are clipped rather than overflowing. Use the
`tile` recipe with a plain-text sublabel (see
[A sublabel without the mono treatment](#a-sublabel-without-the-mono-treatment)).

**Edge label sits on top of the arrow**
`grid-gap` is smaller than the label. Raise it (96 works for `write`/`send`).

**`failed to bundle ../icons/x.svg`**
The path is wrong. Paths in an `.d2` file are relative to that file; paths in
`theme.d2` are relative to `theme.d2`. From `diagram/`, icons are `../icons/`.

**`failed to compile: scene: shape "x" SVG asset: … <linearGradient> missing gradientUnits`**
You ran `d2 … out.png` with SVG icons. Either build via `scripts/build.sh`, or
switch to `SVGL_FORMAT=png ./scripts/icons.sh --all`.

**`could not locate the root background rect`**
`grid.py` matches D2's inner `<svg class="… d2-svg" viewBox="…">`. If D2 changes
that markup, render without the grid step and inspect the file head.
