import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Multi-entry MV3 build:
//  - popup.html / sidepanel.html / offscreen.html  → HTML pages (Vite handles their <script type=module>)
//  - src/background/index.ts                        → stable "background.js" (ESM service worker)
// Workers are referenced with `new Worker(new URL(..., import.meta.url), { type: "module" })`
// which Vite bundles automatically.
export default defineConfig({
  root: ".",
  base: "./",
  publicDir: "public",
  resolve: { alias: { "@shared": resolve(__dirname, "src/shared") } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome110",
    sourcemap: false,
    minify: "esbuild",
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "popup.html"),
        sidepanel: resolve(__dirname, "sidepanel.html"),
        offscreen: resolve(__dirname, "offscreen.html"),
        background: resolve(__dirname, "src/background/index.ts"),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  worker: {
    format: "es",
    rollupOptions: { output: { entryFileNames: "assets/[name]-[hash].js" } },
  },
});
