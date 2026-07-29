import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Fact, StatusBadge } from "@minions/ui-kit";
import type { NodeCommand } from "@minions/contracts";
import { deliveryStateBadgeKind, deliveryStateLabel } from "./steering-labels.js";
import { commandPayloadLabel } from "./command-payload.js";
import "./CommandTimeline.css";

/**
 * Virtualized command-receipt timeline (PR 47 — live-node-console-steering, PRD UI-10).
 *
 * Shows the ordered history of every `NodeCommand` the daemon has recorded for this node,
 * sourced from the projection store's live `nodeCommands` map (updated in realtime via the
 * event stream). Each row is a receipt: its payload type (message, pause, interrupt, …),
 * its delivery lifecycle badge (queued → sent → acknowledged → applied/failed), and its
 * timestamps. The operator can distinguish requested, delivered, applied, and failed
 * actions at a glance (PRD UI-04).
 *
 * Virtualization follows the same manual windowed-render approach as TreeOutline (PR 46):
 * the row height is fixed and uniform, so only the visible slice is mounted.
 */
export interface CommandTimelineProps {
  readonly commands: readonly NodeCommand[];
}

const ROW_HEIGHT = 48;
const OVERSCAN = 6;

export function CommandTimeline({ commands }: CommandTimelineProps): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(400);

  useEffect(() => {
    const node = containerRef.current;
    if (node === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setViewportHeight(entry.contentRect.height);
    });
    observer.observe(node);
    setViewportHeight(node.clientHeight);
    return () => {
      observer.disconnect();
    };
  }, []);

  const sorted = useMemo(
    () => [...commands].sort((a, b) => Number(a.ordinal) - Number(b.ordinal)),
    [commands],
  );

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(sorted.length, startIndex + visibleCount);
  const visible = useMemo(() => sorted.slice(startIndex, endIndex), [sorted, startIndex, endIndex]);

  // Auto-scroll to bottom when a new command arrives.
  const lastCommand = sorted.length > 0 ? sorted[sorted.length - 1] : undefined;
  const lastOrdinal = lastCommand?.ordinal ?? 0n;
  const prevOrdinalRef = useRef(lastOrdinal);
  useEffect(() => {
    const node = containerRef.current;
    if (node === null) return;
    if (lastOrdinal > prevOrdinalRef.current) {
      node.scrollTop = sorted.length * ROW_HEIGHT;
    }
    prevOrdinalRef.current = lastOrdinal;
  }, [lastOrdinal, sorted.length]);

  return (
    <div
      ref={containerRef}
      className="mn-command-timeline"
      data-testid="command-timeline"
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop);
      }}
    >
      {sorted.length === 0 ? (
        <p className="mn-muted mn-command-timeline__empty">
          No commands yet. Use the composer below to steer this node.
        </p>
      ) : (
        <div style={{ height: sorted.length * ROW_HEIGHT }}>
          <div style={{ transform: `translateY(${String(startIndex * ROW_HEIGHT)}px)` }}>
            {visible.map((command) => (
              <CommandRow key={command.commandId} command={command} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CommandRow({ command }: { readonly command: NodeCommand }): ReactNode {
  return (
    <div className="mn-command-row" data-testid="command-row" style={{ height: ROW_HEIGHT }}>
      <StatusBadge
        status={deliveryStateBadgeKind(command.deliveryState)}
        label={deliveryStateLabel(command.deliveryState)}
      />
      <span className="mn-command-row__payload">
        {command.payload !== undefined ? commandPayloadLabel(command.payload) : "unknown"}
      </span>
      {command.failure !== undefined ? (
        <Fact>
          <strong>failure:</strong> {command.failure}
        </Fact>
      ) : null}
      <span className="mn-command-row__ordinal">#{String(command.ordinal)}</span>
    </div>
  );
}
