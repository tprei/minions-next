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
