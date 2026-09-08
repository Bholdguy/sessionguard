import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/rules/**", "src/state/pnl.ts", "src/state/ledger.ts"],
    },
  },
});
