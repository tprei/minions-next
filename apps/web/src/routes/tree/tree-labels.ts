import {
  NodeState,
  PlanAttentionKind,
  PlanNodeMode,
  PlanRevisionState,
  VcsConflictState,
} from "@minions/contracts";
import type { StatusKind } from "@minions/ui-kit";

/**
 * Enum-to-presentation mappings for the tree editor (PR 46 — plan-tree-editor-approval).
 * Mirrors apps/web/src/routes/home/labels.ts's convention exactly: every switch is exhaustive
 * over the generated enum, including its zero `UNSPECIFIED` member, so a future proto enum
 * addition fails `@typescript-eslint/switch-exhaustiveness-check` here instead of silently
 * falling through to a wrong label.
 */

export function planNodeModeLabel(mode: PlanNodeMode): string {
  switch (mode) {
    case PlanNodeMode.UNSPECIFIED:
      return "unknown";
    case PlanNodeMode.PLAN:
      return "plan";
    case PlanNodeMode.RESEARCH:
      return "research";
    case PlanNodeMode.EXPLORE:
      return "explore";
    case PlanNodeMode.IMPLEMENTATION:
      return "implementation";
  }
}

/** Every mode an operator may legally pick in the editor — excludes the zero
 *  `UNSPECIFIED` member, which `buf.validate` rejects for both `ProposedNode.mode` and
 *  `TaskNode.mode` (`not_in: 0`). */
export const EDITABLE_PLAN_NODE_MODES: readonly PlanNodeMode[] = [
  PlanNodeMode.PLAN,
  PlanNodeMode.RESEARCH,
  PlanNodeMode.EXPLORE,
  PlanNodeMode.IMPLEMENTATION,
];

/** Parses a `<select>` value back into a `PlanNodeMode` without an unchecked numeric cast. */
export function parsePlanNodeModeOption(value: string): PlanNodeMode {
  const parsed = EDITABLE_PLAN_NODE_MODES.find((mode) => String(mode) === value);
  if (parsed === undefined) throw new RangeError(`unknown plan node mode option: ${value}`);
  return parsed;
}

export function nodeStateLabel(state: NodeState): string {
  switch (state) {
    case NodeState.UNSPECIFIED:
      return "unknown";
    case NodeState.PLANNED:
      return "planned";
    case NodeState.READY:
      return "ready";
    case NodeState.ACTIVE:
      return "active";
    case NodeState.BLOCKED:
      return "blocked";
    case NodeState.SUCCEEDED:
      return "succeeded";
    case NodeState.FAILED:
      return "failed";
    case NodeState.CANCELLED:
      return "cancelled";
    case NodeState.SUPERSEDED:
      return "superseded";
  }
}

export function nodeStateBadgeKind(state: NodeState): StatusKind {
  switch (state) {
    case NodeState.UNSPECIFIED:
      return "neutral";
    case NodeState.PLANNED:
      return "neutral";
    case NodeState.READY:
      return "info";
    case NodeState.ACTIVE:
      return "info";
    case NodeState.BLOCKED:
      return "warning";
    case NodeState.SUCCEEDED:
      return "success";
    case NodeState.FAILED:
      return "danger";
    case NodeState.CANCELLED:
      return "neutral";
    case NodeState.SUPERSEDED:
      return "neutral";
  }
}

export function planRevisionStateLabel(state: PlanRevisionState): string {
  switch (state) {
    case PlanRevisionState.UNSPECIFIED:
      return "unknown";
    case PlanRevisionState.DRAFT:
      return "draft";
    case PlanRevisionState.APPROVED:
      return "approved";
    case PlanRevisionState.SUPERSEDED:
      return "superseded";
  }
}

export function planRevisionStateBadgeKind(state: PlanRevisionState): StatusKind {
  switch (state) {
    case PlanRevisionState.UNSPECIFIED:
      return "neutral";
    case PlanRevisionState.DRAFT:
      return "warning";
    case PlanRevisionState.APPROVED:
      return "success";
    case PlanRevisionState.SUPERSEDED:
      return "neutral";
  }
}

export function planAttentionKindLabel(kind: PlanAttentionKind): string {
  switch (kind) {
    case PlanAttentionKind.UNSPECIFIED:
      return "unknown";
    case PlanAttentionKind.PLAN_REQUIRED:
      return "plan required";
    case PlanAttentionKind.PLAN_INVALID:
      return "plan invalid";
    case PlanAttentionKind.REPAIR_REQUIRED:
      return "repair required";
  }
}

export function vcsConflictStateLabel(state: VcsConflictState): string {
  switch (state) {
    case VcsConflictState.UNSPECIFIED:
      return "unknown";
    case VcsConflictState.CLEAN:
      return "clean";
    case VcsConflictState.CONFLICT:
      return "conflict";
    case VcsConflictState.RESOLVED:
      return "resolved";
  }
}

export function vcsConflictBadgeKind(state: VcsConflictState): StatusKind {
  switch (state) {
    case VcsConflictState.UNSPECIFIED:
      return "neutral";
    case VcsConflictState.CLEAN:
      return "success";
    case VcsConflictState.CONFLICT:
      return "danger";
    case VcsConflictState.RESOLVED:
      return "info";
  }
}
