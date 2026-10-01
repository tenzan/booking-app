import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// Type-checking runs with the Workers types only (no Node types), so these Node modules are loaded untyped here.
const { readFileSync } = (await import("node:fs" as string)) as { readFileSync: (path: URL) => Uint8Array };
const { fileURLToPath } = (await import("node:url" as string)) as { fileURLToPath: (url: URL) => string };

/**
 * Serves docs/sample-customers.csv (the one copy, also read by `npm run seed` and linked from the docs) at
 * /samples/customers.csv: from the dev server, and as a static asset in the client build. No duplicate under public/.
 */
function sampleCustomersCsv(): Plugin {
  const source = new URL("./docs/sample-customers.csv", import.meta.url);
  const path = "/samples/customers.csv";
  return {
    name: "sample-customers-csv",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const { url, method } = req as unknown as { url?: string; method?: string };
        if (url?.split("?")[0] !== path || (method !== "GET" && method !== "HEAD")) return next();
        const body = readFileSync(source);
        res.setHeader("content-type", "text/csv; charset=utf-8");
        res.setHeader("content-length", String(body.byteLength));
        res.end(method === "HEAD" ? undefined : body);
      });
    },
    buildStart() {
      // `vite build --watch` rebuilds when the sample changes.
      this.addWatchFile(fileURLToPath(source));
    },
    generateBundle() {
      // Only the SPA's assets; the worker bundle has no use for it.
      if (this.environment.name !== "client") return;
      this.emitFile({ type: "asset", fileName: path.slice(1), source: readFileSync(source) });
    },
  };
}

export default defineConfig({
  plugins: [sampleCustomersCsv(), react(), tailwindcss(), cloudflare()],
  environments: {
    client: {
      // Pre-bundle every package the SPA imports up front. Otherwise Vite discovers some only after the first page
      // load, re-optimizes mid-session and the browser can end up with two copies of React (invalid hook call).
      optimizeDeps: {
        include: [
          "react",
          "react-dom",
          "react-dom/client",
          "react/jsx-runtime",
          "react/jsx-dev-runtime",
          "react-router",
          "@tanstack/react-query",
          "@date-fns/tz",
        ],
      },
    },
  },
});
