import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./Button.js";
import { NavBar } from "./NavBar.js";
import { StatusBadge } from "./Provenance.js";

const meta: Meta<typeof NavBar> = {
  title: "Primitives/NavBar",
  component: NavBar,
};

export default meta;
type Story = StoryObj<typeof NavBar>;

export const Default: Story = {
  args: {
    brand: "Minions",
    children: (
      <>
        <StatusBadge status="success" label="daemon: live" />
        <Button variant="secondary" size="sm">
          Settings
        </Button>
      </>
    ),
  },
};
