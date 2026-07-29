import type { NodeCommandPayload } from "@minions/contracts";

/**
 * Human-readable label for a NodeCommandPayload's oneof case (PR 47). Each case maps to
 * a concise, typed label the operator can scan in the receipt timeline. The payload's
 * inner text (for text-bearing commands) is appended so the operator sees what was said
 * without expanding the row.
 */
export function commandPayloadLabel(payload: NodeCommandPayload): string {
  switch (payload.command.case) {
    case "message":
      return `message: ${payload.command.value.text}`;
    case "steerAfterCurrentTool":
      return `steer after tool: ${payload.command.value.text}`;
    case "interruptNow":
      return "interrupt";
    case "followUpAfterTurn":
      return `follow-up: ${payload.command.value.text}`;
    case "pause":
      return "pause";
    case "resume":
      return "resume";
    case "answer":
      return `answer: ${payload.command.value.answer}`;
    case "approve":
      return "approve";
    case "reject":
      return `reject${payload.command.value.reason !== undefined ? `: ${payload.command.value.reason}` : ""}`;
    case "retry":
      return "retry";
    case "cancelNode":
      return "cancel node";
    case "cancelSubtree":
      return "cancel subtree";
    case "replanUnstartedSubtree":
      return `replan: ${payload.command.value.objective}`;
    case undefined:
      return "unknown";
  }
}
