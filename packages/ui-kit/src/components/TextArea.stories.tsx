import type { Meta, StoryObj } from "@storybook/react-vite";
import { TextArea } from "./TextArea.js";

const meta: Meta<typeof TextArea> = {
  title: "Primitives/TextArea",
  component: TextArea,
};

export default meta;
type Story = StoryObj<typeof TextArea>;

export const Default: Story = { args: { placeholder: "Describe the goal…" } };
export const Invalid: Story = { args: { invalid: true, defaultValue: "Invalid value" } };
