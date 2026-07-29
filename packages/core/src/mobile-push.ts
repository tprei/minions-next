/**
 * Mobile PWA push (PR 58 — mobile-pwa-push-offline).
 *
 * Web Push with privacy-minimal payloads. Complex plan editing remains
 * desktop-optimized; every phone mutation requires live authenticated
 * Connect and current policy.
 */
export type PushSubscription = Readonly<{
  readonly endpoint: string;
  readonly keys: Readonly<{ readonly p256dh: string; readonly auth: string }>;
}>;

export type PushPayload = Readonly<{
  readonly treeId: string;
  readonly nodeId: string;
  readonly kind: "attention" | "outcome" | "command_receipt";
  readonly title: string;
}>;

export type PushPayloadVerdict = Readonly<{ readonly valid: boolean; readonly reason?: string }>;

export type RedactedPushPayload = Readonly<{
  readonly treeId: string;
  readonly nodeId: string;
  readonly kind: string;
  readonly title: "[REDACTED]";
}>;

const VALID_KINDS: ReadonlySet<string> = new Set(["attention", "outcome", "command_receipt"]);

/** Validate a push payload's structural invariants (pure, fail-closed). */
export function validatePushPayload(payload: PushPayload): PushPayloadVerdict {
  if (payload.treeId.trim().length === 0) {
    return Object.freeze({ valid: false, reason: "treeId must not be empty" });
  }
  if (payload.nodeId.trim().length === 0) {
    return Object.freeze({ valid: false, reason: "nodeId must not be empty" });
  }
  if (!VALID_KINDS.has(payload.kind)) {
    return Object.freeze({ valid: false, reason: `unknown kind: ${payload.kind}` });
  }
  return Object.freeze({ valid: true });
}

/** Strip free-text title for privacy-minimal logging (pure). */
export function redactPushPayload(payload: PushPayload): RedactedPushPayload {
  return Object.freeze({
    treeId: payload.treeId,
    nodeId: payload.nodeId,
    kind: payload.kind,
    title: "[REDACTED]",
  });
}

export type OfflineSnapshotState =
  "planned" | "ready" | "active" | "blocked" | "succeeded" | "failed" | "cancelled" | "superseded";

/** Minimal cached view of a task node for offline display (mobile PWA). */
export type OfflineSnapshot = Readonly<{
  readonly treeId: string;
  readonly nodeId: string;
  readonly objective: string;
  readonly state: OfflineSnapshotState;
  readonly capturedAt: number;
}>;

export type OfflineSnapshotVerdict = Readonly<{
  readonly valid: boolean;
  readonly reason?: string;
}>;

const VALID_OFFLINE_STATES: Record<string, true> = {
  planned: true,
  ready: true,
  active: true,
  blocked: true,
  succeeded: true,
  failed: true,
  cancelled: true,
  superseded: true,
};

/** Validate an offline snapshot's structural invariants (pure, fail-closed). */
export function validateOfflineSnapshot(snapshot: OfflineSnapshot): OfflineSnapshotVerdict {
  if (snapshot.treeId.trim().length === 0) {
    return Object.freeze({ valid: false, reason: "treeId must not be empty" });
  }
  if (snapshot.nodeId.trim().length === 0) {
    return Object.freeze({ valid: false, reason: "nodeId must not be empty" });
  }
  if (snapshot.objective.trim().length === 0) {
    return Object.freeze({ valid: false, reason: "objective must not be empty" });
  }
  if (VALID_OFFLINE_STATES[snapshot.state] === undefined) {
    return Object.freeze({ valid: false, reason: `unknown state: ${snapshot.state}` });
  }
  if (!Number.isFinite(snapshot.capturedAt) || snapshot.capturedAt < 0) {
    return Object.freeze({
      valid: false,
      reason: "capturedAt must be a non-negative finite number",
    });
  }
  return Object.freeze({ valid: true });
}

export type DraftCommandStatus = "pending" | "sent" | "failed";

/** A phone-composed command queued for delivery once connectivity returns. */
export type DraftCommand = Readonly<{
  readonly text: string;
  readonly queuedAt: number;
  readonly status: DraftCommandStatus;
}>;

/**
 * Authenticated deep link for phone navigation (PR 58).
 *
 * Phone push notifications carry a deep link the app opens on tap. The link
 * encodes the target route and a short-lived auth token — the phone app must
 * verify the token against its session before navigating.
 */
export type DeepLinkTarget = "attention" | "outcome" | "tree" | "node";

export type DeepLink = Readonly<{
  readonly target: DeepLinkTarget;
  readonly treeId: string;
  readonly nodeId: string | undefined;
}>;

const VALID_DEEP_LINK_TARGETS: Record<string, true> = {
  attention: true,
  outcome: true,
  tree: true,
  node: true,
};

/** Validate a deep link's structure (pure, fail-closed). */
export function validateDeepLink(link: DeepLink): {
  readonly valid: boolean;
  readonly reason?: string;
} {
  if (!VALID_DEEP_LINK_TARGETS[link.target]) {
    return Object.freeze({ valid: false, reason: `unknown deep link target: ${link.target}` });
  }
  if (link.treeId.trim().length === 0) {
    return Object.freeze({ valid: false, reason: "treeId must not be empty" });
  }
  if (link.target === "attention" || link.target === "outcome" || link.target === "node") {
    if (link.nodeId === undefined || link.nodeId.trim().length === 0) {
      return Object.freeze({ valid: false, reason: `${link.target} target requires nodeId` });
    }
  }
  return Object.freeze({ valid: true });
}
