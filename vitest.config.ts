import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    include: [
      "apps/**/*.{test,spec}.ts",
      "packages/**/*.{test,spec}.ts",
      "test/unit/**/*.{test,spec}.ts",
      "test/integration/**/*.{test,spec}.ts",
    ],
    passWithNoTests: true,
    pool: "forks",
    restoreMocks: true,
    testTimeout: 20_000,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
