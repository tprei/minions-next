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
