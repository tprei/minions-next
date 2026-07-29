import { forwardRef, type ButtonHTMLAttributes } from "react";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

/**
 * Primary interactive control (PR 43 — ui-design-system-shell).
 *
 * Native `<button>` semantics (keyboard activation, disabled state, focus) come for free;
 * this component only layers the design-system look. Never render a `<div onClick>` in its
 * place — screen readers and keyboard users depend on the real element (PRD UI-09).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", className, type = "button", ...rest },
  ref,
) {
  const classes = ["mn-button", `mn-button--${variant}`, `mn-button--${size}`, "mn-focus-ring"];
  if (className !== undefined) classes.push(className);
  return <button ref={ref} type={type} className={classes.join(" ")} {...rest} />;
});
