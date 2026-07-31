import {
  NodeAttentionKind,
  NodeAttentionState,
  NodeCommandDeliveryState,
} from "@minions/contracts";
import type { StatusKind } from "@minions/ui-kit";
/**
 * Enum→human-label/badge mappings for steering (PR 47 — live-node-console-steering).
 * Kept separate from the home/tree label maps because the steering domain has its own
 * vocabulary (delivery states, attention kinds) that doesn't overlap with tree/host labels.
 */

export function deliveryStateLabel(state: NodeCommandDeliveryState): string {
  switch (state) {
    case NodeCommandDeliveryState.QUEUED:
      return "queued";
    case NodeCommandDeliveryState.SENT:
      return "sent";
    case NodeCommandDeliveryState.ACKNOWLEDGED:
      return "acknowledged";
    case NodeCommandDeliveryState.APPLIED:
      return "applied";
    case NodeCommandDeliveryState.FAILED:
      return "failed";
    case NodeCommandDeliveryState.REVIEW_REQUIRED:
      return "review required";
    case NodeCommandDeliveryState.UNSPECIFIED:
      return "unknown";
  }
}

export function deliveryStateBadgeKind(state: NodeCommandDeliveryState): StatusKind {
  switch (state) {
    case NodeCommandDeliveryState.QUEUED:
      return "neutral";
    case NodeCommandDeliveryState.SENT:
      return "info";
    case NodeCommandDeliveryState.ACKNOWLEDGED:
      return "info";
    case NodeCommandDeliveryState.APPLIED:
      return "success";
    case NodeCommandDeliveryState.FAILED:
      return "danger";
    case NodeCommandDeliveryState.REVIEW_REQUIRED:
      return "warning";
    case NodeCommandDeliveryState.UNSPECIFIED:
      return "neutral";
  }
}

export function attentionKindLabel(kind: NodeAttentionKind): string {
  switch (kind) {
    case NodeAttentionKind.QUESTION:
      return "question";
    case NodeAttentionKind.APPROVAL:
      return "approval";
    case NodeAttentionKind.UNSPECIFIED:
      return "unknown";
  }
}

export function attentionStateLabel(state: NodeAttentionState): string {
  switch (state) {
    case NodeAttentionState.OPEN:
      return "open";
    case NodeAttentionState.RESOLVED:
      return "resolved";
    case NodeAttentionState.UNSPECIFIED:
      return "unknown";
  }
}

export function attentionStateBadgeKind(state: NodeAttentionState): StatusKind {
  switch (state) {
    case NodeAttentionState.OPEN:
      return "warning";
    case NodeAttentionState.RESOLVED:
      return "success";
    case NodeAttentionState.UNSPECIFIED:
      return "neutral";
  }
}
