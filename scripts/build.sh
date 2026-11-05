#!/usr/bin/env bash
# Render every diagram/*.d2 to out/<name>.svg and out/<name>.png.
#
#   ./scripts/build.sh                 # all diagrams
#   ./scripts/build.sh demo            # one diagram, by base name
#
# PNG export goes through D2's own SVG output plus rsvg-convert instead of
# `d2 ... out.png`: D2's native rasterizer refuses several SVG icon exports
# and drops <clipPath> content. Going SVG-first keeps both outputs identical.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D2="${D2:-d2}"
scale="${SCALE:-2}"
grid_cell="${GRID_CELL:-24}"
grid_color="${GRID_COLOR:-#E9EDF3}"

command -v "$D2" >/dev/null || {
  cat >&2 <<'MSG'
error: d2 not found.

  curl -fsSL https://d2lang.com/install.sh | sh -s --
  # or
  go install github.com/d2lang/d2@latest

Point D2=... at a specific binary if it is not on PATH.
MSG
  exit 1
}
command -v rsvg-convert >/dev/null || {
  echo "error: rsvg-convert is required (pacman -S librsvg)" >&2
  exit 1
}

mkdir -p "$root/out"

targets=()
if [[ $# -gt 0 ]]; then
  for name in "$@"; do targets+=("$root/diagram/$name.d2"); done
else
  shopt -s nullglob
  targets=("$root/diagram"/*.d2)
fi

for src in "${targets[@]}"; do
  [[ -f "$src" ]] || { echo "error: no such diagram: $src" >&2; exit 1; }
  name="$(basename "$src" .d2)"
  svg="$root/out/$name.svg"
  png="$root/out/$name.png"

  "$D2" "$src" "$svg"
  python3 "$root/scripts/grid.py" "$svg" --cell "$grid_cell" --color "$grid_color"
  rsvg-convert -z "$scale" -o "$png" "$svg"
  printf '  %-24s %s\n' "$name" "out/$name.{svg,png}"
done
