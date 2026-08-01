import { RecoveryActionKind, RecoveryActionState } from "@minions/contracts";
import type { StatusKind } from "@minions/ui-kit";

export function recoveryActionKindLabel(kind: RecoveryActionKind): string {
  switch (kind) {
    case RecoveryActionKind.UNSPECIFIED:
      return "unknown";
    case RecoveryActionKind.SIGNAL:
      return "signal";
    case RecoveryActionKind.RESTART:
      return "restart";
    case RecoveryActionKind.QUARANTINE:
      return "quarantine";
    case RecoveryActionKind.RECONCILE:
      return "reconcile";
    case RecoveryActionKind.DEBUG_ATTACH:
      return "debug attach";
    case RecoveryActionKind.SOURCE_PATCH_BRANCH:
      return "source patch branch";
    case RecoveryActionKind.SHADOW_VERIFY:
      return "shadow verify";
    case RecoveryActionKind.CANDIDATE_ACTIVATE:
      return "candidate activate";
    case RecoveryActionKind.FORCE_ROLLBACK:
      return "force rollback";
  }
}

export function recoveryActionStateLabel(state: RecoveryActionState): string {
  switch (state) {
    case RecoveryActionState.UNSPECIFIED:
      return "unknown";
    case RecoveryActionState.PENDING:
      return "pending";
    case RecoveryActionState.EXECUTED:
      return "executed";
    case RecoveryActionState.FAILED:
      return "failed";
    case RecoveryActionState.REJECTED:
      return "rejected";
    case RecoveryActionState.EXPIRED:
      return "expired";
  }
}

export function recoveryActionStateBadgeKind(state: RecoveryActionState): StatusKind {
  switch (state) {
    case RecoveryActionState.UNSPECIFIED:
      return "neutral";
    case RecoveryActionState.PENDING:
      return "info";
    case RecoveryActionState.EXECUTED:
      return "success";
    case RecoveryActionState.FAILED:
      return "danger";
    case RecoveryActionState.REJECTED:
      return "danger";
    case RecoveryActionState.EXPIRED:
      return "neutral";
  }
}
