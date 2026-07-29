import type { ReactNode } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import "./Tabs.css";

/**
 * Tabbed content switcher (PR 43 — ui-design-system-shell, PRD UI-09).
 *
 * Composes Radix's Tabs primitives directly — roving-tabindex arrow-key navigation between
 * triggers and the `tablist`/`tab`/`tabpanel` ARIA roles come from Radix and are never
 * reimplemented here. The active tab is marked by more than a color swap (a bottom border
 * plus a font-weight change) so the state reads independent of hue perception (WCAG 2.2 AA
 * "use of color").
 */
export interface TabItem {
  readonly value: string;
  readonly label: string;
  readonly content: ReactNode;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  /** Defaults to the first item's value so a tab is always selected. */
  readonly defaultValue?: string;
}

export function Tabs({ items, defaultValue }: TabsProps): ReactNode {
  const initialValue = defaultValue ?? items[0]?.value;
  return (
    <TabsPrimitive.Root
      className="mn-tabs"
      {...(initialValue !== undefined ? { defaultValue: initialValue } : {})}
    >
      <TabsPrimitive.List className="mn-tabs__list">
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            className="mn-tabs__trigger mn-focus-ring"
          >
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {items.map((item) => (
        <TabsPrimitive.Content
          key={item.value}
          value={item.value}
          className="mn-tabs__content mn-focus-ring"
        >
          {item.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
