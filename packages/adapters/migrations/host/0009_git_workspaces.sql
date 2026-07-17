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
