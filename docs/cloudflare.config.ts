import { defineConfig } from "cf/config";

// Assets-only Worker: the Docs workflow deploys the built site with `cf deploy .vitepress/dist`.
export default defineConfig({
  worker: {
    name: "proxdesk-docs",
    compatibilityDate: "2026-11-26",
    domains: ["proxdesk.b3yond.ai"],
    assets: {
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "404-page",
    },
  },
});
