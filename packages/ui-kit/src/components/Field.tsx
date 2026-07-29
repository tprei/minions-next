import type { ReactNode } from "react";
import "./Field.css";

export interface FieldProps {
  readonly label: string;
  readonly htmlFor: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}

/**
 * Labeled form-field wrapper (PR 45 — host-repository-task-ui). Renders the label, the
 * caller-supplied control, and EITHER a hint OR an error (never both) below it. The error
 * text carries `role="alert"` so assistive tech announces it the moment validation fails.
 * The caller remains responsible for wiring `id={htmlFor}` and, when there's an error,
 * `aria-invalid` + `aria-describedby={`${htmlFor}-error`}` on the control it passes as
 * `children` — Field only renders text, it never clones/mutates its child (kept boring and
 * explicit rather than reaching for `cloneElement` prop injection).
 */
export function Field({ label, htmlFor, hint, error, children }: FieldProps): ReactNode {
  return (
    <div className="mn-field">
      <label className="mn-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error !== undefined ? (
        <p className="mn-field__error" id={`${htmlFor}-error`} role="alert">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p className="mn-field__hint" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
