import { useState, type ReactNode, type SubmitEvent } from "react";
import { Link } from "react-router-dom";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import {
  CreateTemplatedTreeRequestSchema,
  CreateTreeRequestSchema,
  TaskTemplate,
  TreeBudgetSchema,
  TreeState,
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
  isAdvanced: boolean;
  template: TaskTemplate;
  prompt: string;
  hostId: string;
  repositoryId: string;
  goal: string;
  baseCommit: string;
  rootAllowedPath: string;
  maxDepth: string;
  maxFanOut: string;
  maxNodes: string;
  maxConcurrency: string;
  maxAttemptsPerNode: string;
}

interface FieldErrors {
  template?: string;
  prompt?: string;
  host?: string;
  repository?: string;
  goal?: string;
  baseCommit?: string;
  rootAllowedPath?: string;
  maxDepth?: string;
  maxFanOut?: string;
  maxNodes?: string;
  maxConcurrency?: string;
  maxAttemptsPerNode?: string;
}

const INITIAL_FORM_STATE: FormState = {
  isAdvanced: false,
  template: TaskTemplate.EXPLAIN,
  prompt: "",
  hostId: "",
  repositoryId: "",
  goal: "",
  baseCommit: "",
  rootAllowedPath: ".",
  maxDepth: "4",
  maxFanOut: "4",
  maxNodes: "24",
  maxConcurrency: "2",
  maxAttemptsPerNode: "3",
};

const TEMPLATE_FIELD_ID = "new-task-template";
const PROMPT_FIELD_ID = "new-task-prompt";
const REPOSITORY_FIELD_ID = "new-task-repository";
const HOST_FIELD_ID = "new-task-host";
const GOAL_FIELD_ID = "new-task-goal";
const BASE_COMMIT_FIELD_ID = "new-task-base-commit";
const ROOT_ALLOWED_PATH_FIELD_ID = "new-task-root-allowed-path";
const MAX_DEPTH_FIELD_ID = "new-task-max-depth";
const MAX_FAN_OUT_FIELD_ID = "new-task-max-fan-out";
const MAX_NODES_FIELD_ID = "new-task-max-nodes";
const MAX_CONCURRENCY_FIELD_ID = "new-task-max-concurrency";
const MAX_ATTEMPTS_FIELD_ID = "new-task-max-attempts-per-node";

const TEMPLATE_OPTIONS: readonly SelectOption[] = [
  { value: String(TaskTemplate.EXPLAIN), label: "Explain — Read-only diagnosis (auto-approved)" },
  { value: String(TaskTemplate.FIX), label: "Fix — Diagnose then apply fix (sequential chain)" },
  { value: String(TaskTemplate.FEATURE), label: "Feature — Explore then build (sequential chain)" },
];

const TEMPLATE_DESCRIPTIONS: Readonly<Record<TaskTemplate, string>> = {
  [TaskTemplate.UNSPECIFIED]: "Select a task template.",
  [TaskTemplate.EXPLAIN]:
    "Creates a single research node exploring the repo and answering your prompt. Auto-approves for immediate execution.",
  [TaskTemplate.FIX]:
    "Creates a sequential two-node chain: diagnoses the issue, and upon success, creates an implementation node to apply the fix.",
  [TaskTemplate.FEATURE]:
    "Creates a sequential two-node chain: maps the affected area, and upon success, creates an implementation node to build the feature.",
};

function validateTemplateForm(fields: FormState): FieldErrors {
  const errors: FieldErrors = {};
  if (fields.template === TaskTemplate.UNSPECIFIED) {
    errors.template = "Select a task template.";
  }
  const promptError = validateRequiredText(fields.prompt, "Prompt");
  if (promptError !== undefined) {
    errors.prompt = promptError;
  }
  if (fields.repositoryId.length === 0) {
    errors.repository = "Select a repository.";
  }
  return errors;
}

function validateAdvancedForm(fields: FormState): FieldErrors {
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

  function handlePromptChange(prompt: string): void {
    setFields((previous) => ({
      ...previous,
      prompt,
      goal: previous.goal === "" || previous.goal === previous.prompt ? prompt : previous.goal,
    }));
  }

  function handleHostChange(hostId: string): void {
    setFields((previous) => ({
      ...previous,
      hostId,
      repositoryId: "",
      baseCommit: "",
    }));
  }

  function handleRepositoryChange(repositoryId: string): void {
    const detail = repositoryDetail.get(repositoryId);
    const repoSummary = repositories.find((r) => r.id === repositoryId);
    setFields((previous) => ({
      ...previous,
      repositoryId,
      hostId: repoSummary?.hostId ?? previous.hostId,
      baseCommit: detail?.baseCommit ?? "",
    }));
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextErrors = fields.isAdvanced
      ? validateAdvancedForm(fields)
      : validateTemplateForm(fields);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors({});
    setSubmitError(undefined);
    setSubmitting(true);
    try {
      const response = fields.isAdvanced
        ? await treeClient.createTree(
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
            }),
          )
        : await treeClient.createTemplatedTree(
            create(CreateTemplatedTreeRequestSchema, {
              commandId: generateUuidV7(),
              actorSessionId: actorSessionId(),
              repositoryId: fields.repositoryId,
              treeId: generateUuidV7(),
              planRevisionId: generateUuidV7(),
              rootNodeId: generateUuidV7(),
              rootArtifactId: generateUuidV7(),
              attentionId: generateUuidV7(),
              template: fields.template,
              prompt: fields.prompt.trim(),
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
    .filter((repository) =>
      fields.isAdvanced && fields.hostId.length > 0 ? repository.hostId === fields.hostId : true,
    )
    .map((repository) => {
      const detail = repositoryDetail.get(repository.id);
      const host = hosts.find((h) => h.id === repository.hostId);
      const hostSuffix =
        !fields.isAdvanced && hosts.length > 1 && host !== undefined
          ? ` (${host.displayName})`
          : "";
      return {
        value: repository.id,
        label: (detail?.canonicalRoot ?? `Repository ${shortId(repository.id)}`) + hostSuffix,
      };
    });

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      trigger={<Button>New task</Button>}
      title="New task"
      description="Create a task tree from a template or explicit budget configuration."
    >
      {createdTree !== undefined ? (
        <div className="mn-task-confirmation">
          <p role="status">Task created.</p>
          <p className="mn-task-confirmation__message">
            {createdTree.state === TreeState.APPROVED || createdTree.state === TreeState.ACTIVE
              ? "The task plan was auto-approved and is ready to run."
              : "Review and approve the proposed plan to begin execution."}
          </p>
          <Fact>{createdTree.goal}</Fact>
          <Fact title={createdTree.id}>tree {shortId(createdTree.id)}</Fact>
          <StatusBadge
            status={treeStateBadgeKind(createdTree.state)}
            label={treeStateLabel(createdTree.state)}
          />
          <div className="mn-dialog-actions">
            <Link
              className="mn-button mn-button--secondary mn-focus-ring"
              to={`/tree/${createdTree.id}`}
            >
              Open tree
            </Link>
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
          <Field
            label="Template"
            htmlFor={TEMPLATE_FIELD_ID}
            hint={TEMPLATE_DESCRIPTIONS[fields.template]}
            error={errors.template}
          >
            <Select
              id={TEMPLATE_FIELD_ID}
              options={TEMPLATE_OPTIONS}
              value={String(fields.template)}
              invalid={errors.template !== undefined}
              onChange={(event) => {
                const value = Number(event.target.value);
                updateField("template", value);
              }}
            />
          </Field>
          <Field
            label="Prompt"
            htmlFor={PROMPT_FIELD_ID}
            hint="What should this task accomplish?"
            error={errors.prompt}
          >
            <TextArea
              id={PROMPT_FIELD_ID}
              value={fields.prompt}
              invalid={errors.prompt !== undefined}
              onChange={(event) => {
                handlePromptChange(event.target.value);
              }}
            />
          </Field>
          <Field
            label="Repository"
            htmlFor={REPOSITORY_FIELD_ID}
            hint="Repository to execute the task in."
            error={errors.repository}
          >
            <Select
              id={REPOSITORY_FIELD_ID}
              placeholder="Select a repository"
              options={repositoryOptions}
              value={fields.repositoryId}
              invalid={errors.repository !== undefined}
              onChange={(event) => {
                handleRepositoryChange(event.target.value);
              }}
            />
          </Field>
          <details
            className="mn-new-task-advanced"
            onToggle={(event) => {
              updateField("isAdvanced", event.currentTarget.open);
            }}
          >
            <summary className="mn-new-task-advanced__summary mn-focus-ring">
              Advanced options (custom tree & budgets)
            </summary>
            <div className="mn-new-task-advanced__content">
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
              <Field
                label="Goal"
                htmlFor={GOAL_FIELD_ID}
                hint="Explicit goal for the custom tree root."
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
                hint={
                  'Relative path scope for the root task node (use "." for the whole repository).'
                }
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
            </div>
          </details>
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
