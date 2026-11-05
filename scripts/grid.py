#!/usr/bin/env python3
"""Add a square graph-paper grid behind a D2 SVG.

D2's built-in fill patterns are horizontal stripe sets 5px apart, not a square
grid, so the background is injected here instead of fought for in D2 source.

    python3 scripts/grid.py out/demo.svg [--cell 24] [--color "#E9EDF3"]

Rewrites the file in place and is idempotent: re-running replaces the injected
`<defs>`/rects instead of stacking a second grid. Pass `--strip` to remove the
grid and restore the plain background.
"""
import re
import sys

DEFAULT_CELL = 24
DEFAULT_COLOR = "#E9EDF3"
STROKE = 1.0

PATTERN_ID = "paper-grid"
GRID_RECT_MARK = 'data-grid="paper"'


def parse_args(argv):
    path = None
    cell, color, strip = DEFAULT_CELL, DEFAULT_COLOR, False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--cell":
            cell = int(argv[i + 1])
            i += 2
        elif a == "--color":
            color = argv[i + 1]
            i += 2
        elif a == "--strip":
            strip = True
            i += 1
        elif path is None:
            path = a
            i += 1
        else:
            sys.exit(f"unexpected argument: {a}")
    if path is None:
        sys.exit(__doc__)
    return path, cell, color, strip


def strip_grid(svg):
    """Remove an injected grid, restoring a plain background rect."""
    svg = re.sub(rf'<defs><pattern id="{PATTERN_ID}".*?</defs>', "", svg, flags=re.S)

    base_re = rf'<rect [^>]*{re.escape(GRID_RECT_MARK)}[^>]*?/>'
    base = re.search(base_re, svg)
    if not base:
        return svg

    x = re.search(r'\bx="([^"]+)"', base.group(0)).group(1)
    y = re.search(r'\by="([^"]+)"', base.group(0)).group(1)
    w = re.search(r'\bwidth="([^"]+)"', base.group(0)).group(1)
    h = re.search(r'\bheight="([^"]+)"', base.group(0)).group(1)
    tint = re.search(r'\bfill="([^"]+)"', base.group(0)).group(1)
    plain = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{tint}"/>'

    # Drop the (up to two) injected rects and put the plain one back.
    def repl(m):
        return plain if m.start() == base.start() else ""

    svg = re.sub(rf'<rect [^>]*{re.escape(GRID_RECT_MARK)}[^>]*?/>', repl, svg)
    return svg


def main():
    path, cell, color, strip = parse_args(sys.argv[1:])

    svg = open(path, encoding="utf-8").read()
    had_grid = f'id="{PATTERN_ID}"' in svg
    if strip:
        if not had_grid:
            sys.exit(f"{path}: no grid to strip")
        open(path, "w", encoding="utf-8").write(strip_grid(svg))
        return

    # Always start from the grid-free document so repeated runs converge.
    if had_grid:
        svg = strip_grid(svg)

    # D2's root background rect repeats the inner <svg viewBox> verbatim, which
    # is what identifies it among the hundreds of shape rects.
    m = re.search(
        r'<svg\b[^>]*\bclass="[^"]*\bd2-svg\b[^"]*"[^>]*\bviewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"',
        svg,
    )
    if not m:
        sys.exit(f"{path}: could not locate the inner <svg class=...d2-svg> viewBox")
    vb_x, vb_y, vb_w, vb_h = m.groups()

    root_re = (
        rf'<rect x="{re.escape(vb_x)}" y="{re.escape(vb_y)}" '
        rf'width="{re.escape(vb_w)}" height="{re.escape(vb_h)}" [^>]*?/>'
    )
    root = re.search(root_re, svg)
    if not root:
        sys.exit(f"{path}: could not locate the root background rect")

    tint = re.search(r'fill="(#[0-9a-fA-F]{3,8})"', root.group(0))
    tint = tint.group(1) if tint else "#FFFFFF"

    pattern = (
        f'<defs><pattern id="{PATTERN_ID}" x="{vb_x}" y="{vb_y}" '
        f'width="{cell}" height="{cell}" patternUnits="userSpaceOnUse">'
        f'<path d="M {cell} 0 L 0 0 0 {cell}" fill="none" '
        f'stroke="{color}" stroke-width="{STROKE}"/></pattern></defs>'
    )
    base = (
        f'<rect x="{vb_x}" y="{vb_y}" width="{vb_w}" height="{vb_h}" '
        f'{GRID_RECT_MARK} fill="{tint}"/>'
    )
    overlay = (
        f'<rect x="{vb_x}" y="{vb_y}" width="{vb_w}" height="{vb_h}" '
        f'{GRID_RECT_MARK} fill="url(#{PATTERN_ID})" stroke="none"/>'
    )

    svg = svg[:root.start()] + base + overlay + svg[root.end():]

    # The pattern definition goes right after the element holding the viewBox.
    head_end = m.end()
    close = svg.index(">", head_end - 1) + 1
    svg = svg[:close] + pattern + svg[close:]

    open(path, "w", encoding="utf-8").write(svg)


if __name__ == "__main__":
    main()
