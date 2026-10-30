import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["worker/**/*.test.ts", "src/**/*.test.ts", "shared/**/*.test.ts"],
    maxWorkers: 4,
    fileParallelism: false,
  },
});
