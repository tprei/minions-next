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
