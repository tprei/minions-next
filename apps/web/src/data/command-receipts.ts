/**
 * Command receipt tracking (PR 44 — browser-projection-store).
 *
 * No command-issuing UI exists yet (that lands in PR 46+); this module only builds the
 * tracking primitive so later UI has a stable, tested place to record command lifecycle.
 * The operator MUST be able to distinguish requested, delivered, applied, and failed actions
 * (PRD UI-04) — a command sits in exactly one of these states at a time.
 */
export type ReceiptState =
  | { readonly status: "requested"; readonly requestedAt: number }
  | { readonly status: "delivered"; readonly requestedAt: number; readonly deliveredAt: number }
  | {
      readonly status: "applied";
      readonly requestedAt: number;
      readonly deliveredAt: number;
      readonly appliedAt: number;
    }
  | {
      readonly status: "failed";
      readonly requestedAt: number;
      readonly failedAt: number;
      readonly reason: string;
    };

export class CommandReceiptStore {
  #receipts = new Map<string, ReceiptState>();
  readonly #listeners = new Set<() => void>();

  getSnapshot = (): ReadonlyMap<string, ReceiptState> => this.#receipts;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  get(commandId: string): ReceiptState | undefined {
    return this.#receipts.get(commandId);
  }

  markRequested(commandId: string, now = Date.now()): void {
    this.#set(commandId, { status: "requested", requestedAt: now });
  }

  markDelivered(commandId: string, now = Date.now()): void {
    const existing = this.#receipts.get(commandId);
    const requestedAt = existing?.requestedAt ?? now;
    this.#set(commandId, { status: "delivered", requestedAt, deliveredAt: now });
  }

  markApplied(commandId: string, now = Date.now()): void {
    const existing = this.#receipts.get(commandId);
    const requestedAt = existing?.requestedAt ?? now;
    const deliveredAt =
      existing !== undefined && "deliveredAt" in existing ? existing.deliveredAt : now;
    this.#set(commandId, { status: "applied", requestedAt, deliveredAt, appliedAt: now });
  }

  markFailed(commandId: string, reason: string, now = Date.now()): void {
    const existing = this.#receipts.get(commandId);
    const requestedAt = existing?.requestedAt ?? now;
    this.#set(commandId, { status: "failed", requestedAt, failedAt: now, reason });
  }

  #set(commandId: string, state: ReceiptState): void {
    const next = new Map(this.#receipts);
    next.set(commandId, state);
    this.#receipts = next;
    for (const listener of this.#listeners) listener();
  }
}
