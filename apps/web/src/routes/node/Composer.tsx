import { useState, type ReactNode } from "react";
import { NodeAttentionKind, type NodeAttention } from "@minions/contracts";
import { Button, Field, TextArea, TextInput } from "@minions/ui-kit";
import type { TypedError } from "../home/connect-error.js";
import "./Composer.css";

/**
 * Every steering action the composer can emit (PR 47 — live-node-console-steering, PRD
 * UI-04). Each variant maps 1:1 to a NodeCommandPayload oneof case — the parent
 * (NodeConsole) builds the actual protobuf payload and calls QueueNodeCommand.
 */
export type SteeringAction =
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "steerAfterCurrentTool"; readonly text: string }
  | { readonly kind: "followUpAfterTurn"; readonly text: string }
  | { readonly kind: "interruptNow" }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "retry" }
  | { readonly kind: "cancelNode" }
  | { readonly kind: "cancelSubtree" }
  | { readonly kind: "replanUnstartedSubtree"; readonly objective: string }
  | { readonly kind: "answer"; readonly attentionId: string; readonly answer: string }
  | { readonly kind: "approve"; readonly attentionId: string }
  | { readonly kind: "reject"; readonly attentionId: string };

/**
 * Steering command composer (PR 47 — live-node-console-steering, PRD UI-04).
 *
 * Offers every action the node composer MUST expose: immediate message steer,
 * steer-after-current-tool, follow-up, interrupt, pause/resume, answer (to an open
 * question attention), approve/reject (to an open approval attention), retry,
 * cancel-node, cancel-subtree, and replan-unstarted-subtree.
 */
export interface ComposerProps {
  readonly openAttention: NodeAttention | undefined;
  readonly submitting: boolean;
  readonly error: TypedError | undefined;
  readonly onAction: (action: SteeringAction) => void;
}

export function Composer({ openAttention, submitting, error, onAction }: ComposerProps): ReactNode {
  const [text, setText] = useState("");
  const [replanObjective, setReplanObjective] = useState("");
  const [answer, setAnswer] = useState("");
  const [showReplan, setShowReplan] = useState(false);

  const hasText = text.trim().length > 0;

  return (
    <div className="mn-composer" data-testid="composer">
      {error !== undefined ? (
        <p className="mn-form-error" role="alert">
          <strong>{error.code}:</strong> {error.message}
        </p>
      ) : null}

      {openAttention !== undefined ? (
        <div className="mn-composer__attention" data-testid="composer-attention" role="status">
          <strong>
            {openAttention.kind === NodeAttentionKind.QUESTION ? "Question" : "Approval"}
          </strong>
          <span>{openAttention.prompt}</span>
          {openAttention.choices.length > 0 ? (
            <ul>
              {openAttention.choices.map((choice, index) => (
                <li key={`${String(index)}-${choice}`}>{choice}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <Field label="Steer this node" htmlFor="composer-text">
        <TextArea
          id="composer-text"
          value={text}
          placeholder="Type an immediate steering message…"
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </Field>

      <div className="mn-composer__actions">
        <Button
          type="button"
          disabled={submitting || !hasText}
          onClick={() => {
            onAction({ kind: "message", text });
            setText("");
          }}
        >
          Send
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={submitting || !hasText}
          onClick={() => {
            onAction({ kind: "steerAfterCurrentTool", text });
            setText("");
          }}
        >
          Steer after tool
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={submitting || !hasText}
          onClick={() => {
            onAction({ kind: "followUpAfterTurn", text });
            setText("");
          }}
        >
          Follow-up
        </Button>
        <Button
          type="button"
          variant="danger"
          disabled={submitting}
          onClick={() => {
            onAction({ kind: "interruptNow" });
          }}
        >
          Interrupt
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={submitting}
          onClick={() => {
            onAction({ kind: "pause" });
          }}
        >
          Pause
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={submitting}
          onClick={() => {
            onAction({ kind: "resume" });
          }}
        >
          Resume
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={submitting}
          onClick={() => {
            onAction({ kind: "retry" });
          }}
        >
          Retry
        </Button>
        <Button
          type="button"
          variant="danger"
          disabled={submitting}
          onClick={() => {
            onAction({ kind: "cancelNode" });
          }}
        >
          Cancel node
        </Button>
        <Button
          type="button"
          variant="danger"
          disabled={submitting}
          onClick={() => {
            onAction({ kind: "cancelSubtree" });
          }}
        >
          Cancel subtree
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={submitting || showReplan}
          onClick={() => {
            setShowReplan(true);
          }}
        >
          Replan
        </Button>
      </div>

      {openAttention?.kind === NodeAttentionKind.QUESTION ? (
        <Field label="Answer" htmlFor="composer-answer">
          <TextInput
            id="composer-answer"
            value={answer}
            placeholder="Type your answer…"
            onChange={(event) => {
              setAnswer(event.target.value);
            }}
          />
          <Button
            type="button"
            disabled={submitting || answer.trim().length === 0}
            onClick={() => {
              onAction({ kind: "answer", attentionId: openAttention.id, answer });
              setAnswer("");
            }}
          >
            Send answer
          </Button>
        </Field>
      ) : null}

      {openAttention?.kind === NodeAttentionKind.APPROVAL ? (
        <div className="mn-composer__approval">
          <Button
            type="button"
            disabled={submitting}
            onClick={() => {
              onAction({ kind: "approve", attentionId: openAttention.id });
            }}
          >
            Approve
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={submitting}
            onClick={() => {
              onAction({ kind: "reject", attentionId: openAttention.id });
            }}
          >
            Reject
          </Button>
        </div>
      ) : null}

      {showReplan ? (
        <Field label="Replan objective" htmlFor="composer-replan">
          <TextInput
            id="composer-replan"
            value={replanObjective}
            placeholder="New objective for the unstarted subtree…"
            onChange={(event) => {
              setReplanObjective(event.target.value);
            }}
          />
          <Button
            type="button"
            disabled={submitting || replanObjective.trim().length === 0}
            onClick={() => {
              onAction({ kind: "replanUnstartedSubtree", objective: replanObjective });
              setReplanObjective("");
              setShowReplan(false);
            }}
          >
            Replan subtree
          </Button>
        </Field>
      ) : null}
    </div>
  );
}
