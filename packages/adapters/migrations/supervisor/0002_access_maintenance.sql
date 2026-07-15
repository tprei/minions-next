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

