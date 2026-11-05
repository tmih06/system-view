import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const output = new URL("dist/", root);
await rm(output, { recursive: true, force: true });

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("web/index.html", root))],
  outdir: fileURLToPath(output),
  target: "browser",
  minify: true,
  splitting: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!build.success) throw new Error(build.logs.map(String).join("\n"));

await mkdir(new URL("icons/", output), { recursive: true });
const iconDirectory = fileURLToPath(new URL("icons/", root));
let iconCount = 0;
for await (const name of new Bun.Glob("*.svg").scan(iconDirectory)) {
  await Bun.write(new URL(`icons/${name}`, output), Bun.file(new URL(`icons/${name}`, root)));
  iconCount++;
}
await Bun.write(new URL("schema.json", output), Bun.file(new URL("diagram.schema.json", root)));
// Pages otherwise serves index.html with status 200 for missing icon aliases.
await Bun.write(new URL("404.html", output), Bun.file(new URL("web/404.html", root)));
console.log(`Static site built in dist/ with ${iconCount} SVG icons. Ready for Cloudflare Pages.`);
