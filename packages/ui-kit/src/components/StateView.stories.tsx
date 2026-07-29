import type { Meta, StoryObj } from "@storybook/react-vite";
import { StateView } from "./StateView.js";

const meta: Meta<typeof StateView> = {
  title: "Primitives/StateView",
  component: StateView,
};

export default meta;
type Story = StoryObj<typeof StateView>;

export const Loading: Story = {
  args: { kind: "loading", title: "Loading", description: "Fetching the latest snapshot." },
};
export const ErrorState: Story = {
  args: { kind: "error", title: "Something failed", description: "The last gate run errored." },
};
export const Offline: Story = {
  args: { kind: "offline", title: "Host offline", description: "Reconnecting to the daemon…" },
};
export const Stale: Story = {
  args: { kind: "stale", title: "Showing cached state", description: "Reconnect for live data." },
};
export const Empty: Story = { args: { kind: "empty", title: "Nothing here yet" } };
