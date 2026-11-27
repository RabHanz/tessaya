import { defineConfig } from "astro/config";

// See apps/marketing/astro.config.mjs: keeps `vp run` env out of the typecheck task cache.
delete process.env.VP_RUN_NODE_CLIENT_PATH;

// The domain is a setting, never written here: canonical and social links appear only when it is set.
export default defineConfig({
  site: process.env.TESSAYA_SITE_URL || undefined,
  base: process.env.TESSAYA_SITE_BASE || "/",
  trailingSlash: "ignore",
  server: { port: Number(process.env.PORT ?? 4174) },
});
