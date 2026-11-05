#!/usr/bin/env bash
# Resolve svgl.app logos into icons/ as normalized SVG (default) or PNG.
#
#   ./scripts/icons.sh cloudflare-workers redis sqlite nextjs hono
#   ./scripts/icons.sh --all              # every alias below
#   ./scripts/icons.sh --list             # show the alias table
#   SVGL_FORMAT=png ./scripts/icons.sh --all
#
# SVGL_RASTER (default 1024) bounds the intermediate PNG width. Keep it above
# the 512px output so trimming stays sharp.
#
# Why normalize at all: brand logos ship trimmed very differently (github
# 8192x8192 full-bleed, go 1656x624, docker 192x192). Each is re-seated on a
# 512x512 canvas with the artwork trimmed and scaled into a common inner box,
# so a grid of cards reads as evenly weighted.
#
# Why SVG by default:
#   * 5.7x smaller output (50 KB vs 288 KB for the demo diagram).
#   * Exact colours. Rasterizing with resvg turns `color(display-p3 ...)`
#     into BLACK (Vite's purple logo becomes a black parallelogram).
#   * Resolution independent.
# PNG stays available for one case: `d2 in.d2 out.png` uses D2's own SVG
# importer, which rejects 10 of these 39 logos (<mask>, <filter>, gradients
# without gradientUnits). PNG input makes that path work.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
icons="$root/icons"
api="https://api.svgl.app"
format="${SVGL_FORMAT:-svg}"
canvas="${SVGL_CANVAS:-512}"
inner="${SVGL_INNER:-384}"
raster="${SVGL_RASTER:-1024}"

# alias -> "slug|svgl title". An empty svgl title means svgl has no entry and
# the fallback catalogs in EXTRA_ICONS are used with `slug`.
declare -A ALIAS=(
  [cloudflare]="cloudflare|Cloudflare"
  [cloudflare-workers]="cloudflareworkers|Cloudflare Workers"
  [cloudflare-pages]="cloudflarepages|"
  [hono]="hono|Hono"
  [nextjs]="nextjs|Next.js"
  [nuxt]="nuxt|Nuxt"
  [nitro]="nitro|"
  [svelte]="svelte|Svelte"
  [astro]="astro|Astro"
  [vite]="vite|Vite"
  [deno]="deno|Deno"
  [bun]="bun|Bun"
  [node]="node|Node.js"
  [go]="go|Go"
  [rust]="rust|Rust"
  [python]="python|Python"
  [docker]="docker|Docker"
  [kubernetes]="kubernetes|Kubernetes"
  [terraform]="terraform|Terraform"
  [nginx]="nginx|Nginx"
  [traefik]="traefik|"
  [dokploy]="dokploy|"
  [redis]="redis|Redis"
  [postgresql]="postgresql|PostgreSQL"
  [sqlite]="sqlite|SQLite"
  [mysql]="mysql|MySQL"
  [garage]="garage|"
  [rustfs]="rustfs|"
  [wireguard]="wireguard|"
  [prisma]="prisma|Prisma"
  [supabase]="supabase|Supabase"
  [typesense]="typesense|Typesense"
  [github]="github|GitHub"
  [gitlab]="gitlab|GitLab"
  [github-actions]="githubactions|"
  [vercel]="vercel|Vercel"
  [netlify]="netlify|Netlify"
  [grafana]="grafana|Grafana"
  [sentry]="sentry|Sentry"
  [stripe]="stripe|Stripe"
  [resend]="resend|Resend"
  [clerk]="clerk|Clerk"
  [discord]="discord|Discord"
  [google]="google|Google"
  [google-analytics]="googleanalytics|"
  [tauri]="tauri|Tauri"
  [android]="android|Android"
  [apple]="apple|Apple"
  [windows]="windows|Windows"
  [webhook]="webhook|"
  [turnstile]="shield-check|"
  [server]="server|"
  [database]="database|"
  [hard-drive]="hard-drive|"
  [image]="image|"
  [shield-check]="shield-check|"
)


usage() {
  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "Aliases:"
  for k in $(printf '%s\n' "${!ALIAS[@]}" | sort); do
    printf '  %-18s %s\n' "$k" "${ALIAS[$k]#*|}"
  done
}

[[ $# -eq 0 ]] && { usage; exit 1; }
for bin in curl resvg python3; do
  command -v "$bin" >/dev/null ||
    { echo "error: '$bin' is required (pacman -S $bin)" >&2; exit 1; }
done
if [[ "$format" == png ]]; then
  command -v magick >/dev/null ||
    { echo "error: 'magick' is required for PNG output (pacman -S imagemagick)" >&2; exit 1; }
fi

mkdir -p "$icons"
cache="$icons/.svgl.json"
[[ -s "$cache" ]] || curl -fsS "$api" -o "$cache"

# Resolve an alias to a URL. svgl is tried first (best brand coverage for
# software), then the other keyless, license-free catalogs. Each fallback
# exists because svgl has no entry for that product.
EXTRA_ICONS=(
  # selfhst/icons  (CC0)          homarr-labs/dashboard-icons (Apache-2.0)
  "https://cdn.jsdelivr.net/gh/selfhst/icons@main/svg/%s.svg"
  "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons@main/svg/%s.svg"
  # Simple Icons (CC0)            lucide (ISC, stroke pictograms)
  "https://cdn.simpleicons.org/%s"
  "https://cdn.jsdelivr.net/npm/lucide-static@latest/icons/%s.svg"
)

lookup() {
  local title="$1" slug="$2"
  local url
  if url="$(lookup_svgl "$title")"; then
    printf '%s\n' "$url"
    return 0
  fi
  for tmpl in "${EXTRA_ICONS[@]}"; do
    url="${tmpl/\%s/$slug}"
    if curl -fsS -o /dev/null --max-time 20 "$url"; then
      printf '%s\n' "$url"
      return 0
    fi
  done
  return 3
}

# title -> url, preferring the plain single-route entry over light/dark pairs
lookup_svgl() {
  python3 - "$cache" "$1" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
want = sys.argv[2].strip().lower()
for entry in data:
    if entry["title"].strip().lower() != want:
        continue
    route = entry["route"]
    print(route if isinstance(route, str) else (route.get("light") or route.get("dark")))
    sys.exit(0)
sys.exit(3)
PY
}

# Wrap the logo in a square canvas. The root <svg> keeps every attribute that
# carries paint inheritance (`fill=`, `style=`) and full <defs>; only the
# geometry attributes are replaced. Dropping them is what previously turned
# Docker's blue logo black and clipped Python's gradient.
to_svg() {
  python3 - "$1" "$2" "$canvas" "$inner" <<'PY'
import re, subprocess, sys

src, dst, canvas, inner = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
doc = open(src, encoding="utf-8").read()

# The source viewBox defines user space. Do NOT use `resvg --query-bbox` here:
# it reports the ink box in the *rendered viewport* (e.g. 256px) rather than in
# source user units (e.g. viewBox="100 100 312 312"), which silently clips.
m = re.search(r'viewBox="([^"]+)"', doc)
if m:
    vb = m.group(1).strip()
else:
    w = re.search(r'\\bwidth="([\\d.]+)', doc)
    h = re.search(r'\\bheight="([\\d.]+)', doc)
    vb = f"0 0 {w.group(1)} {h.group(1)}" if w and h else f"0 0 {canvas} {canvas}"

m = re.search(r"<svg\b[^>]*>", doc, re.S)
if not m:
    sys.exit(f"{src}: no root <svg> element")
tag = m.group(0)

# Placement is decided by the wrapper, so these must not be inherited.
for attr in ("width", "height", "viewBox", "preserveAspectRatio", "x", "y"):
    tag = re.sub(r'\s+%s="[^"]*"' % attr, "", tag)
tag = tag[:-1] + (f' x="{(canvas-inner)//2}" y="{(canvas-inner)//2}"'
                  f' width="{inner}" height="{inner}" viewBox="{vb}"'
                  f' preserveAspectRatio="xMidYMid meet">')

out = (f'<svg xmlns="http://www.w3.org/2000/svg" '
       f'xmlns:xlink="http://www.w3.org/1999/xlink" '
       f'width="{canvas}" height="{canvas}" viewBox="0 0 {canvas} {canvas}">'
       + tag + doc[m.end():] + "</svg>")
open(dst, "w", encoding="utf-8").write(out)
PY
}

to_png() {
  magick "$1" \
    -background none -bordercolor none -border 2 \
    -trim +repage -resize "${inner}x${inner}" \
    -gravity center -background none -extent "${canvas}x${canvas}" \
    "PNG32:$2"
}

fetch_one() {
  local name="$1"
  local spec="${ALIAS[$name]:-}"
  if [[ -z "$spec" ]]; then
    echo "error: unknown alias '$name' (see --list)" >&2
    return 1
  fi
  local slug="${spec%%|*}" title="${spec#*|}"
  local url
  if ! url="$(lookup "$title" "$slug")"; then
    echo "error: no source has '$name' (slug '$slug')" >&2
    return 1
  fi

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  curl -fsS "$url" -o "$tmp/raw.svg"

  if [[ "$format" == png ]]; then
    # Bound the raster to a fixed pixel width. `resvg -z 8` multiplies the
    # viewBox, and svgl logos range from 192px to 1800px wide: Resend at
    # 1800x1800 becomes a 14400x14400 (207 MP) PNG, which then OOM-kills
    # ImageMagick during normalization. Width-bounded rendering is ~140x
    # faster and produces the same 512px result.
    resvg -w "$raster" "$tmp/raw.svg" "$tmp/raw.png" 2>/dev/null ||
      resvg -w "$raster" "$tmp/raw.svg" "$tmp/raw.png"
    to_png "$tmp/raw.png" "$icons/$name.png"
    rm -f "$icons/$name.svg"      # never leave both: .d2 refs would go stale
  else
    to_svg "$tmp/raw.svg" "$icons/$name.svg"
    rm -f "$icons/$name.png"
  fi
  printf '  %-18s <- %s\n' "$name" "$url"
}

case "${1:-}" in
  --list|--help|-h) usage ;;
  --all)
    for name in $(printf '%s\n' "${!ALIAS[@]}" | sort); do
      fetch_one "$name" || true
    done
    ;;
  *)
    for name in "$@"; do fetch_one "$name"; done
    ;;
esac
