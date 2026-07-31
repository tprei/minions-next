import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const restrictedImports = (...patterns) => [
  "error",
  {
    patterns: patterns.map((group) => ({ group })),
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/coverage/**",
      "**/dist/**",
      "**/node_modules/**",
      "packages/contracts/src/gen/**",
    ],
  },
  eslint.configs.recommended,
  {
    rules: {
      "no-warning-comments": ["warn", { location: "anywhere", terms: ["todo", "fixme"] }],
    },
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { allowDefaultCaseForExhaustiveSwitch: false },
      ],
    },
  },
  {
    files: ["packages/contracts/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictedImports(
        ["@minions/core", "@minions/core/*"],
        ["@minions/adapters", "@minions/adapters/*"],
        ["@minions/ui-kit", "@minions/ui-kit/*"],
        ["@minions/testkit", "@minions/testkit/*"],
      ),
    },
  },
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictedImports(
        ["node:*"],
        ["@minions/contracts", "@minions/contracts/*"],
        ["@minions/adapters", "@minions/adapters/*"],
        ["@minions/ui-kit", "@minions/ui-kit/*"],
        ["@minions/testkit", "@minions/testkit/*"],
      ),
    },
  },
  {
    files: ["packages/ui-kit/**/*.ts", "packages/ui-kit/**/*.tsx"],
    rules: {
      "no-restricted-imports": restrictedImports(
        ["node:*"],
        ["@minions/core", "@minions/core/*"],
        ["@minions/adapters", "@minions/adapters/*"],
        ["@minions/testkit", "@minions/testkit/*"],
      ),
    },
  },
  {
    files: ["apps/web/**/*.ts", "apps/web/**/*.tsx"],
    rules: {
      "no-restricted-imports": restrictedImports(
        ["node:*"],
        ["@minions/core", "@minions/core/*"],
        ["@minions/adapters", "@minions/adapters/*"],
        ["@minions/testkit", "@minions/testkit/*"],
      ),
    },
  },
  {
    files: ["apps/daemon/**/*.ts", "apps/cli/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictedImports(
        ["@minions/adapters/sqlite-test-support"],
        ["@minions/testkit", "@minions/testkit/*"],
        ["@minions/ui-kit", "@minions/ui-kit/*"],
      ),
    },
  },
);
