import { forwardRef, type SelectHTMLAttributes } from "react";
import "./Select.css";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  readonly options: readonly SelectOption[];
  readonly invalid?: boolean;
  /** Rendered as a disabled, hidden-value first `<option>` so the control always shows
   * meaningful placeholder text until the operator makes an explicit choice — no option is
   * ever silently pre-selected on the operator's behalf. */
  readonly placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, invalid = false, placeholder, className, ...rest },
  ref,
) {
  const classes = ["mn-select", "mn-focus-ring"];
  if (invalid) classes.push("mn-select--invalid");
  if (className !== undefined) classes.push(className);
  return (
    <select
      ref={ref}
      className={classes.join(" ")}
      aria-invalid={invalid ? true : undefined}
      {...rest}
    >
      {placeholder !== undefined ? (
        <option value="" disabled hidden>
          {placeholder}
        </option>
      ) : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
});
