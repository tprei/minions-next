import type { Meta, StoryObj } from "@storybook/react-vite";
import { TextInput } from "./TextInput.js";

const meta: Meta<typeof TextInput> = {
  title: "Primitives/TextInput",
  component: TextInput,
};

export default meta;
type Story = StoryObj<typeof TextInput>;

export const Default: Story = { args: { defaultValue: "Filled value" } };
export const WithPlaceholder: Story = { args: { placeholder: "Placeholder" } };
export const Invalid: Story = { args: { invalid: true, defaultValue: "Invalid value" } };
export const Disabled: Story = { args: { defaultValue: "Disabled", disabled: true } };
