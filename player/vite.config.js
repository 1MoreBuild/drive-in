import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
    proxy: {
      "/ws": {
        target: "ws://localhost:9090",
        ws: true,
      },
      "/api": {
        target: "http://localhost:9090",
      },
      "/lib": {
        target: "http://localhost:9090",
      },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        player: resolve(__dirname, "index.html"),
        diagnostics: resolve(__dirname, "diag.html"),
        metrics: resolve(__dirname, "metrics.html"),
      },
    },
  },
});
