import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["worker/**/*.test.ts", "src/**/*.test.ts", "shared/**/*.test.ts"],
    maxWorkers: 4,
    fileParallelism: false,
  },
});
