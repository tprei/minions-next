CREATE TABLE elevation_grants (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  requested_by_session_id TEXT NOT NULL CHECK (length(requested_by_session_id) = 36),
  authorized_kinds_json TEXT NOT NULL CHECK (
    json_valid(authorized_kinds_json) AND json_type(authorized_kinds_json) = 'array'
  ),
  justification TEXT NOT NULL CHECK (length(justification) > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
  approvals_received INTEGER NOT NULL CHECK (approvals_received >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms)
) STRICT;

CREATE TABLE recovery_actions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  grant_id TEXT NOT NULL CHECK (length(grant_id) = 36),
  kind TEXT NOT NULL CHECK (kind IN (
    'signal', 'restart', 'quarantine', 'reconcile', 'debug_attach',
    'source_patch_branch', 'shadow_verify', 'candidate_activate', 'force_rollback'
  )),
  target TEXT NOT NULL CHECK (length(target) > 0),
  expected_state TEXT NOT NULL CHECK (length(expected_state) > 0),
  actor_session_id TEXT NOT NULL CHECK (length(actor_session_id) = 36),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'executed', 'failed', 'rejected', 'expired')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  executed_at_ms INTEGER CHECK (executed_at_ms IS NULL OR executed_at_ms >= created_at_ms),
  failure TEXT CHECK (failure IS NULL OR length(failure) > 0),
  CHECK (
    (state = 'pending' AND executed_at_ms IS NULL AND failure IS NULL)
    OR (state = 'executed' AND executed_at_ms IS NOT NULL AND failure IS NULL)
    OR (state = 'failed' AND executed_at_ms IS NULL AND failure IS NOT NULL)
    OR (state = 'rejected' AND executed_at_ms IS NULL AND failure IS NOT NULL)
    OR (state = 'expired' AND executed_at_ms IS NULL AND failure IS NOT NULL)
  ),
  FOREIGN KEY (grant_id) REFERENCES elevation_grants (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX recovery_actions_target_created
  ON recovery_actions (target, created_at_ms DESC, id DESC);

CREATE TRIGGER elevation_grant_identity_is_immutable
BEFORE UPDATE OF id, requested_by_session_id, authorized_kinds_json, justification, created_at_ms,
  expires_at_ms
ON elevation_grants
BEGIN
  SELECT RAISE(ABORT, 'elevation grant identity is immutable');
END;

CREATE TRIGGER elevation_grant_approvals_received_is_monotonic
BEFORE UPDATE OF approvals_received ON elevation_grants
WHEN NEW.approvals_received < OLD.approvals_received
BEGIN
  SELECT RAISE(ABORT, 'elevation grant approvals received must not decrease');
END;

CREATE TRIGGER elevation_grant_transition_is_legal
BEFORE UPDATE OF state ON elevation_grants
WHEN NOT (
  (OLD.state = 'pending' AND NEW.state IN ('approved', 'denied', 'expired'))
  OR (OLD.state = 'approved' AND NEW.state IN ('consumed', 'expired'))
)
BEGIN
  SELECT RAISE(ABORT, 'elevation grant transition is illegal');
END;

CREATE TRIGGER elevation_grant_terminal_is_immutable
BEFORE UPDATE ON elevation_grants
WHEN OLD.state IN ('denied', 'expired', 'consumed')
BEGIN
  SELECT RAISE(ABORT, 'terminal elevation grant is immutable');
END;

CREATE TRIGGER elevation_grant_is_durable
BEFORE DELETE ON elevation_grants
BEGIN
  SELECT RAISE(ABORT, 'elevation grant is durable');
END;

CREATE TRIGGER recovery_action_initial_state_is_pending
BEFORE INSERT ON recovery_actions
WHEN NEW.state <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'recovery action must start pending');
END;

CREATE TRIGGER recovery_action_identity_is_immutable
BEFORE UPDATE OF id, grant_id, kind, target, expected_state, actor_session_id, expires_at_ms,
  created_at_ms
ON recovery_actions
BEGIN
  SELECT RAISE(ABORT, 'recovery action identity is immutable');
END;

CREATE TRIGGER recovery_action_transition_is_legal
BEFORE UPDATE OF state ON recovery_actions
WHEN NOT (
  OLD.state = 'pending' AND NEW.state IN ('executed', 'failed', 'rejected', 'expired')
)
BEGIN
  SELECT RAISE(ABORT, 'recovery action transition is illegal');
END;

CREATE TRIGGER recovery_action_terminal_is_immutable
BEFORE UPDATE ON recovery_actions
WHEN OLD.state <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'terminal recovery action is immutable');
END;

CREATE TRIGGER recovery_action_is_durable
BEFORE DELETE ON recovery_actions
BEGIN
  SELECT RAISE(ABORT, 'recovery action is durable');
END;
