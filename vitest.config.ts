import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    include: [
      "apps/**/*.{test,spec}.ts",
      "packages/**/*.{test,spec}.ts",
      "test/unit/**/*.{test,spec}.ts",
    ],
    passWithNoTests: true,
    pool: "forks",
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
