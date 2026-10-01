import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
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
