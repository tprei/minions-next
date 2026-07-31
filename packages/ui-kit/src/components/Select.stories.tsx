import type { Meta, StoryObj } from "@storybook/react-vite";
import { Select } from "./Select.js";

const meta: Meta<typeof Select> = {
  title: "Primitives/Select",
  component: Select,
  args: {
    options: [
      { value: "a", label: "Host A" },
      { value: "b", label: "Host B" },
      { value: "c", label: "Host C" },
    ],
  },
};

export default meta;
type Story = StoryObj<typeof Select>;

export const Default: Story = { args: { placeholder: "Select a host" } };
export const Invalid: Story = { args: { invalid: true, defaultValue: "a" } };
