/**
 * Verify `dist/` is a complete, self-contained Cloudflare Pages bundle.
 *
 * Why this exists: the Pages deployment serves `dist/` and nothing else, so a
 * build that exits 0 can still ship a broken site — an icon the script refers to
 * but never copied, a missing `404.html` (unknown aliases would then return the
 * app with status 200), or a schema the workspace cannot fetch. This runs after
 * `bun scripts/build.ts` in CI and fails with the specific omission.
 *
 * Run with `bun scripts/check-dist.ts [distDirectory]`.
 */
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const distPath = process.argv[2] ?? fileURLToPath(new URL("dist/", root));
const dist = new URL(`file://${distPath.replace(/\/?$/, "/")}`);
const icons = new URL("icons/", dist);

/** Every file the deployed routes depend on, with the reason it must exist. */
const required = [
  ["index.html", "the workspace page"],
  ["404.html", "unknown icon aliases must 404 instead of returning the app"],
  ["schema.json", "served as /schema.json for agent-facing scripts"],
] as const;

const failures: string[] = [];

for (const [name, reason] of required) {
  if (!(await Bun.file(new URL(name, dist)).exists())) failures.push(`missing ${name} (${reason})`);
}

// The workspace loads every icon as `/icons/<alias>.svg`, so each committed
// icon has to reach the bundle or that card renders without artwork.
const committed: string[] = [];
for await (const name of new Bun.Glob("*.svg").scan(fileURLToPath(new URL("icons/", root)))) committed.push(name);
const bundled: string[] = [];
for await (const name of new Bun.Glob("*.svg").scan(fileURLToPath(icons))) bundled.push(name);

if (bundled.length !== committed.length) {
  failures.push(`icons/ has ${bundled.length} SVG files in dist but ${committed.length} are committed`);
}
const bundledSet = new Set(bundled);
for (const name of committed) {
  if (!bundledSet.has(name)) failures.push(`missing dist/icons/${name}`);
}

// The page must reference a hashed script bundle; an HTML-only build would
// otherwise look complete while rendering an empty workspace.
const html = await Bun.file(new URL("index.html", dist)).text();
if (!/<script[^>]+src="\.\/[^"]+\.js"/.test(html)) failures.push("index.html does not reference a built script bundle");
if (!/<link[^>]+href="\.\/[^"]+\.css"/.test(html)) failures.push("index.html does not reference a built stylesheet");

// The schema ships to clients verbatim, so it has to stay parseable JSON.
try {
  const schema = await Bun.file(new URL("schema.json", dist)).json();
  if (schema?.type !== "object") failures.push("schema.json does not describe an object root");
} catch (cause) {
  failures.push(`schema.json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
}

if (failures.length > 0) {
  console.error("dist/ verification failed:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`dist/ verified: ${required.length} routes, ${bundled.length} icons, schema parseable.`);
