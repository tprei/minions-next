import { useMemo } from "react";
import {
  NodeCommandDeliveryState,
  type NodeAttention,
  type NodeCommand,
  type TaskNode,
} from "@minions/contracts";

/**
 * Evidence query hook (PR 49 — evidence-review-panels).
 *
 * Gathers the evidence already available for one node — from the live projection
 * (command receipts, open attention) and the GetTree response (VCS change binding,
 * lifecycle, output contract) — into a list of typed {@link EvidenceSection} values
 * that the shared {@link EvidencePanel} renders. This is the "evidence query hooks +
 * shared evidence components" framework PR 49's Delegate gates the individual panel
 * implementations on: every section carries its exact revision/SHA and a freshness
 * label so the operator never reviews evidence without knowing which revision it is
 * from and whether it is live (PRD UI-10, acceptance: "every evidence view names its
 * revision and freshness").
 *
 * No evidence is invented: where the underlying RPC/projection does not yet carry a
 * source (e.g. review-header interdiff, gate/CI logs), the section is omitted rather
 * than mocked.
 */

interface EvidenceFact {
  readonly label: string;
  readonly value: string;
  readonly title?: string;
}

export interface EvidenceSection {
  readonly title: string;
  readonly revision: string;
  readonly freshness: string;
  readonly facts: readonly EvidenceFact[];
  readonly diffText?: string;
}

export interface UseEvidenceOptions {
  readonly node: TaskNode | undefined;
  readonly commands: readonly NodeCommand[];
  readonly openAttention: readonly NodeAttention[];
  readonly connectionState: string;
  /** Unified diff of the node's latest attempt; `undefined` when none was captured. */
  readonly diffText?: string;
}

export function useEvidence(options: UseEvidenceOptions): readonly EvidenceSection[] {
  const { node, commands, openAttention, connectionState, diffText } = options;
  return useMemo<readonly EvidenceSection[]>(() => {
    const sections: EvidenceSection[] = [];
    const freshness = `projection (${connectionState})`;

    if (diffText !== undefined) {
      sections.push({
        title: "Code diff",
        revision: node?.id ?? "unknown node",
        freshness: `ChangeService.GetNodeDiff (${connectionState})`,
        facts: [],
        diffText,
      });
    }

    if (node?.vcsChangeBinding !== undefined) {
      const binding = node.vcsChangeBinding;
      sections.push({
        title: "Source control",
        revision: binding.currentCommitId,
        freshness,
        facts: [
          { label: "commit", value: binding.currentCommitId, title: binding.currentCommitId },
          ...(binding.bookmark !== undefined ? [{ label: "branch", value: binding.bookmark }] : []),
          { label: "rewrite generation", value: String(binding.rewriteGeneration) },
        ],
      });
    }

    if (node !== undefined) {
      sections.push({
        title: "Lifecycle",
        revision: `node v${String(node.version)}`,
        freshness,
        facts: [
          { label: "state", value: node.state.toString() },
          { label: "mode", value: node.mode.toString() },
          ...(node.parentNodeId !== undefined
            ? [{ label: "parent", value: node.parentNodeId, title: node.parentNodeId }]
            : []),
        ],
      });
      const outputContractCase = node.outputContract.case;
      if (outputContractCase !== undefined) {
        sections.push({
          title: "Output contract",
          revision: `node v${String(node.version)}`,
          freshness,
          facts: [{ label: "contract", value: outputContractCase }],
        });
      }
    }

    const applied = commands.filter(
      (command) => command.deliveryState === NodeCommandDeliveryState.APPLIED,
    ).length;
    const failed = commands.filter(
      (command) => command.deliveryState === NodeCommandDeliveryState.FAILED,
    ).length;
    if (commands.length > 0) {
      sections.push({
        title: "Steering receipts",
        revision: `${String(commands.length)} commands`,
        freshness,
        facts: [
          { label: "total", value: String(commands.length) },
          { label: "applied", value: String(applied) },
          { label: "failed", value: String(failed) },
        ],
      });
    }

    if (openAttention.length > 0) {
      sections.push({
        title: "Open attention",
        revision: `${String(openAttention.length)} item${openAttention.length === 1 ? "" : "s"}`,
        freshness,
        facts: openAttention.map((attention) => ({
          label: attention.kind.toString(),
          value: attention.prompt,
          title: attention.id,
        })),
      });
    }

    return sections;
  }, [node, commands, openAttention, connectionState, diffText]);
}
