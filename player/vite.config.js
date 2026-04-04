import { defineConfig } from "vite";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command }) => ({
  resolve: command === "serve" ? {
    alias: {
      "@libmedia/avplayer": resolve(__dirname, "../node_modules/@libmedia/avplayer/dist/esm/avplayer.js"),
    },
  } : undefined,
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
      external: ["@libmedia/avplayer"],
      output: {
        paths: {
          "@libmedia/avplayer": "/lib/avplayer/avplayer.js",
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ["@libmedia/avplayer"],
  },
}));
