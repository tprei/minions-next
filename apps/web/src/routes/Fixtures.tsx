import type { ReactNode } from "react";
import {
  Button,
  Card,
  Commentary,
  Dialog,
  Fact,
  StateView,
  StatusBadge,
  Tabs,
  type StatusKind,
  type TabItem,
} from "@minions/ui-kit";

/**
 * Deterministic visual fixture route (PR 43 — ui-design-system-shell, PRD UI-12).
 *
 * Renders every ui-kit primitive in every state with no live data, no animation-in-flight
 * timing, and no random content — the blocking visual-regression synthetic (PR 51) screenshots
 * exactly this route at desktop and mobile viewports, under light/dark/system and
 * reduced-motion. Every new primitive MUST get a section here before it ships.
 */
const statusKinds: readonly StatusKind[] = ["neutral", "info", "success", "warning", "danger"];
const tabItems: readonly TabItem[] = [
  { value: "overview", label: "Overview", content: <p>Overview content.</p> },
  { value: "details", label: "Details", content: <p>Details content.</p> },
];

export function FixturesRoute(): ReactNode {
  return (
    <main className="mn-fixtures" data-testid="fixtures-root">
      <h1>Design system fixtures</h1>
      <Section title="Button">
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="danger">Danger</Button>
        <Button variant="primary" disabled>
          Disabled
        </Button>
      </Section>

      <Section title="Card">
        <Card>
          <p>Card content.</p>
        </Card>
      </Section>

      <Section title="StatusBadge">
        {statusKinds.map((status) => (
          <StatusBadge key={status} status={status} label={status} />
        ))}
      </Section>

      <Section title="Provenance">
        <Fact>commit 4a1f9c2 · check_run #482 · completed</Fact>
        <Commentary>
          The failing test looks like a pre-existing flake, not caused by this change.
        </Commentary>
      </Section>

      <Section title="Dialog">
        <Dialog
          trigger={<Button variant="secondary">Open dialog</Button>}
          title="Confirm action"
          description="This is a description of what the dialog will do."
        >
          <p>Dialog body content goes here.</p>
        </Dialog>
      </Section>

      <Section title="Tabs">
        <Tabs items={tabItems} defaultValue="overview" />
      </Section>

      <Section title="StateView">
        <StateView kind="loading" title="Loading" description="Fetching the latest snapshot." />
        <StateView kind="error" title="Something failed" description="The last gate run errored." />
        <StateView kind="offline" title="Host offline" description="Reconnecting to the daemon…" />
        <StateView
          kind="stale"
          title="Showing cached state"
          description="Reconnect for live data."
        />
        <StateView kind="empty" title="Nothing here yet" />
      </Section>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className="mn-fixtures__section" aria-label={title}>
      <h2>{title}</h2>
      <div className="mn-fixtures__row">{children}</div>
    </section>
  );
}
