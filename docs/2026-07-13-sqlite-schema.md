# SQLite schema

This file is generated from the canonical forward-only SQL migrations. Run `pnpm generate` after changing a migration.

## Host database

### 0001 domain_state

SHA-256: `7d4a1671683561e0d731ec532d73d4ed95c60a5850f4a5943cb1e739c540cead`

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE CHECK (length(name) > 0),
  checksum TEXT NOT NULL CHECK (
    length(checksum) = 64
    AND checksum NOT GLOB '*[^0-9a-f]*'
  ),
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
) STRICT;

CREATE TABLE repositories (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  host_id TEXT NOT NULL CHECK (length(host_id) = 36),
  root_path TEXT NOT NULL CHECK (length(root_path) > 0),
  version INTEGER NOT NULL CHECK (version >= 0),
  registered_at_ms INTEGER NOT NULL CHECK (registered_at_ms >= 0),
  archived_at_ms INTEGER CHECK (
    archived_at_ms IS NULL OR archived_at_ms >= registered_at_ms
  ),
  UNIQUE (id, host_id),
  UNIQUE (host_id, root_path)
) STRICT;

CREATE TABLE trees (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  repository_id TEXT NOT NULL CHECK (length(repository_id) = 36),
  host_id TEXT NOT NULL CHECK (length(host_id) = 36),
  base_commit TEXT NOT NULL CHECK (
    length(base_commit) IN (40, 64)
    AND base_commit NOT GLOB '*[^0-9a-f]*'
  ),
  goal TEXT NOT NULL CHECK (length(goal) > 0),
  active_plan_revision_id TEXT NOT NULL CHECK (length(active_plan_revision_id) = 36),
  root_node_id TEXT NOT NULL CHECK (length(root_node_id) = 36),
  version INTEGER NOT NULL CHECK (version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  archived_at_ms INTEGER CHECK (
    archived_at_ms IS NULL OR archived_at_ms >= created_at_ms
  ),
  UNIQUE (id, repository_id, host_id),
  FOREIGN KEY (repository_id, host_id)
    REFERENCES repositories (id, host_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (id, active_plan_revision_id)
    REFERENCES plan_revisions (tree_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (id, root_node_id)
    REFERENCES nodes (root_tree_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE plan_revisions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tree_id TEXT NOT NULL CHECK (length(tree_id) = 36),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  goal TEXT NOT NULL CHECK (length(goal) > 0),
  state_kind TEXT NOT NULL CHECK (state_kind IN ('draft', 'approved', 'superseded')),
  version INTEGER NOT NULL CHECK (version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  approved_at_ms INTEGER CHECK (
    (state_kind = 'draft' AND approved_at_ms IS NULL)
    OR (
      state_kind IN ('approved', 'superseded')
      AND approved_at_ms IS NOT NULL
      AND approved_at_ms >= created_at_ms
    )
  ),
  superseded_at_ms INTEGER CHECK (
    (state_kind IN ('draft', 'approved') AND superseded_at_ms IS NULL)
    OR (
      state_kind = 'superseded'
      AND superseded_at_ms IS NOT NULL
      AND superseded_at_ms >= approved_at_ms
    )
  ),
  UNIQUE (tree_id, id),
  UNIQUE (tree_id, ordinal),
  FOREIGN KEY (tree_id) REFERENCES trees (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE nodes (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tree_id TEXT NOT NULL CHECK (length(tree_id) = 36),
  repository_id TEXT NOT NULL CHECK (length(repository_id) = 36),
  host_id TEXT NOT NULL CHECK (length(host_id) = 36),
  parent_node_id TEXT CHECK (parent_node_id IS NULL OR length(parent_node_id) = 36),
  root_tree_id TEXT GENERATED ALWAYS AS (
    CASE WHEN parent_node_id IS NULL THEN tree_id ELSE NULL END
  ) STORED,
  plan_revision_id TEXT NOT NULL CHECK (length(plan_revision_id) = 36),
  mode TEXT NOT NULL CHECK (mode IN ('explore', 'implementation', 'plan', 'research')),
  objective TEXT NOT NULL CHECK (length(objective) > 0),
  output_kind TEXT NOT NULL CHECK (output_kind IN ('artifact', 'implementation')),
  output_artifact_id TEXT CHECK (
    output_artifact_id IS NULL OR length(output_artifact_id) = 36
  ),
  output_artifact_type TEXT CHECK (
    output_artifact_type IS NULL OR length(output_artifact_type) > 0
  ),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN (
      'planned', 'ready', 'active', 'blocked', 'succeeded', 'failed', 'cancelled', 'superseded'
    )
  ),
  resume_state_kind TEXT CHECK (
    resume_state_kind IS NULL OR resume_state_kind IN ('ready', 'active')
  ),
  blocker_kind TEXT CHECK (
    blocker_kind IS NULL OR blocker_kind IN (
      'authentication', 'ci_failure', 'conflict', 'gate_failure', 'human_input', 'parent', 'quota', 'unavailable_host'
    )
  ),
  blocker_evidence_id TEXT CHECK (
    blocker_evidence_id IS NULL OR length(blocker_evidence_id) = 36
  ),
  blocker_parent_node_id TEXT CHECK (
    blocker_parent_node_id IS NULL OR length(blocker_parent_node_id) = 36
  ),
  blocker_host_id TEXT CHECK (
    blocker_host_id IS NULL OR length(blocker_host_id) = 36
  ),
  outcome_kind TEXT CHECK (
    outcome_kind IS NULL OR outcome_kind IN ('artifact', 'commit', 'no_change')
  ),
  outcome_artifact_id TEXT CHECK (
    outcome_artifact_id IS NULL OR length(outcome_artifact_id) = 36
  ),
  outcome_content_hash TEXT CHECK (
    outcome_content_hash IS NULL OR (
      length(outcome_content_hash) = 64
      AND outcome_content_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  outcome_artifact_type TEXT CHECK (
    outcome_artifact_type IS NULL OR length(outcome_artifact_type) > 0
  ),
  outcome_commit TEXT CHECK (
    outcome_commit IS NULL OR (
      length(outcome_commit) IN (40, 64)
      AND outcome_commit NOT GLOB '*[^0-9a-f]*'
    )
  ),
  outcome_evidence_id TEXT CHECK (
    outcome_evidence_id IS NULL OR length(outcome_evidence_id) = 36
  ),
  outcome_explanation TEXT CHECK (
    outcome_explanation IS NULL OR length(outcome_explanation) > 0
  ),
  terminal_evidence_id TEXT CHECK (
    terminal_evidence_id IS NULL OR length(terminal_evidence_id) = 36
  ),
  superseded_plan_revision_id TEXT CHECK (
    superseded_plan_revision_id IS NULL OR length(superseded_plan_revision_id) = 36
  ),
  version INTEGER NOT NULL CHECK (version >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (parent_node_id IS NULL OR parent_node_id <> id),
  CHECK (
    (output_kind = 'artifact' AND mode <> 'implementation'
      AND output_artifact_id IS NOT NULL AND output_artifact_type IS NOT NULL)
    OR
    (output_kind = 'implementation' AND mode = 'implementation'
      AND output_artifact_id IS NULL AND output_artifact_type IS NULL)
  ),
  CHECK (
    (state_kind = 'blocked'
      AND resume_state_kind IS NOT NULL
      AND blocker_kind IS NOT NULL
      AND blocker_evidence_id IS NOT NULL)
    OR
    (state_kind <> 'blocked'
      AND resume_state_kind IS NULL
      AND blocker_kind IS NULL
      AND blocker_evidence_id IS NULL
      AND blocker_parent_node_id IS NULL
      AND blocker_host_id IS NULL)
  ),
  CHECK (
    (blocker_kind = 'parent' AND blocker_parent_node_id IS NOT NULL)
    OR (blocker_kind IS NOT 'parent' AND blocker_parent_node_id IS NULL)
  ),
  CHECK (
    (blocker_kind = 'unavailable_host' AND blocker_host_id IS NOT NULL)
    OR (blocker_kind IS NOT 'unavailable_host' AND blocker_host_id IS NULL)
  ),
  CHECK (
    (state_kind = 'succeeded' AND outcome_kind IS NOT NULL)
    OR (state_kind <> 'succeeded' AND outcome_kind IS NULL)
  ),
  CHECK (
    outcome_kind = 'artifact'
    OR (
      outcome_artifact_id IS NULL
      AND outcome_content_hash IS NULL
      AND outcome_artifact_type IS NULL
    )
  ),
  CHECK (
    outcome_kind = 'commit' OR outcome_commit IS NULL
  ),
  CHECK (
    outcome_kind = 'no_change' OR outcome_explanation IS NULL
  ),
  CHECK (
    outcome_kind IS NULL OR outcome_evidence_id IS NOT NULL
  ),
  CHECK (
    outcome_kind <> 'artifact' OR (
      output_kind = 'artifact'
      AND outcome_artifact_id = output_artifact_id
      AND outcome_artifact_type = output_artifact_type
      AND outcome_content_hash IS NOT NULL
    )
  ),
  CHECK (
    outcome_kind <> 'commit' OR (
      output_kind = 'implementation'
      AND outcome_commit IS NOT NULL
    )
  ),
  CHECK (
    outcome_kind <> 'no_change' OR (
      output_kind = 'implementation'
      AND outcome_explanation IS NOT NULL
    )
  ),
  CHECK (
    (state_kind IN ('failed', 'cancelled') AND terminal_evidence_id IS NOT NULL)
    OR (state_kind NOT IN ('failed', 'cancelled') AND terminal_evidence_id IS NULL)
  ),
  CHECK (
    (state_kind = 'superseded' AND superseded_plan_revision_id IS NOT NULL)
    OR (state_kind <> 'superseded' AND superseded_plan_revision_id IS NULL)
  ),
  UNIQUE (tree_id, id),
  UNIQUE (root_tree_id, id),
  UNIQUE (output_artifact_id),
  UNIQUE (output_artifact_id, id),
  UNIQUE (id, repository_id),
  UNIQUE (id, parent_node_id),
  UNIQUE (id, tree_id, repository_id, host_id),
  UNIQUE (id, tree_id, repository_id, host_id, plan_revision_id),
  FOREIGN KEY (tree_id, repository_id, host_id)
    REFERENCES trees (id, repository_id, host_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tree_id, parent_node_id)
    REFERENCES nodes (tree_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tree_id, plan_revision_id)
    REFERENCES plan_revisions (tree_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tree_id, blocker_parent_node_id)
    REFERENCES nodes (tree_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tree_id, superseded_plan_revision_id)
    REFERENCES plan_revisions (tree_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX nodes_one_root_per_tree
  ON nodes (root_tree_id)
  WHERE root_tree_id IS NOT NULL;
CREATE INDEX nodes_parent_order
  ON nodes (tree_id, parent_node_id, created_at_ms, id);
CREATE INDEX nodes_state
  ON nodes (state_kind, updated_at_ms, id);

CREATE TABLE node_acceptance_criteria (
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  criterion TEXT NOT NULL CHECK (length(criterion) > 0),
  PRIMARY KEY (node_id, ordinal),
  FOREIGN KEY (node_id) REFERENCES nodes (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE node_artifact_inputs (
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  artifact_id TEXT NOT NULL CHECK (length(artifact_id) = 36),
  source_node_id TEXT NOT NULL CHECK (length(source_node_id) = 36),
  PRIMARY KEY (node_id, ordinal),
  UNIQUE (node_id, artifact_id),
  FOREIGN KEY (node_id) REFERENCES nodes (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id, source_node_id)
    REFERENCES nodes (output_artifact_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE attempts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  tree_id TEXT NOT NULL CHECK (length(tree_id) = 36),
  repository_id TEXT NOT NULL CHECK (length(repository_id) = 36),
  host_id TEXT NOT NULL CHECK (length(host_id) = 36),
  plan_revision_id TEXT NOT NULL CHECK (length(plan_revision_id) = 36),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN ('active', 'succeeded', 'failed', 'cancelled')
  ),
  version INTEGER NOT NULL CHECK (version >= 0),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  finished_at_ms INTEGER CHECK (
    (state_kind = 'active' AND finished_at_ms IS NULL)
    OR (
      state_kind <> 'active'
      AND finished_at_ms IS NOT NULL
      AND finished_at_ms >= started_at_ms
    )
  ),
  evidence_id TEXT CHECK (
    evidence_id IS NULL OR length(evidence_id) = 36
  ),
  CHECK (
    (state_kind = 'active' AND evidence_id IS NULL)
    OR (state_kind <> 'active' AND evidence_id IS NOT NULL)
  ),
  UNIQUE (node_id, ordinal),
  UNIQUE (id, node_id),
  UNIQUE (id, repository_id),
  UNIQUE (id, node_id, tree_id, repository_id, host_id),
  FOREIGN KEY (node_id, tree_id, repository_id, host_id, plan_revision_id)
    REFERENCES nodes (id, tree_id, repository_id, host_id, plan_revision_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER repositories_bindings_are_immutable
BEFORE UPDATE OF id, host_id, root_path, registered_at_ms ON repositories
BEGIN
  SELECT RAISE(ABORT, 'repository bindings are immutable');
END;

CREATE TRIGGER trees_bindings_are_immutable
BEFORE UPDATE OF id, repository_id, host_id, base_commit, root_node_id, created_at_ms ON trees
BEGIN
  SELECT RAISE(ABORT, 'tree bindings are immutable');
END;

CREATE TRIGGER plan_revision_definition_is_immutable
BEFORE UPDATE OF id, tree_id, ordinal, goal, created_at_ms ON plan_revisions
BEGIN
  SELECT RAISE(ABORT, 'plan revision definition is immutable');
END;

CREATE TRIGGER node_definition_is_immutable
BEFORE UPDATE OF id, tree_id, repository_id, host_id, parent_node_id, plan_revision_id,
  mode, objective, output_kind, output_artifact_id, output_artifact_type, created_at_ms
ON nodes
BEGIN
  SELECT RAISE(ABORT, 'node definition is immutable');
END;

CREATE TRIGGER node_acceptance_criterion_is_immutable
BEFORE UPDATE ON node_acceptance_criteria
BEGIN
  SELECT RAISE(ABORT, 'node acceptance criterion is immutable');
END;

CREATE TRIGGER node_artifact_input_is_immutable
BEFORE UPDATE ON node_artifact_inputs
BEGIN
  SELECT RAISE(ABORT, 'node artifact input is immutable');
END;

CREATE TRIGGER attempt_binding_is_immutable
BEFORE UPDATE OF id, node_id, tree_id, repository_id, host_id, plan_revision_id, ordinal, started_at_ms
ON attempts
BEGIN
  SELECT RAISE(ABORT, 'attempt binding is immutable');
END;
```

### 0002 execution_state

SHA-256: `68816859d07c3e547b512528825a34a98607f6922159ed0443589ffa62e168a4`

```sql
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
```

### 0003 repository_registration

SHA-256: `d67ccca75f23bf79605196f33391fa19656eff6183bf1b41fdc351976f7ddf10`

```sql
CREATE TABLE repository_registrations (
  repository_id TEXT PRIMARY KEY REFERENCES repositories (id) ON DELETE RESTRICT CHECK (length(repository_id) = 36),
  host_id TEXT NOT NULL CHECK (length(host_id) = 36),
  canonical_root TEXT NOT NULL UNIQUE CHECK (length(canonical_root) > 0),
  canonical_remote TEXT NOT NULL CHECK (length(canonical_remote) > 0),
  default_branch TEXT NOT NULL CHECK (length(default_branch) > 0),
  base_commit TEXT NOT NULL CHECK (
    length(base_commit) IN (40, 64)
    AND base_commit NOT GLOB '*[^0-9a-f]*'
  ),
  allowed_workspace_root TEXT NOT NULL UNIQUE CHECK (length(allowed_workspace_root) > 0),
  case_sensitive INTEGER NOT NULL CHECK (case_sensitive IN (0, 1)),
  registered_at_ms INTEGER NOT NULL CHECK (registered_at_ms >= 0),
  UNIQUE (repository_id, host_id),
  FOREIGN KEY (repository_id, host_id) REFERENCES repositories (id, host_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE repository_features (
  repository_id TEXT NOT NULL REFERENCES repository_registrations (repository_id) ON DELETE RESTRICT,
  feature_kind TEXT NOT NULL CHECK (feature_kind IN ('submodule', 'lfs', 'nested_repository')),
  relative_path TEXT NOT NULL CHECK (length(relative_path) > 0),
  PRIMARY KEY (repository_id, feature_kind, relative_path)
) STRICT;

CREATE TRIGGER repository_registration_identity_immutable
BEFORE UPDATE ON repository_registrations
BEGIN
  SELECT RAISE(ABORT, 'repository registration identity is immutable');
END;
```

### 0004 plan_foundation

SHA-256: `cfc111faf78effc03cafd99068016625afabf28d024c42717a27d7aecf11d002`

```sql
CREATE TABLE tree_budgets (
  tree_id TEXT PRIMARY KEY CHECK (length(tree_id) = 36),
  max_depth INTEGER NOT NULL CHECK (max_depth >= 2),
  max_fan_out INTEGER NOT NULL CHECK (max_fan_out > 0),
  max_nodes INTEGER NOT NULL CHECK (max_nodes >= 2),
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency > 0),
  max_attempts_per_node INTEGER NOT NULL CHECK (max_attempts_per_node > 0),
  FOREIGN KEY (tree_id) REFERENCES trees (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE node_repository_scope (
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  repository_path TEXT NOT NULL CHECK (
    length(repository_path) BETWEEN 1 AND 512
  ),
  PRIMARY KEY (node_id, ordinal),
  FOREIGN KEY (node_id) REFERENCES nodes (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE node_plan_policies (
  node_id TEXT PRIMARY KEY CHECK (length(node_id) = 36),
  check_profile TEXT NOT NULL CHECK (
    length(check_profile) BETWEEN 1 AND 512
  ),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  FOREIGN KEY (node_id) REFERENCES nodes (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE plan_attentions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tree_id TEXT NOT NULL CHECK (length(tree_id) = 36),
  plan_revision_id TEXT CHECK (
    plan_revision_id IS NULL OR length(plan_revision_id) = 36
  ),
  kind TEXT NOT NULL CHECK (
    kind IN ('plan_required', 'plan_invalid', 'repair_required')
  ),
  message TEXT NOT NULL CHECK (length(message) > 0),
  state_kind TEXT NOT NULL CHECK (state_kind IN ('open', 'resolved')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  resolved_at_ms INTEGER CHECK (
    (state_kind = 'open' AND resolved_at_ms IS NULL)
    OR (
      state_kind = 'resolved'
      AND resolved_at_ms IS NOT NULL
      AND resolved_at_ms >= created_at_ms
    )
  ),
  FOREIGN KEY (tree_id) REFERENCES trees (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tree_id, plan_revision_id)
    REFERENCES plan_revisions (tree_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX plan_attentions_open
  ON plan_attentions (tree_id)
  WHERE state_kind = 'open';

CREATE TRIGGER node_repository_scope_definition_is_immutable
BEFORE UPDATE OF node_id, ordinal, repository_path
ON node_repository_scope
BEGIN
  SELECT RAISE(ABORT, 'node repository scope definition is immutable');
END;

CREATE TRIGGER node_plan_policy_definition_is_immutable
BEFORE UPDATE OF node_id, check_profile, max_attempts
ON node_plan_policies
BEGIN
  SELECT RAISE(ABORT, 'node plan policy definition is immutable');
END;

CREATE TRIGGER tree_budget_definition_is_immutable
BEFORE UPDATE OF tree_id, max_depth, max_fan_out, max_nodes, max_concurrency,
  max_attempts_per_node
ON tree_budgets
BEGIN
  SELECT RAISE(ABORT, 'tree budget definition is immutable');
END;

CREATE TRIGGER plan_attention_definition_is_immutable
BEFORE UPDATE OF id, tree_id, plan_revision_id, kind, message, created_at_ms
ON plan_attentions
BEGIN
  SELECT RAISE(ABORT, 'plan attention definition is immutable');
END;
```

## Supervisor database

### 0001 execution_hosts

SHA-256: `2700618519f4d30d14d08dc2bce893c1be73965d39eed99a635b28641835d7a6`

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE CHECK (length(name) > 0),
  checksum TEXT NOT NULL CHECK (
    length(checksum) = 64
    AND checksum NOT GLOB '*[^0-9a-f]*'
  ),
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
) STRICT;

CREATE TABLE execution_hosts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  host_kind TEXT NOT NULL CHECK (host_kind IN ('local', 'ssh', 'wsl2')),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN ('pending', 'online', 'offline', 'degraded', 'removed')
  ),
  endpoint TEXT CHECK (endpoint IS NULL OR length(endpoint) > 0),
  version INTEGER NOT NULL CHECK (version >= 0),
  registered_at_ms INTEGER NOT NULL CHECK (registered_at_ms >= 0),
  last_seen_at_ms INTEGER CHECK (
    last_seen_at_ms IS NULL OR last_seen_at_ms >= registered_at_ms
  ),
  removed_at_ms INTEGER CHECK (
    (
      state_kind = 'removed'
      AND removed_at_ms IS NOT NULL
      AND removed_at_ms >= registered_at_ms
    )
    OR (state_kind <> 'removed' AND removed_at_ms IS NULL)
  ),
  CHECK (
    (host_kind = 'local' AND endpoint IS NULL)
    OR (host_kind IN ('ssh', 'wsl2') AND endpoint IS NOT NULL)
  ),
  UNIQUE (id, host_kind)
) STRICT;

CREATE INDEX execution_hosts_state
  ON execution_hosts (state_kind, display_name, id);

CREATE TABLE ssh_profiles (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  host_id TEXT NOT NULL UNIQUE CHECK (length(host_id) = 36),
  host_kind TEXT NOT NULL CHECK (host_kind = 'ssh'),
  hostname TEXT NOT NULL CHECK (length(hostname) > 0),
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username TEXT NOT NULL CHECK (length(username) > 0),
  credential_reference TEXT NOT NULL CHECK (length(credential_reference) > 0),
  host_key_fingerprint TEXT NOT NULL CHECK (length(host_key_fingerprint) > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (host_id, host_kind) REFERENCES execution_hosts (id, host_kind)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE host_projection_cache (
  host_id TEXT PRIMARY KEY CHECK (length(host_id) = 36),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
  minimum_available_sequence INTEGER NOT NULL CHECK (
    minimum_available_sequence >= 0
    AND minimum_available_sequence <= last_sequence + 1
  ),
  snapshot_type TEXT NOT NULL CHECK (length(snapshot_type) > 0),
  snapshot_payload BLOB NOT NULL CHECK (length(snapshot_payload) > 0),
  refreshed_at_ms INTEGER NOT NULL CHECK (refreshed_at_ms >= 0),
  FOREIGN KEY (host_id) REFERENCES execution_hosts (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER execution_host_identity_is_immutable
BEFORE UPDATE OF id, host_kind, registered_at_ms ON execution_hosts
BEGIN
  SELECT RAISE(ABORT, 'execution host identity is immutable');
END;

CREATE TRIGGER ssh_profile_binding_is_immutable
BEFORE UPDATE OF id, host_id, host_kind, created_at_ms ON ssh_profiles
BEGIN
  SELECT RAISE(ABORT, 'SSH profile binding is immutable');
END;
```

### 0002 access_maintenance

SHA-256: `8b0a4c22befee148a589a1ee027025e99e7f0045437b1208a6cbfaea9ceab857`

```sql
CREATE TABLE paired_devices (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  public_key TEXT NOT NULL UNIQUE CHECK (length(public_key) > 0),
  state_kind TEXT NOT NULL CHECK (state_kind IN ('active', 'revoked')),
  paired_at_ms INTEGER NOT NULL CHECK (paired_at_ms >= 0),
  revoked_at_ms INTEGER CHECK (
    (state_kind = 'active' AND revoked_at_ms IS NULL)
    OR (
      state_kind = 'revoked'
      AND revoked_at_ms IS NOT NULL
      AND revoked_at_ms >= paired_at_ms
    )
  )
) STRICT;

CREATE TABLE device_sessions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  device_id TEXT NOT NULL CHECK (length(device_id) = 36),
  token_digest TEXT NOT NULL UNIQUE CHECK (
    length(token_digest) = 64
    AND token_digest NOT GLOB '*[^0-9a-f]*'
  ),
  csrf_digest TEXT NOT NULL CHECK (
    length(csrf_digest) = 64
    AND csrf_digest NOT GLOB '*[^0-9a-f]*'
  ),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('read_only', 'control')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  revoked_at_ms INTEGER CHECK (
    revoked_at_ms IS NULL OR revoked_at_ms >= created_at_ms
  ),
  FOREIGN KEY (device_id) REFERENCES paired_devices (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX device_sessions_device_expiry
  ON device_sessions (device_id, expires_at_ms, id);

CREATE TABLE maintenance_sessions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  owner_session_id TEXT NOT NULL CHECK (length(owner_session_id) = 36),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN ('requested', 'authorized', 'active', 'closed', 'expired', 'revoked')
  ),
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  policy_digest TEXT NOT NULL CHECK (
    length(policy_digest) = 64
    AND policy_digest NOT GLOB '*[^0-9a-f]*'
  ),
  requested_at_ms INTEGER NOT NULL CHECK (requested_at_ms >= 0),
  authorized_at_ms INTEGER CHECK (
    authorized_at_ms IS NULL OR authorized_at_ms >= requested_at_ms
  ),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > requested_at_ms),
  closed_at_ms INTEGER CHECK (
    closed_at_ms IS NULL OR closed_at_ms >= requested_at_ms
  ),
  CHECK (
    state_kind IN ('requested', 'expired') OR authorized_at_ms IS NOT NULL
  ),
  CHECK (
    state_kind IN ('requested', 'authorized', 'active') OR closed_at_ms IS NOT NULL
  )
) STRICT;

CREATE INDEX maintenance_sessions_state
  ON maintenance_sessions (state_kind, expires_at_ms, id);

CREATE TABLE maintenance_actions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  maintenance_session_id TEXT NOT NULL CHECK (length(maintenance_session_id) = 36),
  host_id TEXT CHECK (host_id IS NULL OR length(host_id) = 36),
  action_type TEXT NOT NULL CHECK (length(action_type) > 0),
  request_payload BLOB NOT NULL CHECK (length(request_payload) > 0),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  evidence_type TEXT CHECK (evidence_type IS NULL OR length(evidence_type) > 0),
  evidence_payload BLOB,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  finished_at_ms INTEGER CHECK (
    (state_kind IN ('pending', 'running') AND finished_at_ms IS NULL)
    OR (
      state_kind IN ('succeeded', 'failed', 'cancelled')
      AND finished_at_ms IS NOT NULL
      AND finished_at_ms >= created_at_ms
    )
  ),
  CHECK (
    (state_kind IN ('pending', 'running') AND evidence_type IS NULL AND evidence_payload IS NULL)
    OR (
      state_kind IN ('succeeded', 'failed', 'cancelled')
      AND evidence_type IS NOT NULL
      AND evidence_payload IS NOT NULL
    )
  ),
  UNIQUE (id, maintenance_session_id),
  FOREIGN KEY (maintenance_session_id) REFERENCES maintenance_sessions (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (host_id) REFERENCES execution_hosts (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX maintenance_actions_session
  ON maintenance_actions (maintenance_session_id, created_at_ms, id);

CREATE TABLE maintenance_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) = 36),
  maintenance_session_id TEXT NOT NULL CHECK (length(maintenance_session_id) = 36),
  action_id TEXT CHECK (action_id IS NULL OR length(action_id) = 36),
  event_type TEXT NOT NULL CHECK (length(event_type) > 0),
  event_payload BLOB NOT NULL CHECK (length(event_payload) > 0),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  FOREIGN KEY (maintenance_session_id) REFERENCES maintenance_sessions (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (action_id, maintenance_session_id)
    REFERENCES maintenance_actions (id, maintenance_session_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX maintenance_events_session_sequence
  ON maintenance_events (maintenance_session_id, sequence);

CREATE TRIGGER paired_device_identity_is_immutable
BEFORE UPDATE OF id, public_key, paired_at_ms ON paired_devices
BEGIN
  SELECT RAISE(ABORT, 'paired device identity is immutable');
END;

CREATE TRIGGER device_session_definition_is_immutable
BEFORE UPDATE OF id, device_id, token_digest, csrf_digest, scope_kind,
  created_at_ms, expires_at_ms
ON device_sessions
BEGIN
  SELECT RAISE(ABORT, 'device session definition is immutable');
END;

CREATE TRIGGER maintenance_session_definition_is_immutable
BEFORE UPDATE OF id, owner_session_id, reason, policy_digest, requested_at_ms, expires_at_ms
ON maintenance_sessions
BEGIN
  SELECT RAISE(ABORT, 'maintenance session definition is immutable');
END;

CREATE TRIGGER maintenance_action_definition_is_immutable
BEFORE UPDATE OF id, maintenance_session_id, host_id, action_type,
  request_payload, created_at_ms
ON maintenance_actions
BEGIN
  SELECT RAISE(ABORT, 'maintenance action definition is immutable');
END;

CREATE TRIGGER maintenance_event_is_immutable
BEFORE UPDATE ON maintenance_events
BEGIN
  SELECT RAISE(ABORT, 'maintenance event is immutable');
END;
```
