import { useMemo, useState, type ReactNode } from "react";
import { AttentionKind, NodeAttentionKind, NodeState } from "@minions/contracts";
import { Button, Commentary, Fact, NavBar, StateView, StatusBadge } from "@minions/ui-kit";
import { useEventClient } from "../data/use-event-client.js";
import { shortId } from "./home/labels.js";
import { attentionKindLabel } from "./node/steering-labels.js";
import "./Inbox.css";

/**
 * Global attention inbox (PR 50 — attention-and-recovery-ux, PRD UI-05).
 *
 * Surfaces EVERYTHING requiring a human response from the durable projection store:
 * node-scoped questions/approvals (with a human-readable prompt) AND the broader
 * AttentionKind signals the projection already carries — authentication, CI failure,
 * conflict, gate failure, parent, quota, unavailable host, node-failed — each pointing
 * at the node that needs action. Typed filters narrow the view; each item deep-links to
 * the node console where the operator can act. A per-tree completion summary is derived
 * from node states so the operator sees honest tree progress alongside the attention.
 *
 * No attention can disappear solely because transcript history was compacted — attention
 * is a durable projection, not a transcript entry (PRD REC-09).
 */

type InboxFilter = "all" | "question" | "approval" | "blockers";

type AttentionItem = Readonly<{
  key: string;
  nodeId: string;
  treeId: string;
  label: string;
  prompt: string | undefined;
  isNodeAttention: boolean;
}>;

type TreeProgress = Readonly<{
  treeId: string;
  total: number;
  terminal: number;
}>;

const TERMINAL_NODE_STATES: ReadonlySet<NodeState> = new Set([
  NodeState.SUCCEEDED,
  NodeState.FAILED,
  NodeState.CANCELLED,
  NodeState.SUPERSEDED,
]);

export function InboxRoute(): ReactNode {
  const { projection, connectionState } = useEventClient();
  const [filter, setFilter] = useState<InboxFilter>("all");

  const openItems = useMemo<readonly AttentionItem[]>(() => {
    const items: AttentionItem[] = [];
    // Node-scoped attention (QUESTION/APPROVAL) carries a human-readable prompt.
    for (const attention of projection.nodeAttention.values()) {
      if (attention.state.toString() !== "1") continue;
      const node = projection.nodes.get(attention.nodeId);
      items.push({
        key: attention.id,
        nodeId: attention.nodeId,
        treeId: node?.treeId ?? "(unknown tree)",
        label: attentionKindLabel(attention.kind),
        prompt: attention.prompt,
        isNodeAttention: true,
      });
    }
    // Broader AttentionKind signals (auth/CI/conflict/gate/quota/host/node-failed/parent)
    // already stored in the projection — these point at a node without a prompt.
    for (const summary of projection.attention.values()) {
      if (summary.kind === AttentionKind.UNSPECIFIED) continue;
      const node = projection.nodes.get(summary.nodeId);
      items.push({
        key: `attention:${summary.nodeId}:${String(summary.kind)}`,
        nodeId: summary.nodeId,
        treeId: node?.treeId ?? "(unknown tree)",
        label: attentionKindBroadLabel(summary.kind),
        prompt: undefined,
        isNodeAttention: false,
      });
    }
    return items;
  }, [projection.nodeAttention, projection.attention, projection.nodes]);

  const filtered = useMemo(() => {
    if (filter === "all") return openItems;
    if (filter === "blockers") {
      return openItems.filter((item) => !item.isNodeAttention);
    }
    const kind = filter === "question" ? NodeAttentionKind.QUESTION : NodeAttentionKind.APPROVAL;
    return openItems.filter(
      (item) => item.isNodeAttention && broadKindMatchesNodeAttention(item.label, kind),
    );
  }, [openItems, filter]);

  const treeProgress = useMemo<readonly TreeProgress[]>(() => {
    const byTree = new Map<string, { total: number; terminal: number }>();
    for (const node of projection.nodes.values()) {
      const entry = byTree.get(node.treeId) ?? { total: 0, terminal: 0 };
      entry.total += 1;
      if (TERMINAL_NODE_STATES.has(node.state)) entry.terminal += 1;
      byTree.set(node.treeId, entry);
    }
    return [...byTree.entries()]
      .map(([treeId, counts]) => ({ treeId, ...counts }))
      .sort((a, b) => a.treeId.localeCompare(b.treeId));
  }, [projection.nodes]);

  const blockerCount = openItems.filter((item) => !item.isNodeAttention).length;

  return (
    <>
      <NavBar brand="Minions">
        <a className="mn-inbox__back" href="/">
          ← Home
        </a>
        <StatusBadge
          status={connectionState === "live" ? "success" : "warning"}
          label={`daemon: ${connectionState}`}
        />
      </NavBar>

      <div className="mn-inbox" data-testid="inbox">
        <div className="mn-inbox__header">
          <h1>Attention inbox</h1>
          <Fact>{String(openItems.length)} open</Fact>
        </div>

        {connectionState !== "live" ? (
          <Commentary>Connection is {connectionState}. Displayed items may be stale.</Commentary>
        ) : null}

        <div className="mn-inbox__filters">
          <Button
            type="button"
            variant={filter === "all" ? "primary" : "secondary"}
            size="sm"
            onClick={() => {
              setFilter("all");
            }}
          >
            All ({String(openItems.length)})
          </Button>
          <Button
            type="button"
            variant={filter === "question" ? "primary" : "secondary"}
            size="sm"
            onClick={() => {
              setFilter("question");
            }}
          >
            Questions
          </Button>
          <Button
            type="button"
            variant={filter === "approval" ? "primary" : "secondary"}
            size="sm"
            onClick={() => {
              setFilter("approval");
            }}
          >
            Approvals
          </Button>
          <Button
            type="button"
            variant={filter === "blockers" ? "primary" : "secondary"}
            size="sm"
            onClick={() => {
              setFilter("blockers");
            }}
          >
            Blockers ({String(blockerCount)})
          </Button>
        </div>

        {treeProgress.length > 0 ? (
          <section className="mn-inbox__progress" data-testid="inbox-progress">
            <h2 className="mn-inbox__progress-title">Tree progress</h2>
            <ul className="mn-inbox__progress-list">
              {treeProgress.map((progress) => (
                <li key={progress.treeId} className="mn-inbox__progress-item">
                  <Fact title={progress.treeId}>
                    tree {shortId(progress.treeId)}: {String(progress.terminal)}/
                    {String(progress.total)} nodes complete
                  </Fact>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {filtered.length === 0 ? (
          <StateView
            kind="empty"
            title="No open attention"
            description="Every question and approval is resolved. New items appear here in realtime."
          />
        ) : (
          <ul className="mn-inbox__list" data-testid="inbox-list">
            {filtered.map((item) => {
              const node = projection.nodes.get(item.nodeId);
              const tree = projection.trees.get(item.treeId);
              return (
                <li key={item.key} className="mn-inbox__item" data-testid="inbox-item">
                  <StatusBadge status="warning" label={item.label} />
                  <div className="mn-inbox__item-body">
                    {item.prompt !== undefined ? (
                      <p className="mn-inbox__prompt">{item.prompt}</p>
                    ) : (
                      <p className="mn-inbox__prompt">{item.label} needs attention</p>
                    )}
                    {node !== undefined ? (
                      <Fact title={node.id}>node: {node.objective}</Fact>
                    ) : null}
                    {tree !== undefined ? (
                      <Fact title={tree.id}>tree {shortId(tree.id)}</Fact>
                    ) : null}
                  </div>
                  <a className="mn-inbox__link" href={`/tree/${item.treeId}/node/${item.nodeId}`}>
                    Open console →
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

/** Human label for the broader (non-node-scoped) AttentionKind values. */
function attentionKindBroadLabel(kind: AttentionKind): string {
  switch (kind) {
    case AttentionKind.AUTHENTICATION:
      return "Authentication";
    case AttentionKind.CI_FAILURE:
      return "CI failure";
    case AttentionKind.CONFLICT:
      return "Conflict";
    case AttentionKind.GATE_FAILURE:
      return "Gate failure";
    case AttentionKind.HUMAN_INPUT:
      return "Human input";
    case AttentionKind.PARENT:
      return "Parent";
    case AttentionKind.QUOTA:
      return "Quota";
    case AttentionKind.UNAVAILABLE_HOST:
      return "Unavailable host";
    case AttentionKind.NODE_FAILED:
      return "Node failed";
    case AttentionKind.UNSPECIFIED:
      return "Attention";
  }
}

/**
 * The node-attention filters (question/approval) match a node-attention item by its
 * NodeAttentionKind label, since the broader AttentionItem carries the label string
 * produced by {@link attentionKindLabel} for node-scoped attention.
 */
function broadKindMatchesNodeAttention(label: string, kind: NodeAttentionKind): boolean {
  return attentionKindLabel(kind) === label;
}
