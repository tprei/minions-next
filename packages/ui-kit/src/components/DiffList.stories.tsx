import type { Meta, StoryObj } from "@storybook/react-vite";
import { DiffList, type DiffListEntry } from "./DiffList.js";

const meta: Meta<typeof DiffList> = {
  title: "Primitives/DiffList",
  component: DiffList,
};

export default meta;
type Story = StoryObj<typeof DiffList>;

const sampleEntries: DiffListEntry[] = [
  { key: "1", kind: "added", label: "Write the migration script" },
  {
    key: "2",
    kind: "changed",
    label: "Update the settings screen",
    detail: "objective, allowed paths",
  },
  { key: "3", kind: "removed", label: "Old draft: refactor the sidebar" },
  { key: "4", kind: "unchanged", label: "Ship the release notes" },
];

export const Default: Story = {
  args: { entries: sampleEntries },
};

export const Empty: Story = {
  args: { entries: [] },
};
