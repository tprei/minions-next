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
