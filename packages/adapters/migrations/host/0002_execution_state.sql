CREATE TABLE content_blobs (
  digest TEXT PRIMARY KEY CHECK (
    length(digest) = 64
    AND digest NOT GLOB '*[^0-9a-f]*'
  ),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  media_type TEXT NOT NULL CHECK (length(media_type) > 0),
  relative_path TEXT NOT NULL UNIQUE CHECK (length(relative_path) > 0),
  retention_kind TEXT NOT NULL CHECK (
    retention_kind IN ('active', 'archived', 'purge_pending')
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  verified_at_ms INTEGER NOT NULL CHECK (verified_at_ms >= created_at_ms)
) STRICT;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  attempt_id TEXT CHECK (attempt_id IS NULL OR length(attempt_id) = 36),
  tree_id TEXT NOT NULL CHECK (length(tree_id) = 36),
  repository_id TEXT NOT NULL CHECK (length(repository_id) = 36),
  host_id TEXT NOT NULL CHECK (length(host_id) = 36),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  artifact_type TEXT NOT NULL CHECK (length(artifact_type) > 0),
  evidence_id TEXT NOT NULL CHECK (length(evidence_id) = 36),
  retention_kind TEXT NOT NULL CHECK (
    retention_kind IN ('active', 'archived', 'purge_pending')
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (id, node_id),
  UNIQUE (id, node_id, attempt_id),
  FOREIGN KEY (node_id, tree_id, repository_id, host_id)
    REFERENCES nodes (id, tree_id, repository_id, host_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, node_id)
    REFERENCES attempts (id, node_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (content_digest) REFERENCES content_blobs (digest)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX artifacts_node_created
  ON artifacts (node_id, created_at_ms, id);
CREATE INDEX artifacts_retention
  ON artifacts (retention_kind, created_at_ms, id);

CREATE TABLE harness_bindings (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) = 36),
  harness_kind TEXT NOT NULL CHECK (length(harness_kind) > 0),
  provider_kind TEXT NOT NULL CHECK (length(provider_kind) > 0),
  model TEXT NOT NULL CHECK (length(model) > 0),
  session_id TEXT NOT NULL UNIQUE CHECK (length(session_id) > 0),
  policy_digest TEXT NOT NULL CHECK (
    length(policy_digest) = 64
    AND policy_digest NOT GLOB '*[^0-9a-f]*'
  ),
  established_at_ms INTEGER NOT NULL CHECK (established_at_ms >= 0),
  finished_at_ms INTEGER CHECK (
    finished_at_ms IS NULL OR finished_at_ms >= established_at_ms
  ),
  FOREIGN KEY (attempt_id) REFERENCES attempts (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE workspace_bindings (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) = 36),
  repository_id TEXT NOT NULL CHECK (length(repository_id) = 36),
  workspace_path TEXT NOT NULL UNIQUE CHECK (length(workspace_path) > 0),
  branch_name TEXT NOT NULL CHECK (length(branch_name) > 0),
  base_commit TEXT NOT NULL CHECK (
    length(base_commit) IN (40, 64)
    AND base_commit NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  cleaned_at_ms INTEGER CHECK (
    cleaned_at_ms IS NULL OR cleaned_at_ms >= created_at_ms
  ),
  UNIQUE (repository_id, branch_name),
  FOREIGN KEY (attempt_id, repository_id)
    REFERENCES attempts (id, repository_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (repository_id) REFERENCES repositories (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE gate_runs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) = 36),
  gate_kind TEXT NOT NULL CHECK (length(gate_kind) > 0),
  gate_name TEXT NOT NULL CHECK (length(gate_name) > 0),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN ('queued', 'running', 'passed', 'failed', 'cancelled')
  ),
  evidence_artifact_id TEXT CHECK (
    evidence_artifact_id IS NULL OR length(evidence_artifact_id) = 36
  ),
  started_at_ms INTEGER CHECK (started_at_ms IS NULL OR started_at_ms >= 0),
  finished_at_ms INTEGER CHECK (
    (state_kind = 'queued' AND started_at_ms IS NULL AND finished_at_ms IS NULL)
    OR (state_kind = 'running' AND started_at_ms IS NOT NULL AND finished_at_ms IS NULL)
    OR (
      state_kind IN ('passed', 'failed', 'cancelled')
      AND started_at_ms IS NOT NULL
      AND finished_at_ms IS NOT NULL
      AND finished_at_ms >= started_at_ms
    )
  ),
  CHECK (
    (state_kind IN ('queued', 'running') AND evidence_artifact_id IS NULL)
    OR (state_kind IN ('passed', 'failed', 'cancelled') AND evidence_artifact_id IS NOT NULL)
  ),
  UNIQUE (attempt_id, gate_kind, gate_name),
  FOREIGN KEY (attempt_id, node_id)
    REFERENCES attempts (id, node_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (evidence_artifact_id, node_id, attempt_id)
    REFERENCES artifacts (id, node_id, attempt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX gate_runs_state
  ON gate_runs (state_kind, started_at_ms, id);

CREATE TABLE pull_request_observations (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  repository_id TEXT NOT NULL CHECK (length(repository_id) = 36),
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  provider_pr_id TEXT NOT NULL CHECK (length(provider_pr_id) > 0),
  number INTEGER NOT NULL CHECK (number > 0),
  base_ref TEXT NOT NULL CHECK (length(base_ref) > 0),
  head_ref TEXT NOT NULL CHECK (length(head_ref) > 0),
  head_commit TEXT NOT NULL CHECK (
    length(head_commit) IN (40, 64)
    AND head_commit NOT GLOB '*[^0-9a-f]*'
  ),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN ('open', 'closed', 'merged')
  ),
  review_kind TEXT NOT NULL CHECK (
    review_kind IN ('pending', 'approved', 'changes_requested')
  ),
  checks_kind TEXT NOT NULL CHECK (
    checks_kind IN ('pending', 'passed', 'failed')
  ),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  UNIQUE (repository_id, provider_pr_id),
  UNIQUE (repository_id, number),
  FOREIGN KEY (node_id, repository_id)
    REFERENCES nodes (id, repository_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX pull_request_observations_node
  ON pull_request_observations (node_id, observed_at_ms, id);

CREATE TABLE restack_runs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  parent_node_id TEXT NOT NULL CHECK (length(parent_node_id) = 36),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN ('queued', 'running', 'succeeded', 'conflicted', 'failed')
  ),
  old_base_commit TEXT NOT NULL CHECK (
    length(old_base_commit) IN (40, 64)
    AND old_base_commit NOT GLOB '*[^0-9a-f]*'
  ),
  new_base_commit TEXT NOT NULL CHECK (
    length(new_base_commit) IN (40, 64)
    AND new_base_commit NOT GLOB '*[^0-9a-f]*'
  ),
  result_commit TEXT CHECK (
    result_commit IS NULL OR (
      length(result_commit) IN (40, 64)
      AND result_commit NOT GLOB '*[^0-9a-f]*'
    )
  ),
  evidence_id TEXT CHECK (evidence_id IS NULL OR length(evidence_id) = 36),
  started_at_ms INTEGER CHECK (started_at_ms IS NULL OR started_at_ms >= 0),
  finished_at_ms INTEGER CHECK (
    (state_kind = 'queued' AND started_at_ms IS NULL AND finished_at_ms IS NULL)
    OR (state_kind = 'running' AND started_at_ms IS NOT NULL AND finished_at_ms IS NULL)
    OR (
      state_kind IN ('succeeded', 'conflicted', 'failed')
      AND started_at_ms IS NOT NULL
      AND finished_at_ms IS NOT NULL
      AND finished_at_ms >= started_at_ms
    )
  ),
  CHECK (
    (state_kind IN ('queued', 'running') AND evidence_id IS NULL)
    OR (state_kind IN ('succeeded', 'conflicted', 'failed') AND evidence_id IS NOT NULL)
  ),
  CHECK (
    (state_kind = 'succeeded' AND result_commit IS NOT NULL)
    OR (state_kind <> 'succeeded' AND result_commit IS NULL)
  ),
  FOREIGN KEY (node_id, parent_node_id)
    REFERENCES nodes (id, parent_node_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX restack_runs_node
  ON restack_runs (node_id, started_at_ms, id);

CREATE TABLE operator_commands (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  actor_session_id TEXT NOT NULL CHECK (length(actor_session_id) = 36),
  aggregate_kind TEXT NOT NULL CHECK (length(aggregate_kind) > 0),
  aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) = 36),
  expected_version INTEGER CHECK (expected_version IS NULL OR expected_version >= 0),
  command_type TEXT NOT NULL CHECK (length(command_type) > 0),
  command_payload BLOB NOT NULL CHECK (length(command_payload) > 0),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN ('queued', 'claimed', 'applied', 'rejected', 'cancelled')
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  acknowledged_at_ms INTEGER CHECK (
    acknowledged_at_ms IS NULL OR acknowledged_at_ms >= created_at_ms
  ),
  CHECK (
    (state_kind IN ('queued', 'claimed') AND acknowledged_at_ms IS NULL)
    OR (state_kind IN ('applied', 'rejected', 'cancelled') AND acknowledged_at_ms IS NOT NULL)
  ),
  UNIQUE (id, actor_session_id)
) STRICT;

CREATE INDEX operator_commands_state
  ON operator_commands (state_kind, created_at_ms, id);

CREATE TABLE external_operations (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  command_id TEXT NOT NULL CHECK (length(command_id) = 36),
  operation_kind TEXT NOT NULL CHECK (length(operation_kind) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
  request_type TEXT NOT NULL CHECK (length(request_type) > 0),
  request_payload BLOB NOT NULL CHECK (length(request_payload) > 0),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN ('pending', 'in_flight', 'applied', 'failed', 'ambiguous')
  ),
  receipt_type TEXT CHECK (receipt_type IS NULL OR length(receipt_type) > 0),
  receipt_payload BLOB,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (
    (state_kind IN ('pending', 'in_flight') AND receipt_type IS NULL AND receipt_payload IS NULL)
    OR (
      state_kind IN ('applied', 'failed', 'ambiguous')
      AND receipt_type IS NOT NULL
      AND receipt_payload IS NOT NULL
    )
  ),
  UNIQUE (operation_kind, idempotency_key),
  UNIQUE (id, command_id),
  FOREIGN KEY (command_id) REFERENCES operator_commands (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX external_operations_state
  ON external_operations (state_kind, updated_at_ms, id);

CREATE TABLE idempotency_records (
  command_id TEXT PRIMARY KEY CHECK (length(command_id) = 36),
  actor_session_id TEXT NOT NULL CHECK (length(actor_session_id) = 36),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64
    AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  result_type TEXT NOT NULL CHECK (length(result_type) > 0),
  result_payload BLOB NOT NULL CHECK (length(result_payload) > 0),
  committed_sequence INTEGER NOT NULL CHECK (committed_sequence > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  FOREIGN KEY (command_id, actor_session_id)
    REFERENCES operator_commands (id, actor_session_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (committed_sequence, command_id)
    REFERENCES events (sequence, command_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) = 36),
  command_id TEXT NOT NULL CHECK (length(command_id) = 36),
  aggregate_kind TEXT NOT NULL CHECK (length(aggregate_kind) > 0),
  aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) = 36),
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version > 0),
  event_type TEXT NOT NULL CHECK (length(event_type) > 0),
  event_payload BLOB NOT NULL CHECK (length(event_payload) > 0),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  FOREIGN KEY (command_id) REFERENCES operator_commands (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (aggregate_kind, aggregate_id, aggregate_version),
  UNIQUE (sequence, command_id)
) STRICT;

CREATE INDEX events_aggregate_sequence
  ON events (aggregate_kind, aggregate_id, sequence);
CREATE INDEX events_command
  ON events (command_id, sequence);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  command_id TEXT NOT NULL CHECK (length(command_id) = 36),
  event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
  operation_id TEXT NOT NULL CHECK (length(operation_id) = 36),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN ('pending', 'claimed', 'dispatched', 'cancelled')
  ),
  available_at_ms INTEGER NOT NULL CHECK (available_at_ms >= 0),
  claimed_at_ms INTEGER CHECK (claimed_at_ms IS NULL OR claimed_at_ms >= available_at_ms),
  dispatched_at_ms INTEGER CHECK (
    dispatched_at_ms IS NULL
    OR (claimed_at_ms IS NOT NULL AND dispatched_at_ms >= claimed_at_ms)
  ),
  CHECK (
    (state_kind = 'pending' AND claimed_at_ms IS NULL AND dispatched_at_ms IS NULL)
    OR (state_kind = 'claimed' AND claimed_at_ms IS NOT NULL AND dispatched_at_ms IS NULL)
    OR (state_kind = 'dispatched' AND claimed_at_ms IS NOT NULL AND dispatched_at_ms IS NOT NULL)
    OR (state_kind = 'cancelled' AND dispatched_at_ms IS NULL)
  ),
  FOREIGN KEY (command_id) REFERENCES operator_commands (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (event_sequence, command_id)
    REFERENCES events (sequence, command_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (operation_id, command_id)
    REFERENCES external_operations (id, command_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  UNIQUE (operation_id)
) STRICT;

CREATE INDEX outbox_dispatch_order
  ON outbox (state_kind, available_at_ms, id);

CREATE TRIGGER content_blob_definition_is_immutable
BEFORE UPDATE OF digest, size_bytes, media_type, relative_path, created_at_ms ON content_blobs
BEGIN
  SELECT RAISE(ABORT, 'content blob definition is immutable');
END;

CREATE TRIGGER artifact_definition_is_immutable
BEFORE UPDATE OF id, node_id, attempt_id, tree_id, repository_id, host_id,
  content_digest, artifact_type, evidence_id, created_at_ms
ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifact definition is immutable');
END;

CREATE TRIGGER harness_binding_is_immutable
BEFORE UPDATE OF attempt_id, harness_kind, provider_kind, model, session_id,
  policy_digest, established_at_ms
ON harness_bindings
BEGIN
  SELECT RAISE(ABORT, 'harness binding is immutable');
END;

CREATE TRIGGER workspace_binding_is_immutable
BEFORE UPDATE OF attempt_id, repository_id, workspace_path, branch_name,
  base_commit, created_at_ms
ON workspace_bindings
BEGIN
  SELECT RAISE(ABORT, 'workspace binding is immutable');
END;

CREATE TRIGGER gate_run_definition_is_immutable
BEFORE UPDATE OF id, node_id, attempt_id, gate_kind, gate_name ON gate_runs
BEGIN
  SELECT RAISE(ABORT, 'gate run definition is immutable');
END;

CREATE TRIGGER pull_request_binding_is_immutable
BEFORE UPDATE OF id, repository_id, node_id, provider_pr_id, number, base_ref, head_ref
ON pull_request_observations
BEGIN
  SELECT RAISE(ABORT, 'pull request binding is immutable');
END;

CREATE TRIGGER restack_run_definition_is_immutable
BEFORE UPDATE OF id, node_id, parent_node_id, old_base_commit, new_base_commit
ON restack_runs
BEGIN
  SELECT RAISE(ABORT, 'restack run definition is immutable');
END;

CREATE TRIGGER operator_command_definition_is_immutable
BEFORE UPDATE OF id, actor_session_id, aggregate_kind, aggregate_id,
  expected_version, command_type, command_payload, created_at_ms
ON operator_commands
BEGIN
  SELECT RAISE(ABORT, 'operator command definition is immutable');
END;

CREATE TRIGGER external_operation_definition_is_immutable
BEFORE UPDATE OF id, command_id, operation_kind, idempotency_key,
  request_type, request_payload, created_at_ms
ON external_operations
BEGIN
  SELECT RAISE(ABORT, 'external operation definition is immutable');
END;

CREATE TRIGGER idempotency_record_is_immutable
BEFORE UPDATE ON idempotency_records
BEGIN
  SELECT RAISE(ABORT, 'idempotency record is immutable');
END;

CREATE TRIGGER event_is_immutable
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'event is immutable');
END;

CREATE TRIGGER outbox_definition_is_immutable
BEFORE UPDATE OF id, command_id, event_sequence, operation_id ON outbox
BEGIN
  SELECT RAISE(ABORT, 'outbox definition is immutable');
END;
