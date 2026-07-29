import { forwardRef, type HTMLAttributes } from "react";
import "./Card.css";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  readonly padded?: boolean;
}

/** Surface container for grouped content (PR 43 — ui-design-system-shell). */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { padded = true, className, ...rest },
  ref,
) {
  const classes = ["mn-card"];
  if (padded) classes.push("mn-card--padded");
  if (className !== undefined) classes.push(className);
  return <div ref={ref} className={classes.join(" ")} {...rest} />;
});
