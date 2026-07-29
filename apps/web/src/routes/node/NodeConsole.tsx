import { useEffect, useMemo, useState, type ReactNode } from "react";
import { create } from "@bufbuild/protobuf";
import {
  AnswerNodeCommandSchema,
  EmptyNodeCommandSchema,
  GetTreeRequestSchema,
  NodeCommandDeliveryState,
  NodeCommandPayloadSchema,
  PlanNodeMode,
  QueueNodeCommandRequestSchema,
  ReplanNodeCommandSchema,
  ResolveApprovalNodeCommandSchema,
  TextNodeCommandSchema,
  type NodeCommandPayload,
  type NodeState,
  type TaskNode,
} from "@minions/contracts";
import {
  Commentary,
  Fact,
  NavBar,
  StateView,
  StatusBadge,
  Tabs,
  type TabItem,
} from "@minions/ui-kit";
import {
  actorSessionId,
  createApiClients,
  generateUuidV7,
  type ApiClients,
} from "../../data/index.js";
import { useEventClient } from "../../data/use-event-client.js";
import { describeConnectError, type TypedError } from "../home/connect-error.js";
import { shortId } from "../home/labels.js";
import { nodeStateBadgeKind, nodeStateLabel } from "../tree/tree-labels.js";
import {
  attentionKindLabel,
  attentionStateBadgeKind,
  attentionStateLabel,
} from "./steering-labels.js";
import { CommandTimeline } from "./CommandTimeline.js";
import { Composer, type SteeringAction } from "./Composer.js";
import "./NodeConsole.css";

/**
 * Live node console (PR 47 — live-node-console-steering, PRD UI-03/UI-04/UI-07/UI-08).
 *
 * The realtime view for one node: its state and mode, the command-receipt timeline (every
 * queued steering command with its delivery lifecycle — queued → sent → acknowledged →
 * applied/failed), any open attention prompt (visually distinct from transcript text per
 * UI-07), the connection-state indicator (never pretend cached state is live — UI-08), and
 * the composer with all 13 steering actions (UI-04). Reached at `/tree/<treeId>/node/<nodeId>`.
 */
export interface NodeConsoleProps {
  readonly treeId: string;
  readonly nodeId: string;
}

export function NodeConsole({ treeId, nodeId }: NodeConsoleProps): ReactNode {
  const { projection, connectionState } = useEventClient();
  const [clients] = useState<ApiClients>(() => createApiClients());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<TypedError | undefined>(undefined);
  const [fetchedObjective, setFetchedObjective] = useState<string | undefined>();
  const [fetchedState, setFetchedState] = useState<NodeState | undefined>();
  const [fetchedNode, setFetchedNode] = useState<TaskNode | undefined>();

  useEffect(() => {
    const controller = new AbortController();
    async function fetchNode(): Promise<void> {
      try {
        const response = await clients.tree.getTree(create(GetTreeRequestSchema, { treeId }));
        if (controller.signal.aborted) return;
        const found = response.tree?.nodes.find((n) => n.id === nodeId);
        if (found !== undefined) {
          setFetchedObjective(found.objective);
          setFetchedState(found.state);
          setFetchedNode(found);
        }
      } catch {
        // Projection store will eventually deliver the node via the event stream.
      }
    }
    void fetchNode();
    return () => {
      controller.abort();
    };
  }, [clients.tree, treeId, nodeId]);

  const liveNode = projection.nodes.get(nodeId);
  const objective = liveNode?.objective ?? fetchedObjective ?? "";
  const state = liveNode?.state ?? fetchedState;
  const commands = useMemo(
    () => [...projection.nodeCommands.values()].filter((cmd) => cmd.nodeId === nodeId),
    [projection.nodeCommands, nodeId],
  );
  const openAttention = useMemo(() => {
    for (const attention of projection.nodeAttention.values()) {
      if (attention.nodeId === nodeId && attention.state.toString() === "1") {
        return attention;
      }
    }
    return undefined;
  }, [projection.nodeAttention, nodeId]);

  async function handleAction(action: SteeringAction): Promise<void> {
    setSubmitting(true);
    setError(undefined);
    try {
      const payload = buildPayload(action);
      await clients.steering.queueNodeCommand(
        create(QueueNodeCommandRequestSchema, {
          commandId: generateUuidV7(),
          actorSessionId: actorSessionId(),
          nodeId,
          payload,
        }),
      );
    } catch (caught) {
      setError(describeConnectError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  if (objective.length === 0) {
    return (
      <div className="mn-node-console" data-testid="node-console">
        <NavBar brand="Minions">
          <a className="mn-node-console__back" href={`/tree/${treeId}`}>
            ← Back to tree
          </a>
          <StatusBadge
            status={connectionState === "live" ? "success" : "warning"}
            label={`daemon: ${connectionState}`}
          />
        </NavBar>
        <StateView
          kind="loading"
          title="Loading node…"
          description="Waiting for the node to appear in the event stream."
        />
      </div>
    );
  }

  return (
    <div className="mn-node-console" data-testid="node-console">
      <NavBar brand="Minions">
        <a className="mn-node-console__back" href={`/tree/${treeId}`} data-testid="node-back-link">
          ← Back to tree
        </a>
        <StatusBadge
          status={connectionState === "live" ? "success" : "warning"}
          label={`daemon: ${connectionState}`}
          data-testid="connection-state"
        />
      </NavBar>

      <div className="mn-node-console__header">
        <div className="mn-node-console__title">
          <h1>{objective || "(untitled node)"}</h1>
          {state !== undefined ? (
            <StatusBadge status={nodeStateBadgeKind(state)} label={nodeStateLabel(state)} />
          ) : null}
        </div>
        <Fact title={nodeId}>node {shortId(nodeId)}</Fact>
      </div>

      {connectionState !== "live" ? (
        <Commentary>
          Connection is {connectionState}. Displayed state may be stale — the UI never pretends
          cached data is live.
        </Commentary>
      ) : null}

      {openAttention !== undefined ? (
        <div className="mn-node-console__attention" data-testid="node-attention" role="status">
          <StatusBadge
            status={attentionStateBadgeKind(openAttention.state)}
            label={`${attentionKindLabel(openAttention.kind)} ${attentionStateLabel(openAttention.state)}`}
          />
          <Commentary>{openAttention.prompt}</Commentary>
          {openAttention.choices.length > 0 ? (
            <ul className="mn-node-console__choices">
              {openAttention.choices.map((choice, index) => (
                <li key={`${String(index)}-${choice}`}>{choice}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {(() => {
        const commandCount = commands.length;
        const appliedCount = commands.filter(
          (c) => c.deliveryState === NodeCommandDeliveryState.APPLIED,
        ).length;
        const failedCount = commands.filter(
          (c) => c.deliveryState === NodeCommandDeliveryState.FAILED,
        ).length;
        const tabItems: TabItem[] = [
          {
            value: "console",
            label: "Console",
            content: (
              <>
                <CommandTimeline commands={commands} />
                <h2 className="mn-node-console__section">Steer</h2>
                <Composer
                  openAttention={openAttention}
                  submitting={submitting}
                  error={error}
                  onAction={(action) => {
                    void handleAction(action);
                  }}
                />
              </>
            ),
          },
          {
            value: "context",
            label: "Context",
            content: (
              <div className="mn-node-console__evidence" data-testid="context-panel">
                {fetchedNode !== undefined ? (
                  <>
                    <Fact>
                      mode: {fetchedNode.mode !== PlanNodeMode.UNSPECIFIED ? "set" : "unspecified"}
                    </Fact>
                    <Fact>check profile: {fetchedNode.checkProfile || "(unset)"}</Fact>
                    <Fact>
                      allowed paths: {fetchedNode.allowedRepositoryPaths.join(", ") || "(none)"}
                    </Fact>
                    {fetchedNode.acceptanceCriteria.length > 0 ? (
                      <div>
                        <strong>Acceptance criteria</strong>
                        <ul>
                          {fetchedNode.acceptanceCriteria.map((criterion, index) => (
                            <li key={`${String(index)}-${criterion}`}>{criterion}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <Commentary>Node details not yet loaded from GetTree.</Commentary>
                )}
                <Commentary>Source: GetTree response. Freshness: {connectionState}.</Commentary>
              </div>
            ),
          },
          {
            value: "evidence",
            label: "Evidence",
            content: (
              <div className="mn-node-console__evidence" data-testid="evidence-panel">
                <Fact>
                  commands: {String(commandCount)} ({String(appliedCount)} applied,{" "}
                  {String(failedCount)} failed)
                </Fact>
                {fetchedNode?.vcsChangeBinding !== undefined ? (
                  <>
                    <Fact title={fetchedNode.vcsChangeBinding.currentCommitId}>
                      commit {shortId(fetchedNode.vcsChangeBinding.currentCommitId)}
                    </Fact>
                    {fetchedNode.vcsChangeBinding.bookmark !== undefined ? (
                      <Fact>branch: {fetchedNode.vcsChangeBinding.bookmark}</Fact>
                    ) : null}
                    <Fact>
                      rewrite generation: {String(fetchedNode.vcsChangeBinding.rewriteGeneration)}
                    </Fact>
                  </>
                ) : (
                  <Commentary>No VCS change binding recorded for this node.</Commentary>
                )}
                <Commentary>
                  Source: projection store (live) + GetTree. Freshness: {connectionState}.
                </Commentary>
              </div>
            ),
          },
        ];
        return <Tabs items={tabItems} defaultValue="console" />;
      })()}
    </div>
  );
}

/**
 * Maps a SteeringAction to the protobuf NodeCommandPayload oneof case + inner message.
 * This is the single place where the UI's action vocabulary meets the wire format.
 */
function buildPayload(action: SteeringAction): NodeCommandPayload {
  switch (action.kind) {
    case "message":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "message",
          value: create(TextNodeCommandSchema, { text: action.text }),
        },
      });
    case "steerAfterCurrentTool":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "steerAfterCurrentTool",
          value: create(TextNodeCommandSchema, { text: action.text }),
        },
      });
    case "followUpAfterTurn":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "followUpAfterTurn",
          value: create(TextNodeCommandSchema, { text: action.text }),
        },
      });
    case "interruptNow":
      return create(NodeCommandPayloadSchema, {
        command: { case: "interruptNow", value: create(EmptyNodeCommandSchema) },
      });
    case "pause":
      return create(NodeCommandPayloadSchema, {
        command: { case: "pause", value: create(EmptyNodeCommandSchema) },
      });
    case "resume":
      return create(NodeCommandPayloadSchema, {
        command: { case: "resume", value: create(EmptyNodeCommandSchema) },
      });
    case "retry":
      return create(NodeCommandPayloadSchema, {
        command: { case: "retry", value: create(EmptyNodeCommandSchema) },
      });
    case "cancelNode":
      return create(NodeCommandPayloadSchema, {
        command: { case: "cancelNode", value: create(EmptyNodeCommandSchema) },
      });
    case "cancelSubtree":
      return create(NodeCommandPayloadSchema, {
        command: { case: "cancelSubtree", value: create(EmptyNodeCommandSchema) },
      });
    case "replanUnstartedSubtree":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "replanUnstartedSubtree",
          value: create(ReplanNodeCommandSchema, { objective: action.objective }),
        },
      });
    case "answer":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "answer",
          value: create(AnswerNodeCommandSchema, {
            attentionId: action.attentionId,
            answer: action.answer,
          }),
        },
      });
    case "approve":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "approve",
          value: create(ResolveApprovalNodeCommandSchema, {
            attentionId: action.attentionId,
          }),
        },
      });
    case "reject":
      return create(NodeCommandPayloadSchema, {
        command: {
          case: "reject",
          value: create(ResolveApprovalNodeCommandSchema, {
            attentionId: action.attentionId,
          }),
        },
      });
  }
}
