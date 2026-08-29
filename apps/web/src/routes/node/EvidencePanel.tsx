import type { ReactNode } from "react";
import { CodeDiffViewer, Commentary, Fact } from "@minions/ui-kit";
import type { EvidenceSection } from "./use-evidence.js";

/**
 * Shared evidence panel (PR 49 — evidence-review-panels).
 *
 * Renders the structured evidence sections produced by {@link useEvidence}. Every
 * section names its exact revision/SHA and freshness label up front, then lists its
 * facts — satisfying PR 49's acceptance ("every evidence view names its revision and
 * freshness") and PRD UI-10. Reused across node views rather than reimplemented per
 * surface; individual specialized panels (files/diff, screenshots, gate/CI logs, …)
 * compose into this framework as additional sections once their evidence sources land.
 */

export interface EvidencePanelProps {
  readonly sections: readonly EvidenceSection[];
  readonly emptyMessage?: string;
}

export function EvidencePanel({
  sections,
  emptyMessage = "No evidence recorded for this node yet.",
}: EvidencePanelProps): ReactNode {
  if (sections.length === 0) {
    return <Commentary>{emptyMessage}</Commentary>;
  }
  return (
    <div className="mn-node-console__evidence" data-testid="evidence-panel">
      {sections.map((section) => (
        <section key={section.title} className="mn-evidence__section">
          <header className="mn-evidence__section-header">
            <h3 className="mn-evidence__section-title">{section.title}</h3>
            <span className="mn-evidence__revision" title={section.revision}>
              {section.revision}
            </span>
          </header>
          {section.facts.length > 0 ? (
            <ul className="mn-evidence__facts">
              {section.facts.map((fact, index) => (
                <li
                  key={`${section.title}-${String(index)}-${fact.label}`}
                  className="mn-evidence__fact"
                >
                  <Fact title={fact.title}>{`${fact.label}: ${fact.value}`}</Fact>
                </li>
              ))}
            </ul>
          ) : null}
          {section.diffText !== undefined ? (
            <div
              className="mn-evidence__diff"
              style={{ marginTop: "0.75rem", marginBottom: "0.75rem" }}
            >
              <CodeDiffViewer diffText={section.diffText} />
            </div>
          ) : null}
          <Commentary>{`Source/freshness: ${section.freshness}`}</Commentary>
        </section>
      ))}
    </div>
  );
}
