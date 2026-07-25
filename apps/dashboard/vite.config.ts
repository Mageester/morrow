import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  plugins: [react()],
  server: {
    // 4317 orchestrator, 4318 apps/web, 8787 hosted-api local wrangler dev.
    port: 4322,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
      },
    },
  },
});
