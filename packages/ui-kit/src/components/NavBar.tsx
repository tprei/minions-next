import type { ReactNode } from "react";
import "./NavBar.css";

export interface NavBarProps {
  readonly brand: ReactNode;
  readonly children?: ReactNode;
}

/**
 * Responsive top app-bar chrome (PR 45, PRD UI-09). Brand on the left, status/actions on the
 * right; below a narrow viewport the actions wrap onto their own full-width row instead of
 * ever forcing horizontal scroll (PRD UI-09 — responsive, no clipped content on mobile).
 */
export function NavBar({ brand, children }: NavBarProps): ReactNode {
  return (
    <header className="mn-navbar">
      <div className="mn-navbar__brand">{brand}</div>
      {children !== undefined ? <div className="mn-navbar__actions">{children}</div> : null}
    </header>
  );
}
