import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import "./Dialog.css";

/**
 * Modal dialog (PR 43 — ui-design-system-shell, PRD UI-09).
 *
 * Composes Radix's Dialog primitives directly — focus trapping, ESC-to-close, return-focus,
 * and ARIA roles all come from Radix and are never reimplemented here. `trigger` is rendered
 * via Radix's `asChild`, so it must be a single focusable element (typically a `Button`); no
 * extra wrapper element is introduced around it. `Dialog.Title` is required for a11y and is
 * always rendered — hide it visually with `.mn-visually-hidden` only when a design explicitly
 * wants no visible title.
 */
export interface DialogProps {
  readonly trigger: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
  /** Controlled open state. Omit for Radix's default uncontrolled behavior (starts closed). */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export function Dialog({
  trigger,
  title,
  description,
  children,
  open,
  onOpenChange,
}: DialogProps): ReactNode {
  return (
    <DialogPrimitive.Root
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange !== undefined ? { onOpenChange } : {})}
    >
      <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="mn-dialog__overlay" />
        <DialogPrimitive.Content className="mn-dialog__content mn-focus-ring">
          <DialogPrimitive.Title className="mn-dialog__title">{title}</DialogPrimitive.Title>
          {description !== undefined ? (
            <DialogPrimitive.Description className="mn-dialog__description">
              {description}
            </DialogPrimitive.Description>
          ) : null}
          {children !== undefined ? <div className="mn-dialog__body">{children}</div> : null}
          <DialogPrimitive.Close asChild>
            <button
              type="button"
              className="mn-dialog__close mn-focus-ring"
              aria-label="Close dialog"
            >
              <span aria-hidden="true">×</span>
            </button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
