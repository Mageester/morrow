import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webPort = process.env.VITE_PORT ? parseInt(process.env.VITE_PORT) : 4318;

/**
 * Which port the orchestrator is listening on, for the dev proxy. The
 * orchestrator reads the same `PORT`, so honouring it here keeps the two ends
 * of `pnpm dev:app` in agreement.
 *
 * The one value it must refuse is the dev server's own port. `PORT` is a
 * conventional name for "the port THIS process should listen on", so process
 * managers, container runtimes and editor task runners all set it — and when
 * it happens to name the Vite port, proxying `/api` to it points the dev
 * server at itself and every API call fails as an opaque 502.
 */
function apiPort(): number {
  const inherited = Number(process.env.PORT);
  if (Number.isInteger(inherited) && inherited > 0 && inherited !== webPort) return inherited;
  return 4317;
}

export default defineConfig({
  base: "/app/",
  plugins: [react()],
  server: {
    port: webPort,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort()}`,
      },
    },
  },
});
