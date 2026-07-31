import type { ReactNode } from "react";
import {
  Button,
  Card,
  Commentary,
  Fact,
  Field,
  Select,
  StateView,
  StatusBadge,
  TextArea,
  TextInput,
  type SelectOption,
} from "@minions/ui-kit";
import { generateUuidV7 } from "../../data/index.js";
import { EditableStringList } from "./EditableStringList.js";
import {
  descendantKeySet,
  validInputSourceOptions,
  validParentOptions,
  type StaleInput,
  type WorkingNodePatch,
  type WorkingTree,
} from "./tree-model.js";
import {
  EDITABLE_PLAN_NODE_MODES,
  nodeStateBadgeKind,
  nodeStateLabel,
  parsePlanNodeModeOption,
  planNodeModeLabel,
  vcsConflictBadgeKind,
  vcsConflictStateLabel,
} from "./tree-labels.js";
import "./NodeEditorPanel.css";

const CHECK_PROFILE_HINTS = ["lint", "typecheck", "tests", "build", "security_review"];
const CHECK_PROFILE_HINTS_ID = "tree-node-check-profile-hints";
const MODE_OPTIONS: readonly SelectOption[] = EDITABLE_PLAN_NODE_MODES.map((mode) => ({
  value: String(mode),
  label: planNodeModeLabel(mode),
}));

/**
 * Detail panel for the currently selected node (PR 46 — plan-tree-editor-approval).
 *
 * Three states: nothing selected, a LOCKED node (root, or started/terminal — read-only, per
 * TREE-07), or a WORKING node (PLANNED/READY — the full edit form). Every control here writes
 * through `onPatch`/`onReparent`/`onAddChild`/`onRemove`, which the tree route wires straight
 * to tree-model.ts's pure mutators — this component holds no tree-shape logic of its own.
 */
export interface NodeEditorPanelProps {
  readonly tree: WorkingTree;
  readonly selectedKey: string | undefined;
  readonly staleInputs: readonly StaleInput[];
  readonly onAddChild: (parentKey: string) => void;
  readonly onRemove: (key: string) => void;
  readonly onReparent: (key: string, newParentKey: string) => void;
  readonly onPatch: (key: string, patch: WorkingNodePatch) => void;
}

export function NodeEditorPanel({
  tree,
  selectedKey,
  staleInputs,
  onAddChild,
  onRemove,
  onReparent,
  onPatch,
}: NodeEditorPanelProps): ReactNode {
  if (selectedKey === undefined) {
    return (
      <Card className="mn-node-editor" data-testid="node-editor-panel">
        <StateView
          kind="empty"
          title="No node selected"
          description="Select a node in the outline or canvas to view or edit it."
        />
      </Card>
    );
  }
  const key = selectedKey;

  const locked = tree.locked.get(key);
  if (locked !== undefined) {
    return (
      <Card className="mn-node-editor" data-testid="node-editor-panel">
        <div className="mn-node-editor__header">
          <h2>{locked.objective}</h2>
          <StatusBadge
            status={nodeStateBadgeKind(locked.state)}
            label={nodeStateLabel(locked.state)}
          />
        </div>
        <Commentary>
          {locked.isRoot
            ? "The root node's definition is fixed for the life of the tree — it can never be reparented, edited, or removed."
            : "This node has started or finished running and can no longer be reparented, edited, or removed (TREE-07)."}
        </Commentary>
        <div className="mn-node-editor__facts">
          <Fact>{planNodeModeLabel(locked.mode)}</Fact>
          <Fact>check profile: {locked.checkProfile}</Fact>
          <Fact>max attempts: {locked.maxAttempts}</Fact>
          <Fact>
            {locked.outputContract.case === "artifact"
              ? `artifact output: ${locked.outputContract.artifactType}`
              : "implementation output"}
          </Fact>
          {locked.allowedRepositoryPaths.map((path) => (
            <Fact key={path}>{path}</Fact>
          ))}
        </div>
        {locked.acceptanceCriteria.length > 0 ? (
          <ul className="mn-node-editor__criteria">
            {locked.acceptanceCriteria.map((criterion) => (
              <li key={criterion}>
                <Fact>{criterion}</Fact>
              </li>
            ))}
          </ul>
        ) : null}
        {locked.vcsChangeBinding !== undefined ? (
          <div className="mn-node-editor__facts">
            {locked.vcsChangeBinding.bookmark !== undefined ? (
              <Fact>branch: {locked.vcsChangeBinding.bookmark}</Fact>
            ) : null}
            <StatusBadge
              status={vcsConflictBadgeKind(locked.vcsChangeBinding.conflictState)}
              label={vcsConflictStateLabel(locked.vcsChangeBinding.conflictState)}
            />
          </div>
        ) : null}
        <div className="mn-dialog-actions">
          <Button
            type="button"
            data-testid="tree-add-child"
            onClick={() => {
              onAddChild(key);
            }}
          >
            Add child
          </Button>
        </div>
      </Card>
    );
  }

  const working = tree.working.find((node) => node.key === key);
  if (working === undefined) {
    return (
      <Card className="mn-node-editor" data-testid="node-editor-panel">
        <StateView
          kind="empty"
          title="Node not found"
          description="This node is no longer part of the plan."
        />
      </Card>
    );
  }

  const nodeStaleInputs = staleInputs.filter((input) => input.nodeKey === key);
  const descendantCount = descendantKeySet(tree, key).size;
  const parentOptions = validParentOptions(tree, key);
  const sourceOptions = validInputSourceOptions(tree, key);
  const usedSourceKeys = new Set(working.inputs.map((input) => input.sourceKey));
  const nextDefaultSource = sourceOptions.find((option) => !usedSourceKeys.has(option.key));

  function patch(fields: WorkingNodePatch): void {
    onPatch(key, fields);
  }

  return (
    <Card className="mn-node-editor" data-testid="node-editor-panel">
      <div className="mn-node-editor__header">
        <h2>Edit node</h2>
        <StatusBadge status="neutral" label="pending" />
      </div>

      <Field label="Parent" htmlFor="tree-node-parent">
        <Select
          id="tree-node-parent"
          value={working.parentKey}
          options={parentOptions.map((option) => ({
            value: option.key,
            label: option.locked ? `${option.label} (locked)` : option.label,
          }))}
          onChange={(event) => {
            onReparent(key, event.target.value);
          }}
        />
      </Field>

      <Field label="Objective" htmlFor="tree-node-objective">
        <TextArea
          id="tree-node-objective"
          value={working.objective}
          onChange={(event) => {
            patch({ objective: event.target.value });
          }}
        />
      </Field>

      <Field label="Mode" htmlFor="tree-node-mode">
        <Select
          id="tree-node-mode"
          value={String(working.mode)}
          options={MODE_OPTIONS}
          onChange={(event) => {
            patch({ mode: parsePlanNodeModeOption(event.target.value) });
          }}
        />
      </Field>

      <EditableStringList
        label="Acceptance criteria"
        idPrefix="tree-node-acceptance-criteria"
        values={working.acceptanceCriteria}
        onChange={(values) => {
          patch({ acceptanceCriteria: values });
        }}
      />

      <EditableStringList
        label="Allowed repository paths"
        idPrefix="tree-node-allowed-path"
        values={working.allowedRepositoryPaths}
        placeholder="."
        onChange={(values) => {
          patch({ allowedRepositoryPaths: values });
        }}
      />

      <Field label="Check profile" htmlFor="tree-node-check-profile">
        <TextInput
          id="tree-node-check-profile"
          list={CHECK_PROFILE_HINTS_ID}
          value={working.checkProfile}
          onChange={(event) => {
            patch({ checkProfile: event.target.value });
          }}
        />
        <datalist id={CHECK_PROFILE_HINTS_ID}>
          {CHECK_PROFILE_HINTS.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </Field>

      <Field label="Output contract" htmlFor="tree-node-output-kind">
        <Select
          id="tree-node-output-kind"
          value={working.outputContract.case}
          options={[
            { value: "implementation", label: "implementation (no artifact)" },
            { value: "artifact", label: "artifact" },
          ]}
          onChange={(event) => {
            patch({
              outputContract:
                event.target.value === "artifact"
                  ? { case: "artifact", artifactType: "" }
                  : { case: "implementation" },
            });
          }}
        />
      </Field>
      {working.outputContract.case === "artifact" ? (
        <Field label="Artifact type" htmlFor="tree-node-artifact-type">
          <TextInput
            id="tree-node-artifact-type"
            value={working.outputContract.artifactType}
            onChange={(event) => {
              patch({ outputContract: { case: "artifact", artifactType: event.target.value } });
            }}
          />
        </Field>
      ) : null}

      <div className="mn-node-editor__inputs">
        <span className="mn-editable-list__label">Artifact inputs (ancestors only)</span>
        {working.inputs.length === 0 ? <p className="mn-muted">No inputs.</p> : null}
        {working.inputs.map((input, index) => {
          const stale = nodeStaleInputs.find((candidate) => candidate.inputKey === input.key);
          const knownOption = sourceOptions.some((option) => option.key === input.sourceKey);
          const options = knownOption
            ? sourceOptions.map((option) => ({ value: option.key, label: option.label }))
            : [
                { value: input.sourceKey, label: `${input.sourceKey} (unavailable)` },
                ...sourceOptions.map((option) => ({ value: option.key, label: option.label })),
              ];
          return (
            <div className="mn-editable-list__row" key={input.key}>
              <Select
                aria-label={`Artifact input ${String(index + 1)}`}
                value={input.sourceKey}
                invalid={stale !== undefined}
                options={options}
                onChange={(event) => {
                  const nextInputs = working.inputs.map((candidate, candidateIndex) =>
                    candidateIndex === index
                      ? { ...candidate, sourceKey: event.target.value }
                      : candidate,
                  );
                  patch({ inputs: nextInputs });
                }}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  patch({
                    inputs: working.inputs.filter((_, candidateIndex) => candidateIndex !== index),
                  });
                }}
              >
                Remove
              </Button>
              {stale !== undefined ? (
                <p className="mn-field__error" role="alert">
                  {stale.detail}
                </p>
              ) : null}
            </div>
          );
        })}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={nextDefaultSource === undefined}
          onClick={() => {
            if (nextDefaultSource === undefined) return;
            patch({
              inputs: [
                ...working.inputs,
                { key: generateUuidV7(), sourceKey: nextDefaultSource.key },
              ],
            });
          }}
        >
          Add input
        </Button>
      </div>

      <div className="mn-dialog-actions">
        <Button
          type="button"
          data-testid="tree-add-child"
          onClick={() => {
            onAddChild(key);
          }}
        >
          Add child
        </Button>
        <Button
          type="button"
          variant="danger"
          data-testid="tree-remove-node"
          onClick={() => {
            onRemove(key);
          }}
        >
          {descendantCount > 0
            ? `Remove node and ${String(descendantCount)} descendant(s)`
            : "Remove node"}
        </Button>
      </div>
    </Card>
  );
}
