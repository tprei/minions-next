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
