import type { ReactNode } from "react";
import {
  Button,
  Card,
  Commentary,
  Dialog,
  DiffList,
  Fact,
  Field,
  NavBar,
  Select,
  StateView,
  StatusBadge,
  Tabs,
  TextArea,
  TextInput,
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

      <Section title="Field">
        <Field
          label="Repository path"
          htmlFor="fixture-field-hint"
          hint="Absolute path on the host filesystem."
        >
          <TextInput id="fixture-field-hint" defaultValue="/home/user/code/example" />
        </Field>
        <Field label="Goal" htmlFor="fixture-field-error" error="Goal is required.">
          <TextInput
            id="fixture-field-error"
            invalid
            aria-describedby="fixture-field-error-error"
          />
        </Field>
      </Section>

      <Section title="TextInput">
        <TextInput aria-label="Placeholder example" placeholder="Placeholder" />
        <TextInput aria-label="Filled example" defaultValue="Filled value" />
        <TextInput aria-label="Invalid example" invalid defaultValue="Invalid value" />
        <TextInput aria-label="Disabled example" defaultValue="Disabled" disabled />
      </Section>

      <Section title="TextArea">
        <TextArea aria-label="Placeholder example" placeholder="Describe the goal…" />
        <TextArea aria-label="Invalid example" invalid defaultValue="Invalid value" />
      </Section>

      <Section title="Select">
        <Select
          aria-label="Placeholder example"
          placeholder="Select a host"
          options={[
            { value: "a", label: "Host A" },
            { value: "b", label: "Host B" },
          ]}
        />
        <Select
          aria-label="Invalid example"
          invalid
          options={[{ value: "a", label: "Host A" }]}
          defaultValue="a"
        />
      </Section>

      <Section title="NavBar">
        <NavBar brand="Minions">
          <StatusBadge status="success" label="daemon: live" />
          <Button variant="secondary" size="sm">
            Light
          </Button>
        </NavBar>
      </Section>

      <Section title="DiffList">
        <DiffList
          entries={[
            { key: "1", kind: "added", label: "Write the migration script" },
            {
              key: "2",
              kind: "changed",
              label: "Update the settings screen",
              detail: "objective, allowed paths",
            },
            { key: "3", kind: "removed", label: "Old draft: refactor the sidebar" },
            { key: "4", kind: "unchanged", label: "Ship the release notes" },
          ]}
        />
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
