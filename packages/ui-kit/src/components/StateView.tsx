import type { ReactNode } from "react";
import "./StateView.css";

/**
 * Non-content states (PR 43 — ui-design-system-shell, PRD UI-08).
 *
 * Reconnecting, a stale cache, an offline host, and a genuine error MUST be visibly distinct
 * — the UI must never render cached data as if it were live. Each `StateView` kind carries
 * its own icon glyph and copy register so a feature can't collapse them into one generic
 * "something's wrong" box.
 */
export type StateViewKind = "loading" | "error" | "offline" | "stale" | "empty";

export interface StateViewProps {
  readonly kind: StateViewKind;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}

const glyphByKind: Readonly<Record<StateViewKind, string>> = {
  loading: "…",
  error: "!",
  offline: "⏻",
  stale: "↻",
  empty: "∅",
};

export function StateView({ kind, title, description, action }: StateViewProps): ReactNode {
  const live = kind === "error" || kind === "offline" || kind === "stale";
  return (
    <div
      className={`mn-state-view mn-state-view--${kind}`}
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
    >
      <span className="mn-state-view__glyph" aria-hidden="true">
        {glyphByKind[kind]}
      </span>
      <p className="mn-state-view__title">{title}</p>
      {description !== undefined ? (
        <p className="mn-state-view__description">{description}</p>
      ) : null}
      {action !== undefined ? <div className="mn-state-view__action">{action}</div> : null}
    </div>
  );
}
