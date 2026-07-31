import { forwardRef, type TextareaHTMLAttributes } from "react";
import "./TextArea.css";

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly invalid?: boolean;
}

/** Multi-line text control (PR 45). Native `<textarea>` semantics are preserved verbatim —
 * this only layers the design-system look and an `invalid` visual/aria state. */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { invalid = false, className, rows = 4, ...rest },
  ref,
) {
  const classes = ["mn-textarea", "mn-focus-ring"];
  if (invalid) classes.push("mn-textarea--invalid");
  if (className !== undefined) classes.push(className);
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={classes.join(" ")}
      aria-invalid={invalid ? true : undefined}
      {...rest}
    />
  );
});
