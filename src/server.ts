import home from "../web/index.html";

const iconDirectory = new URL("../icons/", import.meta.url);
const options = {
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": home,
    "/schema.json": () => new Response(Bun.file(new URL("../diagram.schema.json", import.meta.url)), {
      headers: { "Content-Type": "application/schema+json; charset=utf-8" },
    }),
    "/icons/:name": async (request) => {
      const name = request.params.name;
      if (!/^[a-z0-9-]+\.svg$/.test(name)) return new Response("Invalid icon name", { status: 400 });
      const file = Bun.file(new URL(name, iconDirectory));
      if (!(await file.exists())) return new Response(`Unknown icon: ${name}`, { status: 404 });
      return new Response(file, {
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  },
  fetch() {
    return new Response("Not found", { status: 404 });
  },
} satisfies Bun.Serve.Options<undefined>;

function startServer() {
  for (;;) {
    try {
      return Bun.serve(options);
    } catch (error) {
      if (
        process.env.NODE_ENV === "production" ||
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EADDRINUSE" ||
        options.port >= 65535
      ) throw error;
      console.warn(`Port ${options.port} is in use; trying ${options.port + 1}.`);
      options.port++;
    }
  }
}

const server = startServer();

console.log(`Diagram Studio listening on ${server.url}`);
