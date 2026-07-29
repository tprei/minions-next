import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";

const meta: Meta<typeof Dialog> = {
  title: "Primitives/Dialog",
  component: Dialog,
};

export default meta;
type Story = StoryObj<typeof Dialog>;

export const Default: Story = {
  render: () => (
    <Dialog
      trigger={<Button variant="secondary">Open dialog</Button>}
      title="Confirm action"
      description="This is a description of what the dialog will do."
    >
      <p>Dialog body content goes here.</p>
    </Dialog>
  ),
};

function OpenDialogDemo(): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={<Button variant="secondary">Open dialog</Button>}
      title="Confirm action"
      description="This dialog starts open so its focus trap and layout are reviewable at a glance."
    >
      <p>Dialog body content goes here.</p>
    </Dialog>
  );
}

export const OpenByDefault: Story = {
  render: () => <OpenDialogDemo />,
};
