import { ExecutionHostKind, ExecutionHostState, TreeState } from "@minions/contracts";
import type { StatusKind } from "@minions/ui-kit";

/**
 * Enum-to-presentation mappings (PR 45 — host-repository-task-ui). Every switch is
 * exhaustive over the generated enum (including its zero `UNSPECIFIED` member) so a future
 * proto enum addition fails `@typescript-eslint/switch-exhaustiveness-check` here instead of
 * silently falling through to a wrong label.
 */

export function hostKindLabel(kind: ExecutionHostKind): string {
  switch (kind) {
    case ExecutionHostKind.UNSPECIFIED:
      return "unknown";
    case ExecutionHostKind.LOCAL:
      return "local";
    case ExecutionHostKind.SSH:
      return "SSH";
    case ExecutionHostKind.WSL2:
      return "WSL2";
  }
}

export function hostStateLabel(state: ExecutionHostState): string {
  switch (state) {
    case ExecutionHostState.UNSPECIFIED:
      return "unknown";
    case ExecutionHostState.PENDING:
      return "pending";
    case ExecutionHostState.ONLINE:
      return "online";
    case ExecutionHostState.OFFLINE:
      return "offline";
    case ExecutionHostState.DEGRADED:
      return "degraded";
    case ExecutionHostState.REMOVED:
      return "removed";
  }
}

export function hostStateBadgeKind(state: ExecutionHostState): StatusKind {
  switch (state) {
    case ExecutionHostState.UNSPECIFIED:
      return "neutral";
    case ExecutionHostState.PENDING:
      return "info";
    case ExecutionHostState.ONLINE:
      return "success";
    case ExecutionHostState.OFFLINE:
      return "neutral";
    case ExecutionHostState.DEGRADED:
      return "warning";
    case ExecutionHostState.REMOVED:
      return "danger";
  }
}

export function treeStateLabel(state: TreeState): string {
  switch (state) {
    case TreeState.UNSPECIFIED:
      return "unknown";
    case TreeState.DRAFT:
      return "draft";
    case TreeState.APPROVED:
      return "approved";
    case TreeState.ACTIVE:
      return "active";
    case TreeState.SUCCEEDED:
      return "succeeded";
    case TreeState.FAILED:
      return "failed";
    case TreeState.CANCELLED:
      return "cancelled";
  }
}

export function treeStateBadgeKind(state: TreeState): StatusKind {
  switch (state) {
    case TreeState.UNSPECIFIED:
      return "neutral";
    case TreeState.DRAFT:
      return "neutral";
    case TreeState.APPROVED:
      return "info";
    case TreeState.ACTIVE:
      return "info";
    case TreeState.SUCCEEDED:
      return "success";
    case TreeState.FAILED:
      return "danger";
    case TreeState.CANCELLED:
      return "neutral";
  }
}

/** Short, stable display id for an entity whose full UUIDv7 is too long for a card label —
 * the full id is still available via a `title` attribute wherever this is used. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
