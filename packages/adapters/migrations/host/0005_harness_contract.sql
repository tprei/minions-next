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
