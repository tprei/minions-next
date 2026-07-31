import type { Meta, StoryObj } from "@storybook/react-vite";
import { Card } from "./Card.js";

const meta: Meta<typeof Card> = {
  title: "Primitives/Card",
  component: Card,
};

export default meta;
type Story = StoryObj<typeof Card>;

export const Default: Story = {
  render: () => (
    <Card>
      <p>Card content.</p>
    </Card>
  ),
};
