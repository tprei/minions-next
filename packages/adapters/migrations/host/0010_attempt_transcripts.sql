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
