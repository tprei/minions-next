import type { Meta, StoryObj } from "@storybook/react-vite";
import { Field } from "./Field.js";
import { TextInput } from "./TextInput.js";

const meta: Meta<typeof Field> = {
  title: "Primitives/Field",
  component: Field,
};

export default meta;
type Story = StoryObj<typeof Field>;

export const Default: Story = {
  args: {
    label: "Repository path",
    htmlFor: "story-field-hint",
    hint: "Absolute path on the host filesystem.",
    children: <TextInput id="story-field-hint" defaultValue="/home/user/code/example" />,
  },
};

export const WithError: Story = {
  args: {
    label: "Goal",
    htmlFor: "story-field-error",
    error: "Goal is required",
    children: (
      <TextInput id="story-field-error" invalid aria-describedby="story-field-error-error" />
    ),
  },
};
