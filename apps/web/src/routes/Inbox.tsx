import { useMemo, useState, type ReactNode } from "react";
import { NodeAttentionKind, type NodeAttention } from "@minions/contracts";
import { Button, Commentary, Fact, NavBar, StateView, StatusBadge } from "@minions/ui-kit";
import { useEventClient } from "../data/use-event-client.js";
import { shortId } from "./home/labels.js";
import { attentionKindLabel } from "./node/steering-labels.js";
import "./Inbox.css";

/**
 * Global attention inbox (PR 50 — attention-and-recovery-ux, PRD UI-05).
 *
 *
 * projection store. The operator sees every question, approval, and blocker that
 * needs a human response, with a deep link to the node console where they can act.
 * Typed filters narrow by attention kind. No attention can disappear solely because
 * transcript history was compacted — attention is a durable projection, not a
 * transcript entry (PRD REC-09).
 */
export function InboxRoute(): ReactNode {
  const { projection, connectionState } = useEventClient();
  const [filter, setFilter] = useState<"all" | "question" | "approval">("all");

  const openAttention = useMemo(() => {
    const items: { attention: NodeAttention; treeId: string }[] = [];
    for (const attention of projection.nodeAttention.values()) {
      if (attention.state.toString() !== "1") continue;
      const node = projection.nodes.get(attention.nodeId);
      const treeId = node?.treeId ?? "(unknown tree)";
      items.push({ attention, treeId });
    }
    return items;
  }, [projection.nodeAttention, projection.nodes]);

  const filtered = useMemo(() => {
    if (filter === "all") return openAttention;
    const kind = filter === "question" ? NodeAttentionKind.QUESTION : NodeAttentionKind.APPROVAL;
    return openAttention.filter((item) => item.attention.kind === kind);
  }, [openAttention, filter]);

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
          <Fact>{String(openAttention.length)} open</Fact>
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
            All ({String(openAttention.length)})
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
        </div>

        {filtered.length === 0 ? (
          <StateView
            kind="empty"
            title="No open attention"
            description="Every question and approval is resolved. New items appear here in realtime."
          />
        ) : (
          <ul className="mn-inbox__list" data-testid="inbox-list">
            {filtered.map(({ attention, treeId }) => {
              const node = projection.nodes.get(attention.nodeId);
              const tree = projection.trees.get(treeId);
              return (
                <li key={attention.id} className="mn-inbox__item" data-testid="inbox-item">
                  <StatusBadge status="warning" label={attentionKindLabel(attention.kind)} />
                  <div className="mn-inbox__item-body">
                    <p className="mn-inbox__prompt">{attention.prompt}</p>
                    {node !== undefined ? (
                      <Fact title={node.id}>node: {node.objective}</Fact>
                    ) : null}
                    {tree !== undefined ? (
                      <Fact title={tree.id}>tree {shortId(tree.id)}</Fact>
                    ) : null}
                  </div>
                  <a className="mn-inbox__link" href={`/tree/${treeId}/node/${attention.nodeId}`}>
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
