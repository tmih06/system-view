import { expect, onTestFinished, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("development server selects an available port without replacing the occupied listener", async () => {
  const occupied = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("occupied", { status: 503 }),
  });
  const port = occupied.port!;
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "development" },
    stdout: "pipe",
    stderr: "pipe",
  });
  onTestFinished(async () => {
    child.kill();
    await child.exited;
    occupied.stop(true);
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let address: RegExpExecArray | null = null;
  while (!address) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`Server did not start: ${output}\n${await new Response(child.stderr).text()}`);
    output += decoder.decode(chunk.value, { stream: true });
    address = /listening on (http:\/\/\S+)/.exec(output);
  }
  reader.releaseLock();
  const url = new URL(address[1]);
  expect(url.hostname).toBe("127.0.0.1");
  expect(Number(url.port)).toBeGreaterThan(port);
  expect((await fetch(new URL("/schema.json", url))).status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(503);
}, 10000);
