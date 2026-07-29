import { useState, type ReactNode, type SubmitEvent } from "react";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { RegisterRepositoryRequestSchema, type RepositoryService } from "@minions/contracts";
import { Button, Dialog, Field, TextInput } from "@minions/ui-kit";
import { actorSessionId, generateUuidV7 } from "../../data/index.js";
import { describeConnectError, type TypedError } from "./connect-error.js";
import { validateRequiredText } from "./validation.js";

export interface RegisterRepositoryDialogProps {
  readonly client: Client<typeof RepositoryService>;
}

const ROOT_PATH_FIELD_ID = "register-repository-root-path";

/**
 * Repository registration form (PR 45 — host-repository-task-ui). The operator supplies only
 * `root_path`; every id (`command_id`, `actor_session_id`, `repository_id`) is minted in the
 * browser via `generateUuidV7()`/`actorSessionId()` (PR 45 acceptance: requests send IDs and
 * operator intents only). The daemon is authoritative for everything else — existence,
 * git-ness, safety policy (clean checkout, no submodules/LFS/nested repos, outside the
 * daemon's own home) — see apps/daemon/src/repository-service.ts. Failures arrive as a bare
 * `ConnectError` with no structured detail (plain code + message only); this surfaces exactly
 * that via `describeConnectError`, never inventing a client-side guess at the cause.
 */
export function RegisterRepositoryDialog({ client }: RegisterRepositoryDialogProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [rootPath, setRootPath] = useState("");
  const [pathError, setPathError] = useState<string | undefined>(undefined);
  const [submitError, setSubmitError] = useState<TypedError | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  function reset(): void {
    setRootPath("");
    setPathError(undefined);
    setSubmitError(undefined);
    setSubmitting(false);
  }

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) {
      reset();
    }
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = rootPath.trim();
    const validation = validateRequiredText(trimmed, "Repository path");
    if (validation !== undefined) {
      setPathError(validation);
      return;
    }
    setPathError(undefined);
    setSubmitError(undefined);
    setSubmitting(true);
    try {
      await client.registerRepository(
        create(RegisterRepositoryRequestSchema, {
          commandId: generateUuidV7(),
          actorSessionId: actorSessionId(),
          repositoryId: generateUuidV7(),
          rootPath: trimmed,
        }),
      );
      setOpen(false);
      reset();
    } catch (caught) {
      setSubmitError(describeConnectError(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      trigger={<Button variant="secondary">Register repository</Button>}
      title="Register repository"
      description="Register a Git repository the daemon can create tasks against. The path must be readable on this host — the daemon validates it is a clean, safe Git checkout."
    >
      <form
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
        noValidate
      >
        <Field
          label="Repository path"
          htmlFor={ROOT_PATH_FIELD_ID}
          hint="Absolute path on the daemon's host filesystem."
          error={pathError}
        >
          <TextInput
            id={ROOT_PATH_FIELD_ID}
            name="rootPath"
            placeholder="/home/user/code/example"
            value={rootPath}
            invalid={pathError !== undefined}
            aria-describedby={pathError !== undefined ? `${ROOT_PATH_FIELD_ID}-error` : undefined}
            onChange={(event) => {
              setRootPath(event.target.value);
            }}
          />
        </Field>
        {submitError !== undefined ? (
          <p className="mn-form-error" role="alert">
            <strong>{submitError.code}:</strong> {submitError.message}
          </p>
        ) : null}
        <div className="mn-dialog-actions">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Registering…" : "Register"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
