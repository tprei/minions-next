import { forwardRef, type InputHTMLAttributes } from "react";
import "./TextInput.css";

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly invalid?: boolean;
}

/** Single-line text control (PR 45). Native `<input>` semantics are preserved verbatim —
 * this only layers the design-system look and an `invalid` visual/aria state. */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { invalid = false, className, type = "text", ...rest },
  ref,
) {
  const classes = ["mn-text-input", "mn-focus-ring"];
  if (invalid) classes.push("mn-text-input--invalid");
  if (className !== undefined) classes.push(className);
  return (
    <input
      ref={ref}
      type={type}
      className={classes.join(" ")}
      aria-invalid={invalid ? true : undefined}
      {...rest}
    />
  );
});
