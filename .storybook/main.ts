import { join } from "node:path";
import type { StorybookConfig } from "@storybook/react-vite";

// PR 43 — ui-design-system-shell. Storybook drives isolated component development and the
// blocking accessibility/interaction checks (@storybook/addon-a11y) for every ui-kit
// primitive, independent of the full app shell.
const config: StorybookConfig = {
  stories: [join("..", "packages", "ui-kit", "src", "**", "*.stories.tsx")],
  addons: ["@storybook/addon-a11y"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  core: {
    disableTelemetry: true,
  },
};

export default config;
