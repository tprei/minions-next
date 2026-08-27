import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { create } from "@bufbuild/protobuf";
import {
  ApprovePlanRequestSchema,
  GetTreeRequestSchema,
  PlanAttentionKind,
  PlanAttentionState,
  PlanRevisionState,
  ProposePlanRequestSchema,
  RepairPlanRequestSchema,
  type TaskTree,
} from "@minions/contracts";
import {
  Button,
  Commentary,
  Fact,
  Field,
  NavBar,
  StateView,
  StatusBadge,
  Tabs,
  TextArea,
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
import { shortId, treeStateBadgeKind, treeStateLabel } from "../home/labels.js";
import { NodeEditorPanel } from "./NodeEditorPanel.js";
import { PlanDiffPanel } from "./PlanDiffPanel.js";
import { RevisionHistory } from "./RevisionHistory.js";
import { planAttentionKindLabel } from "./tree-labels.js";
import {
  addWorkingNode,
  buildCanvasTree,
  buildProposedNodes,
  computeBudgetUsage,
  computePlanDiff,
  computeStaleInputs,
  flattenOutline,
  hasPendingChanges,
  indexNodesById,
  removeWorkingNode,
  reparentWorkingNode,
  seedWorkingTree,
  updateWorkingNode,
  validateWorkingTree,
  type WorkingNodePatch,
  type WorkingTree,
} from "./tree-model.js";
import { TreeCanvas } from "./TreeCanvas.js";
import { TreeOutline } from "./TreeOutline.js";
import "./TreeRoute.css";

/**
 * Plan tree editor/approval screen (PR 46 — plan-tree-editor-approval). Reached after
 * `CreateTree` (see NewTaskDialog's "Open tree" link) or by following a task link from the
 * host/repository home screen (RepositoryCard). Loads the FULL `TaskTree` once via `GetTree`
 * (the lightweight `TreeSummary`/`NodeSummary` projection PR 45 uses for the fleet overview
 * doesn't carry acceptance criteria, output contracts, or allowed paths); every
 * `ProposePlan`/`RepairPlan`/`ApprovePlan` call returns the complete updated `TaskTree` in its
 * own response, so the editor re-seeds directly from that rather than issuing a second
 * `GetTree` round-trip after every mutation. It still watches the live event projection's
 * `TreeSummary.version` to detect an out-of-band change (another session/CLI invocation) and
 * offers a manual reload rather than silently overwriting in-progress edits.
 */
export function TreeRoute(): ReactNode {
  const params = useParams<{ treeId: string }>();
  const treeId = params.treeId ?? "";
  const clients = useMemo<ApiClients>(() => createApiClients(), []);
  const { projection, connectionState } = useEventClient();

  const [tree, setTree] = useState<TaskTree | undefined>(undefined);
  const [workingTree, setWorkingTree] = useState<WorkingTree | undefined>(undefined);
  const [goalDraft, setGoalDraft] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<TypedError | undefined>(undefined);
  const [submitError, setSubmitError] = useState<TypedError | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [showValidation, setShowValidation] = useState(false);

  const applyFreshTree = useCallback((next: TaskTree) => {
    setTree(next);
    setWorkingTree(seedWorkingTree(next));
    setGoalDraft(next.goal);
    setSelectedKey((current) => {
      if (current === next.rootNodeId) return current;
      if (current !== undefined && next.nodes.some((node) => node.id === current)) return current;
      return next.rootNodeId;
    });
    setSubmitError(undefined);
    setShowValidation(false);
  }, []);

  const loadTree = useCallback(async () => {
    try {
      const response = await clients.tree.getTree(create(GetTreeRequestSchema, { treeId }));
      if (response.tree === undefined) throw new Error("daemon returned no tree");
      applyFreshTree(response.tree);
      setLoadError(undefined);
    } catch (caught) {
      setLoadError(describeConnectError(caught));
    } finally {
      setLoading(false);
    }
  }, [clients.tree, treeId, applyFreshTree]);

  useEffect(() => {
    const controller = new AbortController();
    async function fetchTree(): Promise<void> {
      try {
        const response = await clients.tree.getTree(create(GetTreeRequestSchema, { treeId }));
        if (controller.signal.aborted) return;
        if (response.tree === undefined) throw new Error("daemon returned no tree");
        applyFreshTree(response.tree);
        setLoadError(undefined);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setLoadError(describeConnectError(caught));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void fetchTree();
    return () => {
      controller.abort();
    };
  }, [clients.tree, treeId, applyFreshTree]);

  const staleInputs = useMemo(
    () => (workingTree === undefined ? [] : computeStaleInputs(workingTree)),
    [workingTree],
  );
  const staleNodeKeys = useMemo(
    () => new Set(staleInputs.map((input) => input.nodeKey)),
    [staleInputs],
  );
  const outlineRows = useMemo(
    () => (workingTree === undefined ? [] : flattenOutline(workingTree, staleNodeKeys)),
    [workingTree, staleNodeKeys],
  );
  const canvasRoot = useMemo(
    () => (workingTree === undefined ? undefined : buildCanvasTree(workingTree, staleNodeKeys)),
    [workingTree, staleNodeKeys],
  );
  const originalNodesById = useMemo(
    () => (tree === undefined ? new Map() : indexNodesById(tree)),
    [tree],
  );
  const diffEntries = useMemo(
    () => (workingTree === undefined ? [] : computePlanDiff(workingTree, originalNodesById)),
    [workingTree, originalNodesById],
  );
  const budgetUsage = useMemo(
    () => (workingTree === undefined ? undefined : computeBudgetUsage(workingTree)),
    [workingTree],
  );
  const validationIssues = useMemo(() => {
    if (workingTree === undefined || tree?.budget === undefined) return [];
    return validateWorkingTree(workingTree, tree.budget);
  }, [workingTree, tree]);
  const consoleNodeId = useMemo(() => {
    if (workingTree === undefined || selectedKey === undefined) return undefined;
    const locked = workingTree.locked.get(selectedKey);
    if (locked !== undefined) return locked.id;
    const working = workingTree.working.find((node) => node.key === selectedKey);
    return working?.sourceNodeId;
  }, [workingTree, selectedKey]);

  const attention = tree?.attention;
  const attentionOpen = attention?.state === PlanAttentionState.OPEN;
  const isRepairMode = attentionOpen && attention.kind !== PlanAttentionKind.PLAN_REQUIRED;
  const activeRevision = tree?.revisions.find(
    (revision) => revision.id === tree.activePlanRevisionId,
  );
  const canApprove =
    tree !== undefined && activeRevision?.state === PlanRevisionState.DRAFT && !attentionOpen;
  const goalChanged = tree !== undefined && goalDraft.trim() !== tree.goal;
  const pendingChanges = hasPendingChanges(diffEntries) || goalChanged;

  const liveVersion = projection.trees.get(treeId)?.version;
  const isStale = tree !== undefined && liveVersion !== undefined && liveVersion > tree.version;

  function handleAddChild(parentKey: string): void {
    if (workingTree === undefined) return;
    const result = addWorkingNode(workingTree, parentKey);
    setWorkingTree(result.tree);
    setSelectedKey(result.key);
  }

  function handleRemove(key: string): void {
    if (workingTree === undefined) return;
    setWorkingTree(removeWorkingNode(workingTree, key));
    setSelectedKey(tree?.rootNodeId);
  }

  function handleReparent(key: string, newParentKey: string): void {
    if (workingTree === undefined) return;
    setWorkingTree(reparentWorkingNode(workingTree, key, newParentKey));
  }

  function handlePatch(key: string, patch: WorkingNodePatch): void {
    if (workingTree === undefined) return;
    setWorkingTree(updateWorkingNode(workingTree, key, patch));
  }

  function handleReject(): void {
    if (tree === undefined) return;
    setWorkingTree(seedWorkingTree(tree));
    setGoalDraft(tree.goal);
    setSubmitError(undefined);
    setShowValidation(false);
  }

  async function handleSave(): Promise<void> {
    if (tree === undefined || workingTree === undefined) return;
    setShowValidation(true);
    if (goalDraft.trim().length === 0 || validationIssues.length > 0) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const nodes = buildProposedNodes(workingTree);
      const planRevisionId = generateUuidV7();
      const currentAttention = tree.attention;
      const response =
        currentAttention?.state === PlanAttentionState.OPEN &&
        currentAttention.kind !== PlanAttentionKind.PLAN_REQUIRED
          ? await clients.tree.repairPlan(
              create(RepairPlanRequestSchema, {
                commandId: generateUuidV7(),
                actorSessionId: actorSessionId(),
                treeId,
                planRevisionId,
                attentionId: currentAttention.id,
                goal: goalDraft.trim(),
                nodes,
              }),
            )
          : await clients.tree.proposePlan(
              create(ProposePlanRequestSchema, {
                commandId: generateUuidV7(),
                actorSessionId: actorSessionId(),
                treeId,
                planRevisionId,
                goal: goalDraft.trim(),
                nodes,
              }),
            );
      if (response.tree === undefined) throw new Error("daemon returned no tree");
      applyFreshTree(response.tree);
    } catch (caught) {
      setSubmitError(describeConnectError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleApprove(): Promise<void> {
    if (tree === undefined) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const response = await clients.tree.approvePlan(
        create(ApprovePlanRequestSchema, {
          commandId: generateUuidV7(),
          actorSessionId: actorSessionId(),
          treeId,
          planRevisionId: tree.activePlanRevisionId,
        }),
      );
      if (response.tree === undefined) throw new Error("daemon returned no tree");
      applyFreshTree(response.tree);
    } catch (caught) {
      setSubmitError(describeConnectError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && tree === undefined) {
    return (
      <main className="mn-tree-route" data-testid="tree-root">
        <StateView
          kind="loading"
          title="Loading tree…"
          description="Fetching the plan from the daemon."
        />
      </main>
    );
  }

  if (loadError !== undefined) {
    return (
      <main className="mn-tree-route" data-testid="tree-root">
        <StateView
          kind="error"
          title="Could not load this tree"
          description={`${loadError.code}: ${loadError.message}`}
          action={
            <Button
              onClick={() => {
                setLoading(true);
                void loadTree();
              }}
            >
              Retry
            </Button>
          }
        />
      </main>
    );
  }

  if (tree === undefined || workingTree === undefined || canvasRoot === undefined) {
    return (
      <main className="mn-tree-route" data-testid="tree-root">
        <StateView kind="empty" title="No tree loaded" />
      </main>
    );
  }

  const tabItems: TabItem[] = [
    {
      value: "outline",
      label: "Outline",
      content: (
        <div className="mn-tree-editor__split">
          <TreeOutline rows={outlineRows} selectedKey={selectedKey} onSelect={setSelectedKey} />
          <NodeEditorPanel
            tree={workingTree}
            selectedKey={selectedKey}
            staleInputs={staleInputs}
            onAddChild={handleAddChild}
            onRemove={handleRemove}
            onReparent={handleReparent}
            onPatch={handlePatch}
          />
        </div>
      ),
    },
    {
      value: "canvas",
      label: "Canvas",
      content: <TreeCanvas root={canvasRoot} selectedKey={selectedKey} onSelect={setSelectedKey} />,
    },
    {
      value: "diff",
      label: "Diff",
      content: <PlanDiffPanel entries={diffEntries} />,
    },
    {
      value: "revisions",
      label: "Revisions",
      content: (
        <RevisionHistory revisions={tree.revisions} activeRevisionId={tree.activePlanRevisionId} />
      ),
    },
  ];

  return (
    <>
      <NavBar brand="Minions">
        <Link className="mn-tree-route__back" to="/" data-testid="tree-back-link">
          ← Back to hosts
        </Link>
        <StatusBadge
          status={connectionState === "live" ? "success" : "warning"}
          label={`daemon: ${connectionState}`}
        />
      </NavBar>

      <main className="mn-tree-route" data-testid="tree-root">
        <div className="mn-tree-route__header">
          <div className="mn-tree-route__title">
            <h1>{tree.goal}</h1>
            <StatusBadge
              status={treeStateBadgeKind(tree.state)}
              label={treeStateLabel(tree.state)}
            />
          </div>
          <Fact title={tree.id}>tree {shortId(tree.id)}</Fact>
          {selectedKey !== undefined && consoleNodeId !== undefined ? (
            <Link
              className="mn-tree-route__console-link"
              to={`/tree/${treeId}/node/${consoleNodeId}`}
            >
              Open node console →
            </Link>
          ) : null}
        </div>

        {isStale ? (
          <StateView
            kind="stale"
            title="This tree changed elsewhere"
            description="Another session updated this plan. Reload before continuing so you don't overwrite it."
            action={
              <Button
                onClick={() => {
                  void loadTree();
                }}
              >
                Reload
              </Button>
            }
          />
        ) : null}

        {attentionOpen ? (
          <div className="mn-tree-attention" role="status" data-testid="tree-attention-banner">
            <StatusBadge status="warning" label={planAttentionKindLabel(attention.kind)} />
            <Commentary>{attention.message}</Commentary>
          </div>
        ) : null}

        <div className="mn-tree-route__budget" data-testid="tree-budget-summary">
          <Fact>max depth {tree.budget?.maxDepth}</Fact>
          <Fact>max fan-out {tree.budget?.maxFanOut}</Fact>
          <Fact>max nodes {tree.budget?.maxNodes}</Fact>
          <Fact>max concurrency {tree.budget?.maxConcurrency}</Fact>
          <Fact>max attempts/node {tree.budget?.maxAttemptsPerNode}</Fact>
          {budgetUsage !== undefined ? (
            <Fact>
              using {budgetUsage.nodeCount}/{tree.budget?.maxNodes ?? "?"} nodes, depth{" "}
              {budgetUsage.maxDepthUsed}, fan-out {budgetUsage.maxFanOutUsed}
            </Fact>
          ) : null}
        </div>

        <Field
          label="Goal"
          htmlFor="tree-goal"
          hint="Carried into the next plan revision when you save."
        >
          <TextArea
            id="tree-goal"
            value={goalDraft}
            onChange={(event) => {
              setGoalDraft(event.target.value);
            }}
          />
        </Field>

        <Tabs items={tabItems} defaultValue="outline" />

        {showValidation && validationIssues.length > 0 ? (
          <ul className="mn-tree-route__issues" role="alert" data-testid="tree-validation-issues">
            {validationIssues.map((issue, index) => (
              <li key={`${issue.key ?? "tree"}-${String(index)}`}>{issue.message}</li>
            ))}
          </ul>
        ) : null}

        {submitError !== undefined ? (
          <p className="mn-form-error" role="alert">
            <strong>{submitError.code}:</strong> {submitError.message}
          </p>
        ) : null}

        <div className="mn-dialog-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={submitting || !pendingChanges}
            onClick={handleReject}
          >
            Reject changes
          </Button>
          <Button
            type="button"
            disabled={submitting}
            onClick={() => {
              void handleSave();
            }}
          >
            {submitting ? "Saving…" : isRepairMode ? "Repair plan" : "Save plan"}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={submitting || !canApprove}
            onClick={() => {
              void handleApprove();
            }}
          >
            Approve plan
          </Button>
        </div>
      </main>
    </>
  );
}
