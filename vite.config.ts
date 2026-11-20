import { readFileSync, readdirSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const buildId = Date.now().toString(36);

/** The service worker, with every file the app needs, so it opens on the pitch with no signal. */
const serviceWorker = (): Plugin => ({
  name: "service-worker",
  apply: "build",
  generateBundle(_options, bundle) {
    const built = Object.keys(bundle).filter((f) => !f.endsWith(".map"));
    const logos = readdirSync(new URL("./web/public/logos", import.meta.url)).map((f) => `logos/${f}`);
    const files = [...new Set(["index.html", ...built, "logo.jpg", "hero.jpg", "icon-192.png", "icon-512.png", "manifest.webmanifest", ...logos])];
    const source = readFileSync(new URL("./web/sw-template.js", import.meta.url), "utf8")
      .replaceAll("__BUILD__", buildId)
      .replaceAll("__FILES__", JSON.stringify(files));
    this.emitFile({ type: "asset", fileName: "sw.js", source });
  },
});

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss(), serviceWorker()],
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  build: { outDir: "../dist/web", emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { port: 5173, proxy: { "/api": "http://localhost:3000" } },
});
