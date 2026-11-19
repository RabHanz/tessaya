import type { Plugin } from "vite-plus";

/**
 * The body playground page (served by the server at /tessaya/playground) loads two fixed-name scripts that only a
 * build writes. In dev each one is a module that imports its source entry, so the page runs on `vp run dev` too.
 */
const ENTRIES: Readonly<Record<string, string>> = {
  "/assets/tessaya-body.js": "/src/body/entry.ts",
  "/assets/tessaya-playground.js": "/src/body/playground.ts",
};

export function tessayaBodyDevPlugin(): Plugin {
  return {
    name: "tessaya-body-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const entry = ENTRIES[(req.url ?? "").split("?")[0] ?? ""];
        if (entry === undefined) return next();
        res.setHeader("content-type", "text/javascript; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(`import ${JSON.stringify(entry)};\n`);
      });
    },
  };
}
