import { useEffect } from "react";
import type { Decorator, Preview } from "@storybook/react-vite";
import "../packages/ui-kit/src/tokens.css";

/**
 * Applies the story's selected theme to `<html data-theme>` before render, so every story
 * exercises the same token cascade the real app uses instead of a Storybook-only stylesheet
 * (PR 43, PRD UI-09/UI-12).
 */
const withTheme: Decorator = (Story, context) => {
  const theme = context.globals["theme"] === "dark" ? "dark" : "light";
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  return <Story />;
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: "Theme",
      toolbar: {
        title: "Theme",
        icon: "circlehollow",
        items: ["light", "dark"],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: "light",
  },
  parameters: {
    a11y: {
      test: "error",
    },
  },
};

export default preview;
