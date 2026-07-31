import type { HTMLAttributes, ReactNode } from "react";
import "./Provenance.css";

/**
 * Provenance primitives (PR 43 — ui-design-system-shell, PRD UI-07).
 *
 * A deterministic fact (a check result, a recorded outcome, a resolved SHA) and model
 * commentary (an LLM's summary or diagnosis of that fact) MUST render as visually distinct
 * types everywhere in the product — never the same plain text. `Fact` and `Commentary` are
 * the two inline wrappers every feature routes through; `StatusBadge` is a fact by
 * construction (it always renders in the fact style) since a status is always a recorded,
 * deterministic outcome, never a model opinion.
 */

export type StatusKind = "neutral" | "info" | "success" | "warning" | "danger";

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly status: StatusKind;
  readonly label: string;
}

export function StatusBadge({ status, label, className, ...rest }: StatusBadgeProps): ReactNode {
  const classes = ["mn-status-badge", `mn-status-badge--${status}`];
  if (className !== undefined) classes.push(className);
  return (
    <span className={classes.join(" ")} {...rest}>
      {label}
    </span>
  );
}

export interface ProvenanceTextProps extends HTMLAttributes<HTMLSpanElement> {
  readonly children: ReactNode;
}

/** A deterministic, recorded fact — exact SHAs, check outcomes, timestamps, counts. */
export function Fact({ className, ...rest }: ProvenanceTextProps): ReactNode {
  const classes = ["mn-fact"];
  if (className !== undefined) classes.push(className);
  return <span className={classes.join(" ")} {...rest} />;
}

/** Model-generated summary, diagnosis, or narration — never presented as a recorded fact. */
export function Commentary({ className, children, ...rest }: ProvenanceTextProps): ReactNode {
  const classes = ["mn-commentary"];
  if (className !== undefined) classes.push(className);
  return (
    <span className={classes.join(" ")} {...rest}>
      <span className="mn-visually-hidden">Model commentary: </span>
      {children}
    </span>
  );
}
