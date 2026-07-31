/**
 * In-memory registry resolving a durable {@link ContentHash} change-id
 * fingerprint back to the raw jj identity a {@link JjWorkingCopyManager}
 * broker call can act on (PR 39/40 support).
 *
 * {@link changeIdFingerprint} (fixup-coordinator.ts) is a one-way SHA-256
 * fingerprint: `ContentHash -> raw change id` cannot be recovered from the
 * hash alone. The production `FixupWorkingCopy` / `SplitWorkingCopy` adapters
 * (fixup-working-copy.ts, split-working-copy.ts) receive ONLY `ContentHash`
 * handles on their ports (mirroring the durable `VcsChangeBinding.jjChangeId`
 * identity space — see packages/core/src/vcs-change-binding.ts), never raw jj
 * change ids or working-copy paths, so they need a side channel that
 * remembers which raw jj change id — and which broker working copy — a
 * fingerprint came from. This registry is that side channel: `register`
 * records a raw id's fingerprint (a newly-created fixup/split child, or a
 * pre-existing change resolved into the working copy the coordinator is about
 * to operate against); `resolve` looks it up.
 *
 * In a fully-wired production system, commit-capture (PR 30) would feed this
 * same registry whenever it captures a node's commit, so a subsequently-issued
 * fixup/split against that node resolves without extra setup. Wiring that
 * cross-feed is outside this adapter's scope (see the module docstrings of
 * fixup-working-copy.ts / split-working-copy.ts); this registry only needs to
 * be fed by whoever discovers a raw change id, including its own callers.
 */
import type { ContentHash } from "@minions/core";

import { changeIdFingerprint } from "./fixup-coordinator.js";

export type JjChangeIdRegistryErrorCode = "unresolved_change";

/** Typed registry error. Fail-closed: resolving an unregistered fingerprint throws. */
export class JjChangeIdRegistryError extends Error {
  readonly code: JjChangeIdRegistryErrorCode;
  readonly remediation: string;

  constructor(code: JjChangeIdRegistryErrorCode, message: string, remediation: string) {
    super(message);
    this.name = "JjChangeIdRegistryError";
    this.code = code;
    this.remediation = remediation;
  }
}

/** A raw jj identity resolved from a {@link ContentHash} fingerprint. */
export type ResolvedJjChange = Readonly<{
  /** The {@link JjWorkingCopyManager} broker id to route calls through. */
  readonly workingCopyId: string;
  /** The raw jj change id (or other revset jj resolves) within that working copy. */
  readonly rawChangeId: string;
}>;

export interface JjChangeIdRegistry {
  /**
   * Fingerprint `rawChangeId` (deterministic SHA-256, matching {@link
   * changeIdFingerprint}) and record that, within `workingCopyId`'s broker
   * clone, it currently resolves to `rawChangeId`. Returns the fingerprint.
   * Registering the same raw id again (e.g. after jj's auto-rebase moved it to
   * a new broker routing id) overwrites the prior entry with the latest one.
   */
  register(workingCopyId: string, rawChangeId: string): ContentHash;
  /**
   * Resolve a fingerprint back to its raw jj change id + owning working copy.
   * Throws {@link JjChangeIdRegistryError} if `changeId` was never registered.
   */
  resolve(changeId: ContentHash): ResolvedJjChange;
}

/** Create a fresh, empty in-memory registry. */
export function createJjChangeIdRegistry(): JjChangeIdRegistry {
  const byFingerprint = new Map<ContentHash, ResolvedJjChange>();
  return {
    register(workingCopyId: string, rawChangeId: string): ContentHash {
      const changeId = changeIdFingerprint(rawChangeId);
      byFingerprint.set(changeId, Object.freeze({ workingCopyId, rawChangeId }));
      return changeId;
    },
    resolve(changeId: ContentHash): ResolvedJjChange {
      const found = byFingerprint.get(changeId);
      if (found === undefined) {
        throw new JjChangeIdRegistryError(
          "unresolved_change",
          `no raw jj change id registered for fingerprint '${changeId}'`,
          "Call register(workingCopyId, rawChangeId) for this change before operating on it (e.g. resolve it via its known commit SHA into the target working copy, or register it when commit-capture first discovers it).",
        );
      }
      return found;
    },
  };
}
