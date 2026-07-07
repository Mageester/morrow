import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist-pkg/**", "node_modules/**"],
  },
});
