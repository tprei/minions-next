import { useState, type ReactNode, type SubmitEvent } from "react";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import {
  CreateTreeRequestSchema,
  TreeBudgetSchema,
  type ExecutionHost,
  type RegisteredRepository,
  type RepositorySummary,
  type TaskTree,
  type TreeService,
} from "@minions/contracts";
import {
  Button,
  Dialog,
  Fact,
  Field,
  Select,
  StatusBadge,
  TextArea,
  TextInput,
  type SelectOption,
} from "@minions/ui-kit";
import { actorSessionId, generateUuidV7 } from "../../data/index.js";
import { describeConnectError, type TypedError } from "./connect-error.js";
import { shortId, treeStateBadgeKind, treeStateLabel } from "./labels.js";
import {
  parseBudgetValue,
  validateBaseCommit,
  validateBudget,
  validateCanonicalRelativePath,
  validateRequiredText,
} from "./validation.js";

export interface NewTaskDialogProps {
  readonly hosts: readonly ExecutionHost[];
  readonly repositories: readonly RepositorySummary[];
  readonly repositoryDetail: ReadonlyMap<string, RegisteredRepository>;
  readonly treeClient: Client<typeof TreeService>;
}

interface FormState {
  hostId: string;
  repositoryId: string;
  goal: string;
  baseCommit: string;
  rootAllowedPath: string;
  rootCheckProfile: string;
  maxDepth: string;
  maxFanOut: string;
  maxNodes: string;
  maxConcurrency: string;
  maxAttemptsPerNode: string;
}

interface FieldErrors {
  host?: string;
  repository?: string;
  goal?: string;
  baseCommit?: string;
  rootAllowedPath?: string;
  rootCheckProfile?: string;
  maxDepth?: string;
  maxFanOut?: string;
  maxNodes?: string;
  maxConcurrency?: string;
  maxAttemptsPerNode?: string;
}

// Sane, bounded defaults for a small local single-host fleet — every value stays well
// within the server's enforced uint32 range (1..4294967295, see validateBudget) and is
// freely editable before submit.
const INITIAL_FORM_STATE: FormState = {
  hostId: "",
  repositoryId: "",
  goal: "",
  baseCommit: "",
  rootAllowedPath: ".",
  rootCheckProfile: "",
  maxDepth: "4",
  maxFanOut: "4",
  maxNodes: "24",
  maxConcurrency: "2",
  maxAttemptsPerNode: "3",
};

// `root_check_profile` is a free-text gate profile name — these are only autocomplete
// hints/placeholders (the 5 GateCategory values this repository's own .minions/gates.yaml
// maps to real commands for). The client enforces nothing beyond non-empty text; the
// daemon is authoritative for whether a named profile actually exists.
const ROOT_CHECK_PROFILE_HINTS = ["lint", "typecheck", "tests", "build", "security_review"];
const ROOT_CHECK_PROFILE_HINTS_ID = "new-task-root-check-profile-hints";

const HOST_FIELD_ID = "new-task-host";
const REPOSITORY_FIELD_ID = "new-task-repository";
const GOAL_FIELD_ID = "new-task-goal";
const BASE_COMMIT_FIELD_ID = "new-task-base-commit";
const ROOT_ALLOWED_PATH_FIELD_ID = "new-task-root-allowed-path";
const ROOT_CHECK_PROFILE_FIELD_ID = "new-task-root-check-profile";
const MAX_DEPTH_FIELD_ID = "new-task-max-depth";
const MAX_FAN_OUT_FIELD_ID = "new-task-max-fan-out";
const MAX_NODES_FIELD_ID = "new-task-max-nodes";
const MAX_CONCURRENCY_FIELD_ID = "new-task-max-concurrency";
const MAX_ATTEMPTS_FIELD_ID = "new-task-max-attempts-per-node";

function validateForm(fields: FormState): FieldErrors {
  const errors: FieldErrors = {};
  if (fields.hostId.length === 0) {
    errors.host = "Select a host.";
  }
  if (fields.repositoryId.length === 0) {
    errors.repository = "Select a repository.";
  }
  const goalError = validateRequiredText(fields.goal, "Goal");
  if (goalError !== undefined) {
    errors.goal = goalError;
  }
  const baseCommitError = validateBaseCommit(fields.baseCommit);
  if (baseCommitError !== undefined) {
    errors.baseCommit = baseCommitError;
  }
  const rootAllowedPathError = validateCanonicalRelativePath(
    fields.rootAllowedPath,
    "Root allowed path",
  );
  if (rootAllowedPathError !== undefined) {
    errors.rootAllowedPath = rootAllowedPathError;
  }
  const rootCheckProfileError = validateRequiredText(fields.rootCheckProfile, "Root check profile");
  if (rootCheckProfileError !== undefined) {
    errors.rootCheckProfile = rootCheckProfileError;
  }
  const maxDepthError = validateBudget(fields.maxDepth, "Max depth");
  if (maxDepthError !== undefined) {
    errors.maxDepth = maxDepthError;
  }
  const maxFanOutError = validateBudget(fields.maxFanOut, "Max fan-out");
  if (maxFanOutError !== undefined) {
    errors.maxFanOut = maxFanOutError;
  }
  const maxNodesError = validateBudget(fields.maxNodes, "Max nodes");
  if (maxNodesError !== undefined) {
    errors.maxNodes = maxNodesError;
  }
  const maxConcurrencyError = validateBudget(fields.maxConcurrency, "Max concurrency");
  if (maxConcurrencyError !== undefined) {
    errors.maxConcurrency = maxConcurrencyError;
  }
  const maxAttemptsError = validateBudget(fields.maxAttemptsPerNode, "Max attempts per node");
  if (maxAttemptsError !== undefined) {
    errors.maxAttemptsPerNode = maxAttemptsError;
  }
  return errors;
}

/**
 * New-task (tree creation) form (PR 45 — host-repository-task-ui, PRD UI-01 "New task"
 * screen). The operator explicitly picks a host, then a repository under that host — no
 * selection is ever implied or pre-authored by the client (PR 45 acceptance: "create a tree
 * from one explicit boundary"). `CreateTreeRequest` has no `mode`/`attachments` field in the
 * actual proto (proto/minions/v1/tree.proto) despite the PRD's screen sketch mentioning them —
 * the root node's mode is always a read-only `plan` node assigned by the domain engine, and
 * no attachment upload RPC exists yet, so neither is offered here. Every resource id the
 * request needs (`tree_id`, `plan_revision_id`, `root_node_id`, `root_artifact_id`,
 * `attention_id`) is minted client-side with `generateUuidV7()`, exactly like
 * apps/cli/src/index.ts's own `tree create` — the browser only ever sends ids and intents,
 * never a status or transition.
 *
 * Base commit defaults to the selected repository's own registered `baseCommit` (its
 * resolved default-branch HEAD at registration time) rather than forcing the operator to
 * type a raw SHA from scratch — it stays a plain editable text field so pinning a different
 * commit is one edit away, not a separate flow.
 */
export function NewTaskDialog({
  hosts,
  repositories,
  repositoryDetail,
  treeClient,
}: NewTaskDialogProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<FormState>(INITIAL_FORM_STATE);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<TypedError | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [createdTree, setCreatedTree] = useState<TaskTree | undefined>(undefined);

  function resetForm(): void {
    setFields(INITIAL_FORM_STATE);
    setErrors({});
    setSubmitError(undefined);
    setSubmitting(false);
    setCreatedTree(undefined);
  }

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) {
      resetForm();
    }
  }

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setFields((previous) => ({ ...previous, [key]: value }));
  }

  function handleHostChange(hostId: string): void {
    setFields((previous) => ({ ...previous, hostId, repositoryId: "", baseCommit: "" }));
  }

  function handleRepositoryChange(repositoryId: string): void {
    const detail = repositoryDetail.get(repositoryId);
    setFields((previous) => ({
      ...previous,
      repositoryId,
      baseCommit: detail?.baseCommit ?? "",
    }));
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextErrors = validateForm(fields);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setSubmitError(undefined);
    setSubmitting(true);
    try {
      const response = await treeClient.createTree(
        create(CreateTreeRequestSchema, {
          commandId: generateUuidV7(),
          actorSessionId: actorSessionId(),
          repositoryId: fields.repositoryId,
          treeId: generateUuidV7(),
          planRevisionId: generateUuidV7(),
          rootNodeId: generateUuidV7(),
          rootArtifactId: generateUuidV7(),
          goal: fields.goal.trim(),
          baseCommit: fields.baseCommit,
          budget: create(TreeBudgetSchema, {
            maxDepth: parseBudgetValue(fields.maxDepth),
            maxFanOut: parseBudgetValue(fields.maxFanOut),
            maxNodes: parseBudgetValue(fields.maxNodes),
            maxConcurrency: parseBudgetValue(fields.maxConcurrency),
            maxAttemptsPerNode: parseBudgetValue(fields.maxAttemptsPerNode),
          }),
          attentionId: generateUuidV7(),
          rootAllowedRepositoryPaths: [fields.rootAllowedPath],
          rootCheckProfile: fields.rootCheckProfile.trim(),
        }),
      );
      if (response.tree === undefined) {
        setSubmitError({
          code: "Internal",
          message: "The daemon accepted the request but returned no tree.",
        });
        return;
      }
      setCreatedTree(response.tree);
    } catch (caught) {
      setSubmitError(describeConnectError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const hostOptions: SelectOption[] = hosts.map((host) => ({
    value: host.id,
    label: host.displayName,
  }));
  const repositoryOptions: SelectOption[] = repositories
    .filter((repository) => repository.hostId === fields.hostId)
    .map((repository) => ({
      value: repository.id,
      label:
        repositoryDetail.get(repository.id)?.canonicalRoot ??
        `Repository ${shortId(repository.id)}`,
    }));

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      trigger={<Button>New task</Button>}
      title="New task"
      description="Create a task tree from one explicit host, repository, and base commit."
    >
      {createdTree !== undefined ? (
        <div className="mn-task-confirmation">
          <p role="status">Task created.</p>
          <Fact>{createdTree.goal}</Fact>
          <Fact title={createdTree.id}>tree {shortId(createdTree.id)}</Fact>
          <StatusBadge
            status={treeStateBadgeKind(createdTree.state)}
            label={treeStateLabel(createdTree.state)}
          />
          <div className="mn-dialog-actions">
            <a
              className="mn-button mn-button--secondary mn-focus-ring"
              href={`/tree/${createdTree.id}`}
            >
              Open tree
            </a>
            <Button
              onClick={() => {
                handleOpenChange(false);
              }}
            >
              Close
            </Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          noValidate
        >
          <Field label="Host" htmlFor={HOST_FIELD_ID} error={errors.host}>
            <Select
              id={HOST_FIELD_ID}
              placeholder="Select a host"
              options={hostOptions}
              value={fields.hostId}
              invalid={errors.host !== undefined}
              onChange={(event) => {
                handleHostChange(event.target.value);
              }}
            />
          </Field>
          <Field label="Repository" htmlFor={REPOSITORY_FIELD_ID} error={errors.repository}>
            <Select
              id={REPOSITORY_FIELD_ID}
              placeholder="Select a repository"
              options={repositoryOptions}
              value={fields.repositoryId}
              invalid={errors.repository !== undefined}
              disabled={fields.hostId.length === 0}
              onChange={(event) => {
                handleRepositoryChange(event.target.value);
              }}
            />
          </Field>
          <Field
            label="Goal"
            htmlFor={GOAL_FIELD_ID}
            hint="What should this task accomplish?"
            error={errors.goal}
          >
            <TextArea
              id={GOAL_FIELD_ID}
              value={fields.goal}
              invalid={errors.goal !== undefined}
              onChange={(event) => {
                updateField("goal", event.target.value);
              }}
            />
          </Field>
          <Field
            label="Base commit"
            htmlFor={BASE_COMMIT_FIELD_ID}
            hint="Defaults to the selected repository's registered base commit; edit to pin a different one."
            error={errors.baseCommit}
          >
            <TextInput
              id={BASE_COMMIT_FIELD_ID}
              value={fields.baseCommit}
              invalid={errors.baseCommit !== undefined}
              onChange={(event) => {
                updateField("baseCommit", event.target.value);
              }}
            />
          </Field>
          <Field
            label="Root allowed path"
            htmlFor={ROOT_ALLOWED_PATH_FIELD_ID}
            hint={'Relative path scope for the root task node (use "." for the whole repository).'}
            error={errors.rootAllowedPath}
          >
            <TextInput
              id={ROOT_ALLOWED_PATH_FIELD_ID}
              value={fields.rootAllowedPath}
              invalid={errors.rootAllowedPath !== undefined}
              onChange={(event) => {
                updateField("rootAllowedPath", event.target.value);
              }}
            />
          </Field>
          <Field
            label="Root check profile"
            htmlFor={ROOT_CHECK_PROFILE_FIELD_ID}
            hint="Gate profile name the root node's checks run under."
            error={errors.rootCheckProfile}
          >
            <TextInput
              id={ROOT_CHECK_PROFILE_FIELD_ID}
              list={ROOT_CHECK_PROFILE_HINTS_ID}
              placeholder="e.g. lint"
              value={fields.rootCheckProfile}
              invalid={errors.rootCheckProfile !== undefined}
              onChange={(event) => {
                updateField("rootCheckProfile", event.target.value);
              }}
            />
            <datalist id={ROOT_CHECK_PROFILE_HINTS_ID}>
              {ROOT_CHECK_PROFILE_HINTS.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </Field>
          <div className="mn-new-task-budget">
            <Field label="Max depth" htmlFor={MAX_DEPTH_FIELD_ID} error={errors.maxDepth}>
              <TextInput
                id={MAX_DEPTH_FIELD_ID}
                type="number"
                min={1}
                max={4294967295}
                value={fields.maxDepth}
                invalid={errors.maxDepth !== undefined}
                onChange={(event) => {
                  updateField("maxDepth", event.target.value);
                }}
              />
            </Field>
            <Field label="Max fan-out" htmlFor={MAX_FAN_OUT_FIELD_ID} error={errors.maxFanOut}>
              <TextInput
                id={MAX_FAN_OUT_FIELD_ID}
                type="number"
                min={1}
                max={4294967295}
                value={fields.maxFanOut}
                invalid={errors.maxFanOut !== undefined}
                onChange={(event) => {
                  updateField("maxFanOut", event.target.value);
                }}
              />
            </Field>
            <Field label="Max nodes" htmlFor={MAX_NODES_FIELD_ID} error={errors.maxNodes}>
              <TextInput
                id={MAX_NODES_FIELD_ID}
                type="number"
                min={1}
                max={4294967295}
                value={fields.maxNodes}
                invalid={errors.maxNodes !== undefined}
                onChange={(event) => {
                  updateField("maxNodes", event.target.value);
                }}
              />
            </Field>
            <Field
              label="Max concurrency"
              htmlFor={MAX_CONCURRENCY_FIELD_ID}
              error={errors.maxConcurrency}
            >
              <TextInput
                id={MAX_CONCURRENCY_FIELD_ID}
                type="number"
                min={1}
                max={4294967295}
                value={fields.maxConcurrency}
                invalid={errors.maxConcurrency !== undefined}
                onChange={(event) => {
                  updateField("maxConcurrency", event.target.value);
                }}
              />
            </Field>
            <Field
              label="Max attempts per node"
              htmlFor={MAX_ATTEMPTS_FIELD_ID}
              error={errors.maxAttemptsPerNode}
            >
              <TextInput
                id={MAX_ATTEMPTS_FIELD_ID}
                type="number"
                min={1}
                max={4294967295}
                value={fields.maxAttemptsPerNode}
                invalid={errors.maxAttemptsPerNode !== undefined}
                onChange={(event) => {
                  updateField("maxAttemptsPerNode", event.target.value);
                }}
              />
            </Field>
          </div>
          {submitError !== undefined ? (
            <p className="mn-form-error" role="alert">
              <strong>{submitError.code}:</strong> {submitError.message}
            </p>
          ) : null}
          <div className="mn-dialog-actions">
            <Button type="submit" id="new-task-submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create task"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
