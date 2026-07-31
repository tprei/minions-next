import type { Meta, StoryObj } from "@storybook/react-vite";
import { Tabs } from "./Tabs.js";

const meta: Meta<typeof Tabs> = {
  title: "Primitives/Tabs",
  component: Tabs,
};

export default meta;
type Story = StoryObj<typeof Tabs>;

export const Default: Story = {
  render: () => (
    <Tabs
      defaultValue="overview"
      items={[
        { value: "overview", label: "Overview", content: <p>Overview content.</p> },
        { value: "details", label: "Details", content: <p>Details content.</p> },
        { value: "activity", label: "Activity", content: <p>Activity content.</p> },
      ]}
    />
  ),
};

export const SecondTabActive: Story = {
  render: () => (
    <Tabs
      defaultValue="details"
      items={[
        { value: "overview", label: "Overview", content: <p>Overview content.</p> },
        { value: "details", label: "Details", content: <p>Details content.</p> },
      ]}
    />
  ),
};
