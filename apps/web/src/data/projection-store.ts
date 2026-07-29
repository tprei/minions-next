import type { GetSnapshotResponse, ProjectionChange } from "@minions/contracts";
import { applyProjectionChange, projectionStateFromSnapshot } from "./projection-reducer.js";
import { emptyProjectionState, type ProjectionState } from "./projection-types.js";

/**
 * Holds one {@link ProjectionState} and notifies subscribers on change (PR 44). Shaped for
 * React's built-in `useSyncExternalStore` (`subscribe`/`getSnapshot`) — no external state
 * library is introduced; a plain class with a listener set is sufficient here.
 */
export class ProjectionStore {
  #state: ProjectionState = emptyProjectionState();
  readonly #listeners = new Set<() => void>();

  getSnapshot = (): ProjectionState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Replaces the entire state — used for the initial `GetSnapshot` and every resnapshot. */
  replaceSnapshot(snapshot: GetSnapshotResponse): void {
    this.#state = projectionStateFromSnapshot(snapshot);
    this.#notify();
  }

  /** Applies one durable event's `ProjectionChange` to the current state. */
  applyChange(change: ProjectionChange): void {
    this.#state = applyProjectionChange(this.#state, change);
    this.#notify();
  }

  reset(): void {
    this.#state = emptyProjectionState();
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
