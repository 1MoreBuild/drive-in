import { defineConfig } from "vite";

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
  build: { outDir: "dist" },
});
