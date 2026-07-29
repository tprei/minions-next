import type { Meta, StoryObj } from "@storybook/react-vite";
import { Commentary, Fact, StatusBadge, type StatusKind } from "./Provenance.js";

const meta: Meta = {
  title: "Primitives/Provenance",
};

export default meta;

const statusKinds: readonly StatusKind[] = ["neutral", "info", "success", "warning", "danger"];

export const StatusBadges: StoryObj = {
  render: () => (
    <div style={{ display: "flex", gap: "8px" }}>
      {statusKinds.map((status) => (
        <StatusBadge key={status} status={status} label={status} />
      ))}
    </div>
  ),
};

export const FactVsCommentary: StoryObj = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <Fact>commit 4a1f9c2 · check_run #482 · completed</Fact>
      <Commentary>
        The failing test looks like a pre-existing flake, not caused by this change.
      </Commentary>
    </div>
  ),
};
