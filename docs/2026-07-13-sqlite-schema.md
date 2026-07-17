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

### 0005 harness_contract

SHA-256: `9f25b8abd7bcf8e200536f4db27474d48c66b0fbf746b08f610003db794117b0`

```sql
CREATE TEMP TABLE harness_contract_legacy_guard (
  legacy_count INTEGER NOT NULL CHECK (legacy_count = 0)
) STRICT;

INSERT INTO harness_contract_legacy_guard (legacy_count)
SELECT COUNT(*) FROM harness_bindings;

DROP TABLE harness_contract_legacy_guard;

CREATE TABLE node_harness_bindings (
  node_id TEXT PRIMARY KEY CHECK (length(node_id) = 36),
  harness_kind TEXT NOT NULL CHECK (length(harness_kind) > 0),
  provider_kind TEXT NOT NULL CHECK (length(provider_kind) > 0),
  durable_harness_id TEXT NOT NULL UNIQUE CHECK (length(durable_harness_id) > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (node_id, durable_harness_id),
  FOREIGN KEY (node_id) REFERENCES nodes (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE harness_attempt_snapshots (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) = 36),
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  durable_harness_id TEXT NOT NULL CHECK (length(durable_harness_id) > 0),
  harness_version TEXT NOT NULL CHECK (length(harness_version) > 0),
  model TEXT NOT NULL CHECK (length(model) > 0),
  reasoning_level TEXT NOT NULL CHECK (length(reasoning_level) > 0),
  capabilities_json TEXT NOT NULL CHECK (
    json_valid(capabilities_json)
    AND json_type(capabilities_json) = 'array'
  ),
  tools_json TEXT NOT NULL CHECK (
    json_valid(tools_json)
    AND json_type(tools_json) = 'array'
  ),
  security_policy_digest TEXT NOT NULL CHECK (
    length(security_policy_digest) = 64
    AND security_policy_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  FOREIGN KEY (attempt_id) REFERENCES harness_bindings (attempt_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, node_id) REFERENCES attempts (id, node_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (node_id, durable_harness_id)
    REFERENCES node_harness_bindings (node_id, durable_harness_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX harness_bindings_attempt_session
  ON harness_bindings (attempt_id, session_id);

CREATE TABLE harness_process_leases (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  attempt_id TEXT NOT NULL UNIQUE CHECK (length(attempt_id) = 36),
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  session_id TEXT NOT NULL CHECK (length(session_id) > 0),
  process_id TEXT NOT NULL CHECK (length(process_id) > 0),
  state_kind TEXT NOT NULL CHECK (state_kind IN ('active', 'released')),
  acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
  released_at_ms INTEGER CHECK (
    (state_kind = 'active' AND released_at_ms IS NULL)
    OR (
      state_kind = 'released'
      AND released_at_ms IS NOT NULL
      AND released_at_ms >= acquired_at_ms
    )
  ),
  FOREIGN KEY (attempt_id, node_id) REFERENCES attempts (id, node_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, session_id)
    REFERENCES harness_bindings (attempt_id, session_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX harness_process_leases_one_active_node
  ON harness_process_leases (node_id)
  WHERE state_kind = 'active';

CREATE TRIGGER harness_process_lease_snapshot_is_required
BEFORE INSERT ON harness_process_leases
WHEN NOT EXISTS (
  SELECT 1
  FROM harness_attempt_snapshots
  JOIN attempts
    ON attempts.id = NEW.attempt_id
    AND attempts.node_id = NEW.node_id
  JOIN harness_bindings
    ON harness_bindings.attempt_id = NEW.attempt_id
    AND harness_bindings.session_id = NEW.session_id
  JOIN node_harness_bindings
    ON node_harness_bindings.node_id = harness_attempt_snapshots.node_id
    AND node_harness_bindings.durable_harness_id = harness_attempt_snapshots.durable_harness_id
  WHERE harness_attempt_snapshots.attempt_id = NEW.attempt_id
    AND harness_attempt_snapshots.node_id = NEW.node_id
    AND node_harness_bindings.harness_kind = harness_bindings.harness_kind
    AND node_harness_bindings.provider_kind = harness_bindings.provider_kind
    AND harness_attempt_snapshots.model = harness_bindings.model
    AND harness_attempt_snapshots.security_policy_digest = harness_bindings.policy_digest
)
BEGIN
  SELECT RAISE(ABORT, 'harness process lease requires an attempt snapshot');
END;

CREATE TRIGGER harness_attempt_snapshot_binding_is_consistent
BEFORE INSERT ON harness_attempt_snapshots
WHEN NOT EXISTS (
  SELECT 1
  FROM harness_bindings
  JOIN node_harness_bindings
    ON node_harness_bindings.node_id = NEW.node_id
    AND node_harness_bindings.durable_harness_id = NEW.durable_harness_id
  WHERE harness_bindings.attempt_id = NEW.attempt_id
    AND harness_bindings.harness_kind = node_harness_bindings.harness_kind
    AND harness_bindings.provider_kind = node_harness_bindings.provider_kind
    AND harness_bindings.model = NEW.model
    AND harness_bindings.policy_digest = NEW.security_policy_digest
)
BEGIN
  SELECT RAISE(ABORT, 'harness attempt snapshot binding is inconsistent');
END;

CREATE TRIGGER harness_attempt_snapshot_capabilities_are_canonical
BEFORE INSERT ON harness_attempt_snapshots
WHEN (
  json_valid(NEW.capabilities_json)
  AND json_type(NEW.capabilities_json) = 'array'
  AND (
    EXISTS (
      SELECT 1
      FROM json_each(NEW.capabilities_json)
      WHERE type <> 'text'
        OR length(value) = 0
        OR value NOT IN ('abort', 'follow_up', 'interrupt', 'resume', 'snapshot', 'steer')
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.capabilities_json) AS first
      JOIN json_each(NEW.capabilities_json) AS second
        ON first.key < second.key
      WHERE first.value = second.value
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.capabilities_json) AS first
      JOIN json_each(NEW.capabilities_json) AS second
        ON second.key = first.key + 1
      WHERE first.value COLLATE BINARY >= second.value COLLATE BINARY
    )
  )
)
OR (
  json_valid(NEW.tools_json)
  AND json_type(NEW.tools_json) = 'array'
  AND (
    EXISTS (
      SELECT 1
      FROM json_each(NEW.tools_json)
      WHERE type <> 'text' OR length(value) = 0
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.tools_json) AS first
      JOIN json_each(NEW.tools_json) AS second
        ON first.key < second.key
      WHERE first.value = second.value
    )
    OR EXISTS (
      SELECT 1
      FROM json_each(NEW.tools_json) AS first
      JOIN json_each(NEW.tools_json) AS second
        ON second.key = first.key + 1
      WHERE first.value COLLATE BINARY >= second.value COLLATE BINARY
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'harness attempt snapshot arrays are not canonical');
END;

CREATE TRIGGER node_harness_binding_delete_is_forbidden
BEFORE DELETE ON node_harness_bindings
BEGIN
  SELECT RAISE(ABORT, 'node harness binding deletion is forbidden');
END;

CREATE TRIGGER node_harness_binding_replacement_is_forbidden
BEFORE INSERT ON node_harness_bindings
WHEN EXISTS (
  SELECT 1
  FROM node_harness_bindings
  WHERE node_id = NEW.node_id OR durable_harness_id = NEW.durable_harness_id
)
BEGIN
  SELECT RAISE(ABORT, 'node harness binding replacement is forbidden');
END;

CREATE TRIGGER harness_attempt_snapshot_delete_is_forbidden
BEFORE DELETE ON harness_attempt_snapshots
BEGIN
  SELECT RAISE(ABORT, 'harness attempt snapshot deletion is forbidden');
END;

CREATE TRIGGER harness_attempt_snapshot_replacement_is_forbidden
BEFORE INSERT ON harness_attempt_snapshots
WHEN EXISTS (
  SELECT 1
  FROM harness_attempt_snapshots
  WHERE attempt_id = NEW.attempt_id
)
BEGIN
  SELECT RAISE(ABORT, 'harness attempt snapshot replacement is forbidden');
END;

CREATE TRIGGER node_harness_binding_definition_is_immutable
BEFORE UPDATE OF node_id, harness_kind, provider_kind, durable_harness_id, created_at_ms
ON node_harness_bindings
BEGIN
  SELECT RAISE(ABORT, 'node harness binding definition is immutable');
END;

CREATE TRIGGER harness_attempt_snapshot_definition_is_immutable
BEFORE UPDATE OF attempt_id, node_id, durable_harness_id, harness_version, model,
  reasoning_level, capabilities_json, tools_json, security_policy_digest, created_at_ms
ON harness_attempt_snapshots
BEGIN
  SELECT RAISE(ABORT, 'harness attempt snapshot definition is immutable');
END;

CREATE TRIGGER harness_process_lease_identity_is_immutable
BEFORE UPDATE OF id, attempt_id, node_id, session_id, process_id, acquired_at_ms
ON harness_process_leases
BEGIN
  SELECT RAISE(ABORT, 'harness process lease identity is immutable');
END;

CREATE TRIGGER harness_process_lease_state_transition_is_legal
BEFORE UPDATE OF state_kind, released_at_ms
ON harness_process_leases
WHEN NOT (
  OLD.state_kind = 'active'
  AND NEW.state_kind = 'released'
  AND OLD.released_at_ms IS NULL
  AND NEW.released_at_ms IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'harness process lease state transition is illegal');
END;

CREATE TRIGGER attempt_terminal_state_requires_released_harness_lease
BEFORE UPDATE OF state_kind, finished_at_ms, evidence_id ON attempts
WHEN NEW.state_kind <> 'active'
  AND (
    EXISTS (
      SELECT 1
      FROM harness_process_leases
      WHERE attempt_id = NEW.id AND state_kind = 'active'
    )
    OR (
      EXISTS (
        SELECT 1
        FROM harness_bindings
        WHERE attempt_id = NEW.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM harness_bindings AS binding
        JOIN harness_attempt_snapshots AS snapshot
          ON snapshot.attempt_id = binding.attempt_id
          AND snapshot.node_id = NEW.node_id
        JOIN node_harness_bindings AS node_binding
          ON node_binding.node_id = snapshot.node_id
          AND node_binding.durable_harness_id = snapshot.durable_harness_id
        WHERE binding.attempt_id = NEW.id
          AND node_binding.harness_kind = binding.harness_kind
          AND node_binding.provider_kind = binding.provider_kind
          AND snapshot.model = binding.model
          AND snapshot.security_policy_digest = binding.policy_digest
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'attempt cannot become terminal with an active or unsnapshotted harness lease');
END;
```

### 0006 scheduler_leases

SHA-256: `c24931e8c4211782717aeddae06300783acfb65e3997981b9677c5e5e4b5f80b`

```sql
CREATE TABLE node_scheduler_fences (
  node_id TEXT PRIMARY KEY CHECK (length(node_id) = 36),
  next_fencing_token INTEGER NOT NULL CHECK (next_fencing_token > 0),
  FOREIGN KEY (node_id) REFERENCES nodes (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE scheduler_leases (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  attempt_id TEXT NOT NULL UNIQUE CHECK (length(attempt_id) = 36),
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  tree_id TEXT NOT NULL CHECK (length(tree_id) = 36),
  repository_id TEXT NOT NULL CHECK (length(repository_id) = 36),
  host_id TEXT NOT NULL CHECK (length(host_id) = 36),
  owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN ('active', 'released', 'expired', 'cancelled')
  ),
  acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
  heartbeat_at_ms INTEGER NOT NULL CHECK (
    heartbeat_at_ms >= acquired_at_ms
  ),
  expires_at_ms INTEGER NOT NULL CHECK (
    expires_at_ms > heartbeat_at_ms
  ),
  released_at_ms INTEGER CHECK (
    (state_kind = 'active' AND released_at_ms IS NULL)
    OR (
      state_kind <> 'active'
      AND released_at_ms IS NOT NULL
      AND released_at_ms >= heartbeat_at_ms
    )
  ),
  UNIQUE (node_id, fencing_token),
  FOREIGN KEY (attempt_id, node_id, tree_id, repository_id, host_id)
    REFERENCES attempts (id, node_id, tree_id, repository_id, host_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (node_id, tree_id, repository_id, host_id)
    REFERENCES nodes (id, tree_id, repository_id, host_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX scheduler_leases_one_active_per_node
  ON scheduler_leases (node_id)
  WHERE state_kind = 'active';
CREATE INDEX scheduler_leases_active_expiry
  ON scheduler_leases (expires_at_ms, node_id)
  WHERE state_kind = 'active';
CREATE INDEX scheduler_leases_owner_active
  ON scheduler_leases (owner_id, node_id)
  WHERE state_kind = 'active';

CREATE TRIGGER node_scheduler_fence_identity_is_immutable
BEFORE UPDATE OF node_id ON node_scheduler_fences
BEGIN
  SELECT RAISE(ABORT, 'scheduler fence identity is immutable');
END;

CREATE TRIGGER node_scheduler_fence_cannot_decrease
BEFORE UPDATE OF next_fencing_token ON node_scheduler_fences
WHEN NEW.next_fencing_token <= OLD.next_fencing_token
BEGIN
  SELECT RAISE(ABORT, 'scheduler fencing token must increase');
END;

CREATE TRIGGER node_scheduler_fence_is_durable
BEFORE DELETE ON node_scheduler_fences
BEGIN
  SELECT RAISE(ABORT, 'scheduler fence is durable');
END;

CREATE TRIGGER scheduler_lease_identity_is_immutable
BEFORE UPDATE OF id, attempt_id, node_id, tree_id, repository_id, host_id,
  owner_id, fencing_token, acquired_at_ms
ON scheduler_leases
BEGIN
  SELECT RAISE(ABORT, 'scheduler lease identity is immutable');
END;

CREATE TRIGGER scheduler_lease_heartbeat_is_monotonic
BEFORE UPDATE OF heartbeat_at_ms, expires_at_ms ON scheduler_leases
WHEN OLD.state_kind <> 'active'
  OR NEW.state_kind <> 'active'
  OR NEW.heartbeat_at_ms <= OLD.heartbeat_at_ms
  OR NEW.expires_at_ms <= OLD.expires_at_ms
BEGIN
  SELECT RAISE(ABORT, 'scheduler lease heartbeat is illegal');
END;

CREATE TRIGGER scheduler_lease_state_transition_is_legal
BEFORE UPDATE OF state_kind, released_at_ms ON scheduler_leases
WHEN NOT (
  OLD.state_kind = 'active'
  AND NEW.state_kind IN ('released', 'expired', 'cancelled')
  AND NEW.released_at_ms IS NOT NULL
  AND NEW.released_at_ms >= OLD.heartbeat_at_ms
)
BEGIN
  SELECT RAISE(ABORT, 'scheduler lease state transition is illegal');
END;

CREATE TRIGGER scheduler_lease_is_durable
BEFORE DELETE ON scheduler_leases
BEGIN
  SELECT RAISE(ABORT, 'scheduler lease is durable');
END;
```

### 0007 durable_steering

SHA-256: `804dc3a213db14f1b6b74aab04bfb2d2a3e20f27c06f4dc70b8afb298422121f`

```sql
CREATE TABLE node_command_sequences (
  node_id TEXT PRIMARY KEY CHECK (length(node_id) = 36),
  next_ordinal INTEGER NOT NULL CHECK (next_ordinal > 0),
  FOREIGN KEY (node_id) REFERENCES nodes (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE node_command_deliveries (
  command_id TEXT PRIMARY KEY CHECK (length(command_id) = 36),
  actor_session_id TEXT NOT NULL CHECK (length(actor_session_id) = 36),
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  command_kind TEXT NOT NULL CHECK (command_kind IN (
    'message', 'steer_after_current_tool', 'interrupt_now', 'follow_up_after_turn',
    'pause', 'resume', 'answer', 'approve', 'reject', 'retry', 'cancel_node',
    'cancel_subtree', 'replan_unstarted_subtree'
  )),
  payload BLOB NOT NULL CHECK (length(payload) > 0),
  safe_to_redeliver INTEGER NOT NULL CHECK (safe_to_redeliver IN (0, 1)),
  state_kind TEXT NOT NULL CHECK (state_kind IN (
    'queued', 'sent', 'acknowledged', 'applied', 'failed', 'review_required'
  )),
  recovery_disposition TEXT NOT NULL CHECK (recovery_disposition IN (
    'resume_session', 'fork_session', 'retry_external_action', 'requires_review'
  )),
  delivery_attempts INTEGER NOT NULL CHECK (delivery_attempts >= 0),
  delivery_token TEXT CHECK (delivery_token IS NULL OR length(delivery_token) = 36),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  sent_at_ms INTEGER CHECK (sent_at_ms IS NULL OR sent_at_ms >= created_at_ms),
  acknowledged_at_ms INTEGER CHECK (
    acknowledged_at_ms IS NULL OR acknowledged_at_ms >= sent_at_ms
  ),
  applied_at_ms INTEGER CHECK (applied_at_ms IS NULL OR applied_at_ms >= acknowledged_at_ms),
  failed_at_ms INTEGER CHECK (failed_at_ms IS NULL OR failed_at_ms >= sent_at_ms),
  failure TEXT CHECK (failure IS NULL OR length(failure) > 0),
  UNIQUE (node_id, ordinal),
  UNIQUE (command_id, node_id),
  UNIQUE (delivery_token),
  CHECK (
    (state_kind = 'queued' AND delivery_attempts = 0 AND delivery_token IS NULL
      AND sent_at_ms IS NULL AND acknowledged_at_ms IS NULL AND applied_at_ms IS NULL
      AND failed_at_ms IS NULL AND failure IS NULL)
    OR (state_kind = 'sent' AND delivery_attempts > 0 AND delivery_token IS NOT NULL
      AND sent_at_ms IS NOT NULL AND acknowledged_at_ms IS NULL AND applied_at_ms IS NULL
      AND failed_at_ms IS NULL AND failure IS NULL)
    OR (state_kind = 'acknowledged' AND delivery_attempts > 0 AND delivery_token IS NOT NULL
      AND sent_at_ms IS NOT NULL AND acknowledged_at_ms IS NOT NULL AND applied_at_ms IS NULL
      AND failed_at_ms IS NULL AND failure IS NULL)
    OR (state_kind = 'applied' AND delivery_attempts > 0 AND delivery_token IS NOT NULL
      AND sent_at_ms IS NOT NULL AND acknowledged_at_ms IS NOT NULL AND applied_at_ms IS NOT NULL
      AND failed_at_ms IS NULL AND failure IS NULL)
    OR (state_kind IN ('failed', 'review_required') AND delivery_attempts > 0
      AND delivery_token IS NOT NULL AND sent_at_ms IS NOT NULL
      AND applied_at_ms IS NULL AND failed_at_ms IS NOT NULL
      AND failure IS NOT NULL)
  ),
  FOREIGN KEY (node_id) REFERENCES nodes (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX node_command_deliveries_node_state
  ON node_command_deliveries (node_id, state_kind, ordinal);

CREATE TABLE node_attention_records (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  attention_kind TEXT NOT NULL CHECK (attention_kind IN ('question', 'approval')),
  prompt TEXT NOT NULL CHECK (length(prompt) > 0),
  choices_json TEXT NOT NULL CHECK (
    json_valid(choices_json) AND json_type(choices_json) = 'array'
  ),
  state_kind TEXT NOT NULL CHECK (state_kind IN ('open', 'resolved')),
  resolution_command_id TEXT CHECK (
    resolution_command_id IS NULL OR length(resolution_command_id) = 36
  ),
  resolution TEXT CHECK (resolution IS NULL OR length(resolution) > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  resolved_at_ms INTEGER CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= created_at_ms),
  CHECK (
    (state_kind = 'open' AND resolution_command_id IS NULL AND resolution IS NULL
      AND resolved_at_ms IS NULL)
    OR (state_kind = 'resolved' AND resolution_command_id IS NOT NULL
      AND resolution IS NOT NULL AND resolved_at_ms IS NOT NULL)
  ),
  UNIQUE (id, node_id),
  FOREIGN KEY (node_id) REFERENCES nodes (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (resolution_command_id, node_id)
    REFERENCES node_command_deliveries (command_id, node_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX node_attention_records_node_state
  ON node_attention_records (node_id, state_kind, created_at_ms, id);

CREATE TRIGGER node_command_sequence_is_monotonic
BEFORE UPDATE OF next_ordinal ON node_command_sequences
WHEN NEW.next_ordinal <= OLD.next_ordinal
BEGIN
  SELECT RAISE(ABORT, 'node command sequence must increase');
END;

CREATE TRIGGER node_command_sequence_is_durable
BEFORE DELETE ON node_command_sequences
BEGIN
  SELECT RAISE(ABORT, 'node command sequence is durable');
END;

CREATE TRIGGER node_command_delivery_initial_state_is_queued
BEFORE INSERT ON node_command_deliveries
WHEN NEW.state_kind <> 'queued'
BEGIN
  SELECT RAISE(ABORT, 'node command delivery must start queued');
END;

CREATE TRIGGER node_command_delivery_identity_is_immutable
BEFORE UPDATE OF command_id, actor_session_id, node_id, ordinal, command_kind, payload,
  safe_to_redeliver, created_at_ms
ON node_command_deliveries
BEGIN
  SELECT RAISE(ABORT, 'node command delivery identity is immutable');
END;

CREATE TRIGGER node_command_delivery_transition_is_legal
BEFORE UPDATE OF state_kind ON node_command_deliveries
WHEN NOT (
  (OLD.state_kind = 'queued' AND NEW.state_kind = 'sent')
  OR (OLD.state_kind = 'sent' AND NEW.state_kind IN (
    'sent', 'acknowledged', 'failed', 'review_required'
  ))
  OR (OLD.state_kind = 'acknowledged' AND NEW.state_kind IN ('applied', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'node command delivery transition is illegal');
END;

CREATE TRIGGER node_command_delivery_terminal_is_immutable
BEFORE UPDATE ON node_command_deliveries
WHEN OLD.state_kind IN ('applied', 'failed', 'review_required')
BEGIN
  SELECT RAISE(ABORT, 'terminal node command delivery is immutable');
END;

CREATE TRIGGER node_command_delivery_is_durable
BEFORE DELETE ON node_command_deliveries
BEGIN
  SELECT RAISE(ABORT, 'node command delivery is durable');
END;

CREATE TRIGGER node_attention_choices_are_canonical
BEFORE INSERT ON node_attention_records
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.choices_json)
   WHERE type <> 'text' OR length(value) = 0
)
OR EXISTS (
  SELECT value FROM json_each(NEW.choices_json)
   GROUP BY value HAVING count(*) > 1
)
BEGIN
  SELECT RAISE(ABORT, 'node attention choices are invalid');
END;

CREATE TRIGGER node_attention_identity_is_immutable
BEFORE UPDATE OF id, node_id, attention_kind, prompt, choices_json, created_at_ms
ON node_attention_records
BEGIN
  SELECT RAISE(ABORT, 'node attention identity is immutable');
END;

CREATE TRIGGER node_attention_resolution_is_legal
BEFORE UPDATE OF state_kind, resolution_command_id, resolution, resolved_at_ms
ON node_attention_records
WHEN NOT (OLD.state_kind = 'open' AND NEW.state_kind = 'resolved')
BEGIN
  SELECT RAISE(ABORT, 'node attention resolution is illegal');
END;

CREATE TRIGGER node_attention_is_durable
BEFORE DELETE ON node_attention_records
BEGIN
  SELECT RAISE(ABORT, 'node attention is durable');
END;
```

### 0008 artifacts_outcomes

SHA-256: `25b3d19bed959935a4b3278967070621311bf71a2341082ef921c9c79861d774`

```sql
CREATE TABLE node_outcome_records (
  node_id TEXT PRIMARY KEY CHECK (length(node_id) = 36),
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN ('artifact', 'no_change', 'commit')),
  artifact_id TEXT CHECK (artifact_id IS NULL OR length(artifact_id) = 36),
  revision TEXT CHECK (
    revision IS NULL OR (
      length(revision) IN (40, 64)
      AND revision NOT GLOB '*[^0-9a-f]*'
    )
  ),
  evidence_id TEXT CHECK (evidence_id IS NULL OR length(evidence_id) = 36),
  explanation TEXT CHECK (explanation IS NULL OR length(explanation) > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  CHECK (
    (outcome_kind = 'artifact' AND artifact_id IS NOT NULL
      AND revision IS NULL AND evidence_id IS NULL AND explanation IS NULL)
    OR (outcome_kind = 'no_change' AND artifact_id IS NULL
      AND revision IS NOT NULL AND evidence_id IS NOT NULL AND explanation IS NOT NULL)
    OR (outcome_kind = 'commit' AND artifact_id IS NULL
      AND revision IS NOT NULL AND evidence_id IS NOT NULL AND explanation IS NULL)
  ),
  UNIQUE (node_id, outcome_kind),
  UNIQUE (artifact_id, node_id),
  FOREIGN KEY (node_id) REFERENCES nodes (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id, node_id) REFERENCES artifacts (id, node_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX node_outcome_records_kind_created
  ON node_outcome_records (outcome_kind, created_at_ms, node_id);

CREATE TRIGGER node_outcome_backfill_artifact_matches_legacy
BEFORE INSERT ON node_outcome_records
WHEN NEW.outcome_kind = 'artifact'
  AND NOT EXISTS (
    SELECT 1
    FROM nodes AS node
    JOIN artifacts AS artifact
      ON artifact.id = NEW.artifact_id
     AND artifact.node_id = NEW.node_id
    WHERE node.id = NEW.node_id
      AND node.state_kind = 'succeeded'
      AND artifact.tree_id = node.tree_id
      AND artifact.repository_id = node.repository_id
      AND artifact.host_id = node.host_id
      AND artifact.content_digest = node.outcome_content_hash
      AND artifact.artifact_type = node.outcome_artifact_type
      AND artifact.evidence_id = node.outcome_evidence_id
  )
BEGIN
  SELECT RAISE(ABORT, 'legacy artifact outcome is not normalized');
END;

INSERT INTO node_outcome_records (
  node_id, outcome_kind, artifact_id, revision, evidence_id, explanation, created_at_ms
)
SELECT
  node.id,
  node.outcome_kind,
  CASE WHEN node.outcome_kind = 'artifact' THEN node.outcome_artifact_id END,
  CASE WHEN node.outcome_kind = 'commit' THEN node.outcome_commit END,
  CASE WHEN node.outcome_kind IN ('commit', 'no_change') THEN node.outcome_evidence_id END,
  CASE WHEN node.outcome_kind = 'no_change' THEN node.outcome_explanation END,
  node.updated_at_ms
FROM nodes AS node
WHERE node.state_kind = 'succeeded'
  AND node.outcome_kind IN ('artifact', 'commit');

WITH RECURSIVE ancestor (
  node_id, tree_id, ancestor_id, parent_node_id, outcome_kind, outcome_commit, depth
) AS (
  SELECT
    node.id,
    node.tree_id,
    node.id,
    node.parent_node_id,
    node.outcome_kind,
    node.outcome_commit,
    0
  FROM nodes AS node
  WHERE node.state_kind = 'succeeded'
    AND node.outcome_kind = 'no_change'
  UNION ALL
  SELECT
    ancestor.node_id,
    ancestor.tree_id,
    parent.id,
    parent.parent_node_id,
    parent.outcome_kind,
    parent.outcome_commit,
    ancestor.depth + 1
  FROM ancestor
  JOIN nodes AS parent
    ON parent.id = ancestor.parent_node_id
   AND parent.tree_id = ancestor.tree_id
)
INSERT INTO node_outcome_records (
  node_id, outcome_kind, artifact_id, revision, evidence_id, explanation, created_at_ms
)
SELECT
  node.id,
  'no_change',
  NULL,
  COALESCE(
    (
      SELECT ancestor.outcome_commit
      FROM ancestor
      WHERE ancestor.node_id = node.id
        AND ancestor.outcome_kind = 'commit'
      ORDER BY ancestor.depth, ancestor.ancestor_id
      LIMIT 1
    ),
    tree.base_commit
  ),
  node.outcome_evidence_id,
  node.outcome_explanation,
  node.updated_at_ms
FROM nodes AS node
JOIN trees AS tree ON tree.id = node.tree_id
WHERE node.state_kind = 'succeeded'
  AND node.outcome_kind = 'no_change';
DROP TRIGGER node_outcome_backfill_artifact_matches_legacy;

CREATE TRIGGER content_blob_is_durable
BEFORE DELETE ON content_blobs
BEGIN
  SELECT RAISE(ABORT, 'content blob is durable');
END;

CREATE TRIGGER artifact_is_durable
BEFORE DELETE ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifact is durable');
END;

CREATE TRIGGER node_outcome_is_immutable
BEFORE UPDATE ON node_outcome_records
BEGIN
  SELECT RAISE(ABORT, 'node outcome is immutable');
END;

CREATE TRIGGER node_outcome_is_durable
BEFORE DELETE ON node_outcome_records
BEGIN
  SELECT RAISE(ABORT, 'node outcome is durable');
END;

CREATE TRIGGER node_outcome_record_requires_active_node
BEFORE INSERT ON node_outcome_records
WHEN NOT EXISTS (
  SELECT 1
  FROM nodes AS node
  WHERE node.id = NEW.node_id
    AND node.state_kind = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'node outcome requires an active node');
END;

CREATE TRIGGER node_outcome_record_artifact_matches_node
BEFORE INSERT ON node_outcome_records
WHEN NEW.outcome_kind = 'artifact'
  AND NOT EXISTS (
    SELECT 1
    FROM nodes AS node
    JOIN artifacts AS artifact
      ON artifact.id = NEW.artifact_id
     AND artifact.node_id = NEW.node_id
    WHERE node.id = NEW.node_id
      AND node.state_kind = 'active'
      AND node.output_kind = 'artifact'
      AND node.output_artifact_id = NEW.artifact_id
      AND artifact.artifact_type = node.output_artifact_type
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact outcome does not match active node ownership');
END;

CREATE TRIGGER node_outcome_record_commit_matches_node
BEFORE INSERT ON node_outcome_records
WHEN NEW.outcome_kind = 'commit'
  AND NOT EXISTS (
    SELECT 1
    FROM nodes AS node
    WHERE node.id = NEW.node_id
      AND node.state_kind = 'active'
      AND node.output_kind = 'implementation'
  )
BEGIN
  SELECT RAISE(ABORT, 'commit outcome requires an active implementation node');
END;

CREATE TRIGGER node_outcome_record_no_change_matches_node
BEFORE INSERT ON node_outcome_records
WHEN NEW.outcome_kind = 'no_change'
  AND NOT EXISTS (
    SELECT 1
    FROM nodes AS node
    WHERE node.id = NEW.node_id
      AND node.state_kind = 'active'
      AND node.output_kind = 'implementation'
  )
BEGIN
  SELECT RAISE(ABORT, 'no-change outcome requires an active implementation node');
END;

CREATE TRIGGER node_outcome_record_no_change_ancestry_is_complete
BEFORE INSERT ON node_outcome_records
WHEN NEW.outcome_kind = 'no_change'
BEGIN
  WITH RECURSIVE ancestor (
    id, tree_id, root_node_id, parent_node_id, state_kind, outcome_kind, depth, missing
  ) AS (
    SELECT
      parent.id,
      node.tree_id,
      tree.root_node_id,
      parent.parent_node_id,
      parent.state_kind,
      parent.outcome_kind,
      0,
      CASE WHEN parent.id IS NULL THEN 1 ELSE 0 END
    FROM nodes AS node
    JOIN trees AS tree ON tree.id = node.tree_id
    LEFT JOIN nodes AS parent
      ON parent.id = node.parent_node_id
     AND parent.tree_id = node.tree_id
    WHERE node.id = NEW.node_id
      AND node.parent_node_id IS NOT NULL
    UNION ALL
    SELECT
      parent.id,
      ancestor.tree_id,
      ancestor.root_node_id,
      parent.parent_node_id,
      parent.state_kind,
      parent.outcome_kind,
      ancestor.depth + 1,
      CASE WHEN parent.id IS NULL THEN 1 ELSE 0 END
    FROM ancestor
    LEFT JOIN nodes AS parent
      ON parent.id = ancestor.parent_node_id
     AND parent.tree_id = ancestor.tree_id
    WHERE ancestor.id IS NOT NULL
      AND NOT (
        (ancestor.outcome_kind IS NOT NULL
         AND ancestor.outcome_kind IN ('commit', 'no_change'))
        OR (
          ancestor.id = ancestor.root_node_id
          AND ancestor.state_kind IN ('planned', 'succeeded')
        )
      )
  )
  SELECT RAISE(ABORT, 'no-change parent chain is incomplete')
  WHERE EXISTS (
    SELECT 1
    FROM ancestor
    LEFT JOIN node_outcome_records AS outcome ON outcome.node_id = ancestor.id
    WHERE ancestor.missing = 1
       OR NOT (
         (ancestor.id = ancestor.root_node_id AND ancestor.state_kind = 'planned')
         OR (
           ancestor.state_kind = 'succeeded'
           AND outcome.node_id IS NOT NULL
           AND outcome.outcome_kind = ancestor.outcome_kind
         )
       )
  );
END;

CREATE TRIGGER node_outcome_record_no_change_revision_is_inherited
BEFORE INSERT ON node_outcome_records
WHEN NEW.outcome_kind = 'no_change'
BEGIN
  WITH RECURSIVE ancestor (
    node_id, root_node_id, tree_id, ancestor_id, parent_node_id,
    state_kind, outcome_kind, outcome_commit, depth
  ) AS (
    SELECT
      node.id,
      tree.root_node_id,
      node.tree_id,
      node.id,
      node.parent_node_id,
      node.state_kind,
      node.outcome_kind,
      node.outcome_commit,
      0
    FROM nodes AS node
    JOIN trees AS tree ON tree.id = node.tree_id
    WHERE node.id = NEW.node_id
    UNION ALL
    SELECT
      ancestor.node_id,
      ancestor.root_node_id,
      ancestor.tree_id,
      parent.id,
      parent.parent_node_id,
      parent.state_kind,
      parent.outcome_kind,
      parent.outcome_commit,
      ancestor.depth + 1
    FROM ancestor
    JOIN nodes AS parent
      ON parent.id = ancestor.parent_node_id
     AND parent.tree_id = ancestor.tree_id
    WHERE ancestor.parent_node_id IS NOT NULL
      AND NOT (
        (ancestor.outcome_kind IS NOT NULL
         AND ancestor.outcome_kind IN ('commit', 'no_change'))
        OR (
          ancestor.ancestor_id = ancestor.root_node_id
          AND ancestor.state_kind IN ('planned', 'succeeded')
        )
      )
  )
  SELECT RAISE(ABORT, 'no-change revision does not match inherited revision')
  WHERE NEW.revision <> COALESCE(
    (
      SELECT CASE
        WHEN ancestor.outcome_kind = 'commit' THEN ancestor.outcome_commit
        WHEN ancestor.outcome_kind = 'no_change' THEN outcome.revision
      END
      FROM ancestor
      LEFT JOIN node_outcome_records AS outcome ON outcome.node_id = ancestor.ancestor_id
      WHERE ancestor.state_kind = 'succeeded'
        AND ancestor.outcome_kind IN ('commit', 'no_change')
        AND outcome.node_id IS NOT NULL
      ORDER BY ancestor.depth, ancestor.ancestor_id
      LIMIT 1
    ),
    (
      SELECT tree.base_commit
      FROM nodes AS node
      JOIN trees AS tree ON tree.id = node.tree_id
      WHERE node.id = NEW.node_id
    )
  );
END;

CREATE TRIGGER node_succeeded_insert_is_forbidden
BEFORE INSERT ON nodes
WHEN NEW.state_kind = 'succeeded'
BEGIN
  SELECT RAISE(ABORT, 'succeeded nodes require normalized outcomes');
END;

CREATE TRIGGER node_succeeded_state_is_terminal
BEFORE UPDATE OF state_kind ON nodes
WHEN OLD.state_kind = 'succeeded'
  AND NEW.state_kind <> 'succeeded'
BEGIN
  SELECT RAISE(ABORT, 'succeeded node state is terminal');
END;

CREATE TRIGGER node_succeeded_outcome_requires_record
BEFORE UPDATE ON nodes
WHEN NEW.state_kind = 'succeeded'
  AND (
    SELECT COUNT(*)
    FROM node_outcome_records AS outcome
    WHERE outcome.node_id = NEW.id
  ) <> 1
BEGIN
  SELECT RAISE(ABORT, 'succeeded node requires exactly one normalized outcome');
END;

CREATE TRIGGER node_succeeded_artifact_outcome_matches
BEFORE UPDATE ON nodes
WHEN NEW.state_kind = 'succeeded'
  AND NEW.outcome_kind = 'artifact'
  AND NOT EXISTS (
    SELECT 1
    FROM node_outcome_records AS outcome
    JOIN artifacts AS artifact
      ON artifact.id = outcome.artifact_id
     AND artifact.node_id = outcome.node_id
    WHERE outcome.node_id = NEW.id
      AND outcome.outcome_kind = 'artifact'
      AND outcome.artifact_id = NEW.outcome_artifact_id
      AND artifact.artifact_type = NEW.outcome_artifact_type
      AND artifact.content_digest = NEW.outcome_content_hash
      AND artifact.evidence_id = NEW.outcome_evidence_id
  )
BEGIN
  SELECT RAISE(ABORT, 'succeeded artifact outcome is not normalized');
END;

CREATE TRIGGER node_succeeded_commit_outcome_matches
BEFORE UPDATE ON nodes
WHEN NEW.state_kind = 'succeeded'
  AND NEW.outcome_kind = 'commit'
  AND NOT EXISTS (
    SELECT 1
    FROM node_outcome_records AS outcome
    WHERE outcome.node_id = NEW.id
      AND outcome.outcome_kind = 'commit'
      AND outcome.artifact_id IS NULL
      AND outcome.revision = NEW.outcome_commit
      AND outcome.evidence_id = NEW.outcome_evidence_id
      AND outcome.explanation IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'succeeded commit outcome is not normalized');
END;

CREATE TRIGGER node_succeeded_no_change_outcome_matches
BEFORE UPDATE ON nodes
WHEN NEW.state_kind = 'succeeded'
  AND NEW.outcome_kind = 'no_change'
BEGIN
  WITH RECURSIVE ancestor (
    id, tree_id, root_node_id, parent_node_id, state_kind, outcome_kind, outcome_commit, depth, missing
  ) AS (
    SELECT
      parent.id,
      node.tree_id,
      tree.root_node_id,
      parent.parent_node_id,
      parent.state_kind,
      parent.outcome_kind,
      parent.outcome_commit,
      0,
      CASE WHEN parent.id IS NULL THEN 1 ELSE 0 END
    FROM nodes AS node
    JOIN trees AS tree ON tree.id = node.tree_id
    LEFT JOIN nodes AS parent
      ON parent.id = node.parent_node_id
     AND parent.tree_id = node.tree_id
    WHERE node.id = NEW.id
      AND node.parent_node_id IS NOT NULL
    UNION ALL
    SELECT
      parent.id,
      ancestor.tree_id,
      ancestor.root_node_id,
      parent.parent_node_id,
      parent.state_kind,
      parent.outcome_kind,
      parent.outcome_commit,
      ancestor.depth + 1,
      CASE WHEN parent.id IS NULL THEN 1 ELSE 0 END
    FROM ancestor
    LEFT JOIN nodes AS parent
      ON parent.id = ancestor.parent_node_id
     AND parent.tree_id = ancestor.tree_id
    WHERE ancestor.id IS NOT NULL
      AND NOT (
        (ancestor.outcome_kind IS NOT NULL
         AND ancestor.outcome_kind IN ('commit', 'no_change'))
        OR (
          ancestor.id = ancestor.root_node_id
          AND ancestor.state_kind IN ('planned', 'succeeded')
        )
      )
  )
  SELECT RAISE(ABORT, 'succeeded no-change outcome is not normalized')
  WHERE EXISTS (
    SELECT 1
    FROM ancestor
    LEFT JOIN node_outcome_records AS parent_outcome
      ON parent_outcome.node_id = ancestor.id
    WHERE ancestor.missing = 1
       OR NOT (
         (ancestor.id = ancestor.root_node_id AND ancestor.state_kind = 'planned')
         OR (
           ancestor.state_kind = 'succeeded'
           AND parent_outcome.node_id IS NOT NULL
           AND parent_outcome.outcome_kind = ancestor.outcome_kind
         )
       )
  )
  OR NOT EXISTS (
    SELECT 1
    FROM node_outcome_records AS outcome
    WHERE outcome.node_id = NEW.id
      AND outcome.outcome_kind = 'no_change'
      AND outcome.artifact_id IS NULL
      AND outcome.revision = COALESCE(
        (
          SELECT CASE
            WHEN ancestor.outcome_kind = 'commit' THEN ancestor.outcome_commit
            WHEN ancestor.outcome_kind = 'no_change' THEN parent_outcome.revision
          END
          FROM ancestor
          LEFT JOIN node_outcome_records AS parent_outcome
            ON parent_outcome.node_id = ancestor.id
          WHERE ancestor.state_kind = 'succeeded'
            AND ancestor.outcome_kind IN ('commit', 'no_change')
            AND parent_outcome.node_id IS NOT NULL
          ORDER BY ancestor.depth, ancestor.id
          LIMIT 1
        ),
        (
          SELECT tree.base_commit
          FROM nodes AS node
          JOIN trees AS tree ON tree.id = node.tree_id
          WHERE node.id = NEW.id
        )
      )
      AND outcome.evidence_id = NEW.outcome_evidence_id
      AND outcome.explanation = NEW.outcome_explanation
  );
END;
```

### 0009 git_workspaces

SHA-256: `908a944b9373b887ff81593ccced426e9b5bab300441efacbffa96ceb5dedffc`

```sql
CREATE TABLE workspace_bindings_v9 (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) = 36),
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  tree_id TEXT NOT NULL CHECK (length(tree_id) = 36),
  repository_id TEXT NOT NULL CHECK (length(repository_id) = 36),
  host_id TEXT NOT NULL CHECK (length(host_id) = 36),
  workspace_path TEXT NOT NULL UNIQUE CHECK (length(workspace_path) > 0),
  source_path TEXT NOT NULL CHECK (length(source_path) > 0),
  branch_name TEXT NOT NULL CHECK (length(branch_name) > 0),
  base_commit TEXT NOT NULL CHECK (
    length(base_commit) IN (40, 64)
    AND base_commit NOT GLOB '*[^0-9a-f]*'
  ),
  head_commit TEXT NOT NULL CHECK (
    length(head_commit) IN (40, 64)
    AND head_commit NOT GLOB '*[^0-9a-f]*'
  ),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN ('creating', 'ready', 'cleanup_pending', 'cleaned', 'failed')
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  ready_at_ms INTEGER CHECK (
    ready_at_ms IS NULL OR ready_at_ms >= created_at_ms
  ),
  cleanup_requested_at_ms INTEGER CHECK (
    cleanup_requested_at_ms IS NULL OR cleanup_requested_at_ms >= ready_at_ms
  ),
  cleaned_at_ms INTEGER CHECK (
    cleaned_at_ms IS NULL OR cleaned_at_ms >= cleanup_requested_at_ms
  ),
  failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) > 0),
  version INTEGER NOT NULL CHECK (version >= 0),
  mutation_fencing_token INTEGER NOT NULL CHECK (mutation_fencing_token > 0),
  CHECK (
    (state_kind = 'creating'
      AND ready_at_ms IS NULL
      AND cleanup_requested_at_ms IS NULL
      AND cleaned_at_ms IS NULL
      AND failure_code IS NULL)
    OR (state_kind = 'ready'
      AND ready_at_ms IS NOT NULL
      AND cleanup_requested_at_ms IS NULL
      AND cleaned_at_ms IS NULL
      AND failure_code IS NULL)
    OR (state_kind = 'cleanup_pending'
      AND ready_at_ms IS NOT NULL
      AND cleanup_requested_at_ms IS NOT NULL
      AND cleaned_at_ms IS NULL
      AND failure_code IS NULL)
    OR (state_kind = 'cleaned'
      AND ready_at_ms IS NOT NULL
      AND cleanup_requested_at_ms IS NOT NULL
      AND cleaned_at_ms IS NOT NULL
      AND failure_code IS NULL)
    OR (state_kind = 'failed'
      AND cleaned_at_ms IS NULL
      AND failure_code IS NOT NULL)
  ),
  UNIQUE (repository_id, branch_name),
  FOREIGN KEY (attempt_id, node_id, tree_id, repository_id, host_id)
    REFERENCES attempts (id, node_id, tree_id, repository_id, host_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (repository_id, host_id)
    REFERENCES repositories (id, host_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

INSERT INTO workspace_bindings_v9 (
  attempt_id, node_id, tree_id, repository_id, host_id,
  workspace_path, source_path, branch_name, base_commit, head_commit,
  state_kind, created_at_ms, ready_at_ms, cleanup_requested_at_ms,
  cleaned_at_ms, failure_code, version, mutation_fencing_token
)
SELECT
  w.attempt_id,
  CASE WHEN a.id IS NOT NULL
         AND a.repository_id = w.repository_id
         AND r.id IS NOT NULL
         AND a.host_id = r.host_id
         AND rr.repository_id IS NOT NULL
       THEN a.node_id ELSE NULL END,
  CASE WHEN a.id IS NOT NULL
         AND a.repository_id = w.repository_id
         AND r.id IS NOT NULL
         AND a.host_id = r.host_id
         AND rr.repository_id IS NOT NULL
       THEN a.tree_id ELSE NULL END,
  CASE WHEN a.id IS NOT NULL
         AND a.repository_id = w.repository_id
         AND r.id IS NOT NULL
         AND a.host_id = r.host_id
         AND rr.repository_id IS NOT NULL
       THEN w.repository_id ELSE NULL END,
  CASE WHEN a.id IS NOT NULL
         AND a.repository_id = w.repository_id
         AND r.id IS NOT NULL
         AND a.host_id = r.host_id
         AND rr.repository_id IS NOT NULL
       THEN a.host_id ELSE NULL END,
  w.workspace_path,
  CASE WHEN a.id IS NOT NULL
         AND a.repository_id = w.repository_id
         AND r.id IS NOT NULL
         AND a.host_id = r.host_id
         AND rr.repository_id IS NOT NULL
       THEN rr.canonical_root ELSE NULL END,
  w.branch_name,
  w.base_commit,
  w.base_commit,
  CASE WHEN w.cleaned_at_ms IS NULL THEN 'ready' ELSE 'cleaned' END,
  w.created_at_ms,
  w.created_at_ms,
  w.cleaned_at_ms,
  w.cleaned_at_ms,
  NULL,
  0,
  1
FROM workspace_bindings AS w
LEFT JOIN attempts AS a ON a.id = w.attempt_id
LEFT JOIN repositories AS r ON r.id = w.repository_id
LEFT JOIN repository_registrations AS rr
  ON rr.repository_id = w.repository_id AND rr.host_id = a.host_id;

DROP TABLE workspace_bindings;
ALTER TABLE workspace_bindings_v9 RENAME TO workspace_bindings;

CREATE INDEX workspace_bindings_state
  ON workspace_bindings (state_kind, created_at_ms, attempt_id);
CREATE INDEX workspace_bindings_cleanup
  ON workspace_bindings (state_kind, cleanup_requested_at_ms, attempt_id)
  WHERE state_kind = 'cleanup_pending';

CREATE TRIGGER workspace_binding_identity_is_immutable_v9
BEFORE UPDATE OF attempt_id, node_id, tree_id, repository_id, host_id,
  workspace_path, source_path, branch_name, base_commit, created_at_ms
ON workspace_bindings
BEGIN
  SELECT RAISE(ABORT, 'workspace binding identity is immutable');
END;

CREATE TRIGGER workspace_binding_timestamp_is_monotonic_v9
BEFORE UPDATE OF ready_at_ms, cleanup_requested_at_ms, cleaned_at_ms
ON workspace_bindings
WHEN (OLD.ready_at_ms IS NOT NULL AND
      (NEW.ready_at_ms IS NULL OR NEW.ready_at_ms < OLD.ready_at_ms))
  OR (OLD.cleanup_requested_at_ms IS NOT NULL AND
      (NEW.cleanup_requested_at_ms IS NULL OR
       NEW.cleanup_requested_at_ms < OLD.cleanup_requested_at_ms))
  OR (OLD.cleaned_at_ms IS NOT NULL AND
      (NEW.cleaned_at_ms IS NULL OR NEW.cleaned_at_ms < OLD.cleaned_at_ms))
BEGIN
  SELECT RAISE(ABORT, 'workspace binding timestamps are not monotonic');
END;

CREATE TRIGGER workspace_binding_state_transition_is_legal_v9
BEFORE UPDATE OF state_kind
ON workspace_bindings
WHEN NOT (
  NEW.state_kind = OLD.state_kind
  OR (OLD.state_kind = 'creating' AND NEW.state_kind IN ('ready', 'failed'))
  OR (OLD.state_kind = 'ready' AND NEW.state_kind IN ('cleanup_pending', 'failed'))
  OR (OLD.state_kind = 'cleanup_pending' AND NEW.state_kind IN ('cleaned', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'workspace binding state transition is illegal');
END;

CREATE TRIGGER workspace_binding_head_is_immutable_v9
BEFORE UPDATE OF head_commit
ON workspace_bindings
WHEN OLD.state_kind <> 'creating'
  OR NEW.state_kind NOT IN ('creating', 'ready')
BEGIN
  SELECT RAISE(ABORT, 'workspace binding head commit is immutable');
END;
CREATE TABLE git_mutation_leases (
  repository_id TEXT PRIMARY KEY CHECK (length(repository_id) = 36),
  owner_id TEXT NOT NULL CHECK (length(owner_id) = 36),
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  state_kind TEXT NOT NULL CHECK (state_kind IN ('active', 'released')),
  acquired_at_ms INTEGER NOT NULL CHECK (acquired_at_ms >= 0),
  renewed_at_ms INTEGER NOT NULL CHECK (renewed_at_ms >= acquired_at_ms),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > renewed_at_ms),
  released_at_ms INTEGER CHECK (
    released_at_ms IS NULL OR released_at_ms >= renewed_at_ms
  ),
  CHECK (
    (state_kind = 'active' AND released_at_ms IS NULL)
    OR (state_kind = 'released' AND released_at_ms IS NOT NULL)
  ),
  FOREIGN KEY (repository_id) REFERENCES repositories (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX git_mutation_leases_expiry
  ON git_mutation_leases (expires_at_ms, repository_id)
  WHERE state_kind = 'active';

CREATE TRIGGER git_mutation_lease_identity_is_immutable
BEFORE UPDATE OF repository_id
ON git_mutation_leases
BEGIN
  SELECT RAISE(ABORT, 'Git mutation lease repository is immutable');
END;

CREATE TRIGGER git_mutation_lease_fence_is_monotonic
BEFORE UPDATE OF fencing_token
ON git_mutation_leases
WHEN NEW.fencing_token <= OLD.fencing_token
BEGIN
  SELECT RAISE(ABORT, 'Git mutation lease fencing token is not monotonic');
END;
CREATE TRIGGER git_mutation_lease_renewal_is_monotonic
BEFORE UPDATE OF renewed_at_ms
ON git_mutation_leases
WHEN (NEW.fencing_token = OLD.fencing_token
      AND NEW.renewed_at_ms <= OLD.renewed_at_ms)
  OR (NEW.fencing_token > OLD.fencing_token
      AND NEW.renewed_at_ms < OLD.renewed_at_ms)
BEGIN
  SELECT RAISE(ABORT, 'Git mutation lease renewal is not monotonic');
END;

CREATE TRIGGER git_mutation_lease_expiry_is_valid
BEFORE UPDATE OF acquired_at_ms, renewed_at_ms, expires_at_ms
ON git_mutation_leases
WHEN NEW.expires_at_ms <= NEW.renewed_at_ms
BEGIN
  SELECT RAISE(ABORT, 'Git mutation lease expiry is invalid');
END;
```

### 0010 attempt_transcripts

SHA-256: `5bc0fb5a3408ab90276f0ea1067eff724ea53687569eeeddc3873d6d27aaa24e`

```sql
CREATE TABLE attempt_transcript_chunks (
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) = 36),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
  payload_kind TEXT NOT NULL CHECK (length(payload_kind) > 0),
  payload_json TEXT NOT NULL CHECK (length(payload_json) > 0),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
  PRIMARY KEY (attempt_id, sequence)
) STRICT;

CREATE INDEX attempt_transcript_chunks_attempt
  ON attempt_transcript_chunks (attempt_id, sequence);

CREATE TRIGGER attempt_transcript_chunk_payload_is_stable
BEFORE INSERT ON attempt_transcript_chunks
WHEN EXISTS (
  SELECT 1 FROM attempt_transcript_chunks AS existing
  WHERE existing.attempt_id = NEW.attempt_id
    AND existing.sequence = NEW.sequence
    AND (
      existing.payload_kind <> NEW.payload_kind
      OR existing.payload_json <> NEW.payload_json
    )
)
BEGIN
  SELECT RAISE(ABORT, 'attempt transcript chunk payload is not stable for sequence');
END;
```

### 0011 attempt_checkpoints

SHA-256: `cf31dc635de38539d299172d29c8a39563734fc6da455fc211e5a3d43eacc6ac`

```sql
CREATE TABLE attempt_checkpoints (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) = 36),
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  phase TEXT NOT NULL CHECK (
    phase IN (
      'claimed',
      'sandbox_created',
      'workspace_prepared',
      'harness_started',
      'context_sent',
      'streaming',
      'finalizing'
    )
  ),
  harness_id TEXT NOT NULL CHECK (length(harness_id) > 0),
  session_id TEXT NOT NULL CHECK (length(session_id) > 0),
  sandbox_instance_id TEXT NOT NULL CHECK (length(sandbox_instance_id) > 0),
  sandbox_backend_kind TEXT NOT NULL CHECK (length(sandbox_backend_kind) > 0),
  sandbox_policy_digest TEXT NOT NULL CHECK (
    length(sandbox_policy_digest) = 64
    AND sandbox_policy_digest NOT GLOB '*[^0-9a-f]*'
  ),
  sandbox_state TEXT NOT NULL CHECK (
    sandbox_state IN ('created', 'running', 'stopped')
  ),
  context_digest TEXT NOT NULL CHECK (
    length(context_digest) = 64
    AND context_digest NOT GLOB '*[^0-9a-f]*'
  ),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0)
) STRICT;

CREATE TRIGGER attempt_checkpoint_identity_is_immutable
BEFORE UPDATE OF harness_id, session_id, sandbox_instance_id, sandbox_backend_kind,
  sandbox_policy_digest, context_digest
ON attempt_checkpoints
WHEN NEW.harness_id <> OLD.harness_id
  OR NEW.session_id <> OLD.session_id
  OR NEW.sandbox_instance_id <> OLD.sandbox_instance_id
  OR NEW.sandbox_backend_kind <> OLD.sandbox_backend_kind
  OR NEW.sandbox_policy_digest <> OLD.sandbox_policy_digest
  OR NEW.context_digest <> OLD.context_digest
BEGIN
  SELECT RAISE(ABORT, 'attempt checkpoint identity is immutable');
END;

CREATE TRIGGER attempt_checkpoint_sequence_is_monotonic
BEFORE UPDATE OF sequence ON attempt_checkpoints
WHEN NEW.sequence < OLD.sequence
BEGIN
  SELECT RAISE(ABORT, 'attempt checkpoint sequence is not monotonic');
END;
```

### 0012 gate_receipts

SHA-256: `def5debde4bc327f964b57d90e0b2201f15e575e47c73923e413e1c17d8bd7ea`

```sql
CREATE TABLE gate_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  attempt_id TEXT CHECK (attempt_id IS NULL OR length(attempt_id) = 36),
  gate_name TEXT NOT NULL CHECK (length(gate_name) > 0),
  category INTEGER NOT NULL CHECK (category >= 0),
  outcome TEXT NOT NULL CHECK (
    outcome IN (
      'passed',
      'failed',
      'timeout',
      'cancelled',
      'missing_executable',
      'error'
    )
  ),
  exit_code INTEGER,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  stdout_digest TEXT NOT NULL CHECK (
    length(stdout_digest) = 64
    AND stdout_digest NOT GLOB '*[^0-9a-f]*'
  ),
  stderr_digest TEXT NOT NULL CHECK (
    length(stderr_digest) = 64
    AND stderr_digest NOT GLOB '*[^0-9a-f]*'
  ),
  head_commit TEXT NOT NULL CHECK (
    length(head_commit) IN (40, 64)
    AND head_commit NOT GLOB '*[^0-9a-f]*'
  ),
  profile_hash TEXT NOT NULL CHECK (
    length(profile_hash) = 64
    AND profile_hash NOT GLOB '*[^0-9a-f]*'
  ),
  environment_digest TEXT NOT NULL CHECK (
    length(environment_digest) = 64
    AND environment_digest NOT GLOB '*[^0-9a-f]*'
  ),
  captured_at_ms INTEGER NOT NULL CHECK (captured_at_ms >= 0),
  sequence INTEGER NOT NULL CHECK (sequence >= 0)
) STRICT;

CREATE INDEX gate_receipts_node_sequence
  ON gate_receipts (node_id, sequence, gate_name);

CREATE INDEX gate_receipts_node_gate_sequence
  ON gate_receipts (node_id, gate_name, sequence);

CREATE TRIGGER gate_receipt_is_immutable
BEFORE UPDATE ON gate_receipts
BEGIN
  SELECT RAISE(ABORT, 'gate receipt is immutable');
END;

CREATE TRIGGER gate_receipt_is_durable
BEFORE DELETE ON gate_receipts
BEGIN
  SELECT RAISE(ABORT, 'gate receipt is durable');
END;
```

### 0013 vcs_change_bindings

SHA-256: `f88c127b757d1aa8c8726baad353eae7f02fbc909f4b97542942cbed60609ff2`

```sql
CREATE TABLE vcs_change_bindings (
  tree_id TEXT NOT NULL CHECK (length(tree_id) = 36),
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  jj_change_id TEXT NOT NULL CHECK (
    length(jj_change_id) = 64
    AND jj_change_id NOT GLOB '*[^0-9a-f]*'
  ),
  current_commit_id TEXT NOT NULL CHECK (
    length(current_commit_id) IN (40, 64)
    AND current_commit_id NOT GLOB '*[^0-9a-f]*'
  ),
  parent_change_id TEXT CHECK (
    parent_change_id IS NULL
    OR (length(parent_change_id) = 64 AND parent_change_id NOT GLOB '*[^0-9a-f]*')
  ),
  bookmark TEXT CHECK (bookmark IS NULL OR length(bookmark) > 0),
  rewrite_generation INTEGER NOT NULL DEFAULT 0 CHECK (rewrite_generation >= 0),
  last_jj_operation_id TEXT NOT NULL CHECK (
    length(last_jj_operation_id) = 64
    AND last_jj_operation_id NOT GLOB '*[^0-9a-f]*'
  ),
  last_pushed_commit_id TEXT CHECK (
    last_pushed_commit_id IS NULL
    OR (
      length(last_pushed_commit_id) IN (40, 64)
      AND last_pushed_commit_id NOT GLOB '*[^0-9a-f]*'
    )
  ),
  last_reviewed_commit_id TEXT CHECK (
    last_reviewed_commit_id IS NULL
    OR (
      length(last_reviewed_commit_id) IN (40, 64)
      AND last_reviewed_commit_id NOT GLOB '*[^0-9a-f]*'
    )
  ),
  conflict_state TEXT NOT NULL DEFAULT 'clean' CHECK (
    conflict_state IN ('clean', 'conflict', 'resolved')
  ),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
  PRIMARY KEY (tree_id, node_id)
) STRICT;

CREATE INDEX vcs_change_bindings_tree_change
  ON vcs_change_bindings (tree_id, jj_change_id);

CREATE INDEX vcs_change_bindings_tree_commit
  ON vcs_change_bindings (tree_id, current_commit_id);

CREATE TRIGGER vcs_change_binding_identity_is_immutable
BEFORE UPDATE OF tree_id, node_id ON vcs_change_bindings
WHEN NEW.tree_id <> OLD.tree_id OR NEW.node_id <> OLD.node_id
BEGIN
  SELECT RAISE(ABORT, 'vcs change binding identity is immutable');
END;

CREATE TRIGGER vcs_change_binding_rewrite_is_monotonic
BEFORE UPDATE OF rewrite_generation ON vcs_change_bindings
WHEN NEW.rewrite_generation < OLD.rewrite_generation
BEGIN
  SELECT RAISE(ABORT, 'vcs change binding rewrite generation is not monotonic');
END;

CREATE TRIGGER vcs_change_binding_is_durable
BEFORE DELETE ON vcs_change_bindings
BEGIN
  SELECT RAISE(ABORT, 'vcs change binding is durable');
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
