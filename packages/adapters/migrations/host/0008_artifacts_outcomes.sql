CREATE TABLE node_outcome_records (
  node_id TEXT PRIMARY KEY CHECK (length(node_id) = 36),
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN ('artifact', 'no_change', 'commit')),
  artifact_id TEXT CHECK (artifact_id IS NULL OR length(artifact_id) = 36),
  revision TEXT CHECK (
    revision IS NULL OR (
      length(revision) IN (40, 64)
      AND revision NOT GLOB '*[^0-9a-f]*'
    )
  ),
  evidence_id TEXT CHECK (evidence_id IS NULL OR length(evidence_id) = 36),
  explanation TEXT CHECK (explanation IS NULL OR length(explanation) > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  CHECK (
    (outcome_kind = 'artifact' AND artifact_id IS NOT NULL
      AND revision IS NULL AND evidence_id IS NULL AND explanation IS NULL)
    OR (outcome_kind = 'no_change' AND artifact_id IS NULL
      AND revision IS NOT NULL AND evidence_id IS NOT NULL AND explanation IS NOT NULL)
    OR (outcome_kind = 'commit' AND artifact_id IS NULL
      AND revision IS NOT NULL AND evidence_id IS NOT NULL AND explanation IS NULL)
  ),
  UNIQUE (node_id, outcome_kind),
  UNIQUE (artifact_id, node_id),
  FOREIGN KEY (node_id) REFERENCES nodes (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id, node_id) REFERENCES artifacts (id, node_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX node_outcome_records_kind_created
  ON node_outcome_records (outcome_kind, created_at_ms, node_id);

CREATE TRIGGER node_outcome_backfill_artifact_matches_legacy
BEFORE INSERT ON node_outcome_records
WHEN NEW.outcome_kind = 'artifact'
  AND NOT EXISTS (
    SELECT 1
    FROM nodes AS node
    JOIN artifacts AS artifact
      ON artifact.id = NEW.artifact_id
     AND artifact.node_id = NEW.node_id
    WHERE node.id = NEW.node_id
      AND node.state_kind = 'succeeded'
      AND artifact.tree_id = node.tree_id
      AND artifact.repository_id = node.repository_id
      AND artifact.host_id = node.host_id
      AND artifact.content_digest = node.outcome_content_hash
      AND artifact.artifact_type = node.outcome_artifact_type
      AND artifact.evidence_id = node.outcome_evidence_id
  )
BEGIN
  SELECT RAISE(ABORT, 'legacy artifact outcome is not normalized');
END;

INSERT INTO node_outcome_records (
  node_id, outcome_kind, artifact_id, revision, evidence_id, explanation, created_at_ms
)
SELECT
  node.id,
  node.outcome_kind,
  CASE WHEN node.outcome_kind = 'artifact' THEN node.outcome_artifact_id END,
  CASE WHEN node.outcome_kind = 'commit' THEN node.outcome_commit END,
  CASE WHEN node.outcome_kind IN ('commit', 'no_change') THEN node.outcome_evidence_id END,
  CASE WHEN node.outcome_kind = 'no_change' THEN node.outcome_explanation END,
  node.updated_at_ms
FROM nodes AS node
WHERE node.state_kind = 'succeeded'
  AND node.outcome_kind IN ('artifact', 'commit');

WITH RECURSIVE ancestor (
  node_id, tree_id, ancestor_id, parent_node_id, outcome_kind, outcome_commit, depth
) AS (
  SELECT
    node.id,
    node.tree_id,
    node.id,
    node.parent_node_id,
    node.outcome_kind,
    node.outcome_commit,
    0
  FROM nodes AS node
  WHERE node.state_kind = 'succeeded'
    AND node.outcome_kind = 'no_change'
  UNION ALL
  SELECT
    ancestor.node_id,
    ancestor.tree_id,
    parent.id,
    parent.parent_node_id,
    parent.outcome_kind,
    parent.outcome_commit,
    ancestor.depth + 1
  FROM ancestor
  JOIN nodes AS parent
    ON parent.id = ancestor.parent_node_id
   AND parent.tree_id = ancestor.tree_id
)
INSERT INTO node_outcome_records (
  node_id, outcome_kind, artifact_id, revision, evidence_id, explanation, created_at_ms
)
SELECT
  node.id,
  'no_change',
  NULL,
  COALESCE(
    (
      SELECT ancestor.outcome_commit
      FROM ancestor
      WHERE ancestor.node_id = node.id
        AND ancestor.outcome_kind = 'commit'
      ORDER BY ancestor.depth, ancestor.ancestor_id
      LIMIT 1
    ),
    tree.base_commit
  ),
  node.outcome_evidence_id,
  node.outcome_explanation,
  node.updated_at_ms
FROM nodes AS node
JOIN trees AS tree ON tree.id = node.tree_id
WHERE node.state_kind = 'succeeded'
  AND node.outcome_kind = 'no_change';
DROP TRIGGER node_outcome_backfill_artifact_matches_legacy;

CREATE TRIGGER content_blob_is_durable
BEFORE DELETE ON content_blobs
BEGIN
  SELECT RAISE(ABORT, 'content blob is durable');
END;

CREATE TRIGGER artifact_is_durable
BEFORE DELETE ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifact is durable');
END;

CREATE TRIGGER node_outcome_is_immutable
BEFORE UPDATE ON node_outcome_records
BEGIN
  SELECT RAISE(ABORT, 'node outcome is immutable');
END;

CREATE TRIGGER node_outcome_is_durable
BEFORE DELETE ON node_outcome_records
BEGIN
  SELECT RAISE(ABORT, 'node outcome is durable');
END;

CREATE TRIGGER node_outcome_record_requires_active_node
BEFORE INSERT ON node_outcome_records
WHEN NOT EXISTS (
  SELECT 1
  FROM nodes AS node
  WHERE node.id = NEW.node_id
    AND node.state_kind = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'node outcome requires an active node');
END;

CREATE TRIGGER node_outcome_record_artifact_matches_node
BEFORE INSERT ON node_outcome_records
WHEN NEW.outcome_kind = 'artifact'
  AND NOT EXISTS (
    SELECT 1
    FROM nodes AS node
    JOIN artifacts AS artifact
      ON artifact.id = NEW.artifact_id
     AND artifact.node_id = NEW.node_id
    WHERE node.id = NEW.node_id
      AND node.state_kind = 'active'
      AND node.output_kind = 'artifact'
      AND node.output_artifact_id = NEW.artifact_id
      AND artifact.artifact_type = node.output_artifact_type
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact outcome does not match active node ownership');
END;

CREATE TRIGGER node_outcome_record_commit_matches_node
BEFORE INSERT ON node_outcome_records
WHEN NEW.outcome_kind = 'commit'
  AND NOT EXISTS (
    SELECT 1
    FROM nodes AS node
    WHERE node.id = NEW.node_id
      AND node.state_kind = 'active'
      AND node.output_kind = 'implementation'
  )
BEGIN
  SELECT RAISE(ABORT, 'commit outcome requires an active implementation node');
END;

CREATE TRIGGER node_outcome_record_no_change_matches_node
BEFORE INSERT ON node_outcome_records
WHEN NEW.outcome_kind = 'no_change'
  AND NOT EXISTS (
    SELECT 1
    FROM nodes AS node
    WHERE node.id = NEW.node_id
      AND node.state_kind = 'active'
      AND node.output_kind = 'implementation'
  )
BEGIN
  SELECT RAISE(ABORT, 'no-change outcome requires an active implementation node');
END;

CREATE TRIGGER node_outcome_record_no_change_ancestry_is_complete
BEFORE INSERT ON node_outcome_records
WHEN NEW.outcome_kind = 'no_change'
BEGIN
  WITH RECURSIVE ancestor (
    id, tree_id, root_node_id, parent_node_id, state_kind, outcome_kind, depth, missing
  ) AS (
    SELECT
      parent.id,
      node.tree_id,
      tree.root_node_id,
      parent.parent_node_id,
      parent.state_kind,
      parent.outcome_kind,
      0,
      CASE WHEN parent.id IS NULL THEN 1 ELSE 0 END
    FROM nodes AS node
    JOIN trees AS tree ON tree.id = node.tree_id
    LEFT JOIN nodes AS parent
      ON parent.id = node.parent_node_id
     AND parent.tree_id = node.tree_id
    WHERE node.id = NEW.node_id
      AND node.parent_node_id IS NOT NULL
    UNION ALL
    SELECT
      parent.id,
      ancestor.tree_id,
      ancestor.root_node_id,
      parent.parent_node_id,
      parent.state_kind,
      parent.outcome_kind,
      ancestor.depth + 1,
      CASE WHEN parent.id IS NULL THEN 1 ELSE 0 END
    FROM ancestor
    LEFT JOIN nodes AS parent
      ON parent.id = ancestor.parent_node_id
     AND parent.tree_id = ancestor.tree_id
    WHERE ancestor.id IS NOT NULL
      AND NOT (
        (ancestor.outcome_kind IS NOT NULL
         AND ancestor.outcome_kind IN ('commit', 'no_change'))
        OR (
          ancestor.id = ancestor.root_node_id
          AND ancestor.state_kind IN ('planned', 'succeeded')
        )
      )
  )
  SELECT RAISE(ABORT, 'no-change parent chain is incomplete')
  WHERE EXISTS (
    SELECT 1
    FROM ancestor
    LEFT JOIN node_outcome_records AS outcome ON outcome.node_id = ancestor.id
    WHERE ancestor.missing = 1
       OR NOT (
         (ancestor.id = ancestor.root_node_id AND ancestor.state_kind = 'planned')
         OR (
           ancestor.state_kind = 'succeeded'
           AND outcome.node_id IS NOT NULL
           AND outcome.outcome_kind = ancestor.outcome_kind
         )
       )
  );
END;

CREATE TRIGGER node_outcome_record_no_change_revision_is_inherited
BEFORE INSERT ON node_outcome_records
WHEN NEW.outcome_kind = 'no_change'
BEGIN
  WITH RECURSIVE ancestor (
    node_id, root_node_id, tree_id, ancestor_id, parent_node_id,
    state_kind, outcome_kind, outcome_commit, depth
  ) AS (
    SELECT
      node.id,
      tree.root_node_id,
      node.tree_id,
      node.id,
      node.parent_node_id,
      node.state_kind,
      node.outcome_kind,
      node.outcome_commit,
      0
    FROM nodes AS node
    JOIN trees AS tree ON tree.id = node.tree_id
    WHERE node.id = NEW.node_id
    UNION ALL
    SELECT
      ancestor.node_id,
      ancestor.root_node_id,
      ancestor.tree_id,
      parent.id,
      parent.parent_node_id,
      parent.state_kind,
      parent.outcome_kind,
      parent.outcome_commit,
      ancestor.depth + 1
    FROM ancestor
    JOIN nodes AS parent
      ON parent.id = ancestor.parent_node_id
     AND parent.tree_id = ancestor.tree_id
    WHERE ancestor.parent_node_id IS NOT NULL
      AND NOT (
        (ancestor.outcome_kind IS NOT NULL
         AND ancestor.outcome_kind IN ('commit', 'no_change'))
        OR (
          ancestor.ancestor_id = ancestor.root_node_id
          AND ancestor.state_kind IN ('planned', 'succeeded')
        )
      )
  )
  SELECT RAISE(ABORT, 'no-change revision does not match inherited revision')
  WHERE NEW.revision <> COALESCE(
    (
      SELECT CASE
        WHEN ancestor.outcome_kind = 'commit' THEN ancestor.outcome_commit
        WHEN ancestor.outcome_kind = 'no_change' THEN outcome.revision
      END
      FROM ancestor
      LEFT JOIN node_outcome_records AS outcome ON outcome.node_id = ancestor.ancestor_id
      WHERE ancestor.state_kind = 'succeeded'
        AND ancestor.outcome_kind IN ('commit', 'no_change')
        AND outcome.node_id IS NOT NULL
      ORDER BY ancestor.depth, ancestor.ancestor_id
      LIMIT 1
    ),
    (
      SELECT tree.base_commit
      FROM nodes AS node
      JOIN trees AS tree ON tree.id = node.tree_id
      WHERE node.id = NEW.node_id
    )
  );
END;

CREATE TRIGGER node_succeeded_insert_is_forbidden
BEFORE INSERT ON nodes
WHEN NEW.state_kind = 'succeeded'
BEGIN
  SELECT RAISE(ABORT, 'succeeded nodes require normalized outcomes');
END;

CREATE TRIGGER node_succeeded_state_is_terminal
BEFORE UPDATE OF state_kind ON nodes
WHEN OLD.state_kind = 'succeeded'
  AND NEW.state_kind <> 'succeeded'
BEGIN
  SELECT RAISE(ABORT, 'succeeded node state is terminal');
END;

CREATE TRIGGER node_succeeded_outcome_requires_record
BEFORE UPDATE ON nodes
WHEN NEW.state_kind = 'succeeded'
  AND (
    SELECT COUNT(*)
    FROM node_outcome_records AS outcome
    WHERE outcome.node_id = NEW.id
  ) <> 1
BEGIN
  SELECT RAISE(ABORT, 'succeeded node requires exactly one normalized outcome');
END;

CREATE TRIGGER node_succeeded_artifact_outcome_matches
BEFORE UPDATE ON nodes
WHEN NEW.state_kind = 'succeeded'
  AND NEW.outcome_kind = 'artifact'
  AND NOT EXISTS (
    SELECT 1
    FROM node_outcome_records AS outcome
    JOIN artifacts AS artifact
      ON artifact.id = outcome.artifact_id
     AND artifact.node_id = outcome.node_id
    WHERE outcome.node_id = NEW.id
      AND outcome.outcome_kind = 'artifact'
      AND outcome.artifact_id = NEW.outcome_artifact_id
      AND artifact.artifact_type = NEW.outcome_artifact_type
      AND artifact.content_digest = NEW.outcome_content_hash
      AND artifact.evidence_id = NEW.outcome_evidence_id
  )
BEGIN
  SELECT RAISE(ABORT, 'succeeded artifact outcome is not normalized');
END;

CREATE TRIGGER node_succeeded_commit_outcome_matches
BEFORE UPDATE ON nodes
WHEN NEW.state_kind = 'succeeded'
  AND NEW.outcome_kind = 'commit'
  AND NOT EXISTS (
    SELECT 1
    FROM node_outcome_records AS outcome
    WHERE outcome.node_id = NEW.id
      AND outcome.outcome_kind = 'commit'
      AND outcome.artifact_id IS NULL
      AND outcome.revision = NEW.outcome_commit
      AND outcome.evidence_id = NEW.outcome_evidence_id
      AND outcome.explanation IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'succeeded commit outcome is not normalized');
END;

CREATE TRIGGER node_succeeded_no_change_outcome_matches
BEFORE UPDATE ON nodes
WHEN NEW.state_kind = 'succeeded'
  AND NEW.outcome_kind = 'no_change'
BEGIN
  WITH RECURSIVE ancestor (
    id, tree_id, root_node_id, parent_node_id, state_kind, outcome_kind, outcome_commit, depth, missing
  ) AS (
    SELECT
      parent.id,
      node.tree_id,
      tree.root_node_id,
      parent.parent_node_id,
      parent.state_kind,
      parent.outcome_kind,
      parent.outcome_commit,
      0,
      CASE WHEN parent.id IS NULL THEN 1 ELSE 0 END
    FROM nodes AS node
    JOIN trees AS tree ON tree.id = node.tree_id
    LEFT JOIN nodes AS parent
      ON parent.id = node.parent_node_id
     AND parent.tree_id = node.tree_id
    WHERE node.id = NEW.id
      AND node.parent_node_id IS NOT NULL
    UNION ALL
    SELECT
      parent.id,
      ancestor.tree_id,
      ancestor.root_node_id,
      parent.parent_node_id,
      parent.state_kind,
      parent.outcome_kind,
      parent.outcome_commit,
      ancestor.depth + 1,
      CASE WHEN parent.id IS NULL THEN 1 ELSE 0 END
    FROM ancestor
    LEFT JOIN nodes AS parent
      ON parent.id = ancestor.parent_node_id
     AND parent.tree_id = ancestor.tree_id
    WHERE ancestor.id IS NOT NULL
      AND NOT (
        (ancestor.outcome_kind IS NOT NULL
         AND ancestor.outcome_kind IN ('commit', 'no_change'))
        OR (
          ancestor.id = ancestor.root_node_id
          AND ancestor.state_kind IN ('planned', 'succeeded')
        )
      )
  )
  SELECT RAISE(ABORT, 'succeeded no-change outcome is not normalized')
  WHERE EXISTS (
    SELECT 1
    FROM ancestor
    LEFT JOIN node_outcome_records AS parent_outcome
      ON parent_outcome.node_id = ancestor.id
    WHERE ancestor.missing = 1
       OR NOT (
         (ancestor.id = ancestor.root_node_id AND ancestor.state_kind = 'planned')
         OR (
           ancestor.state_kind = 'succeeded'
           AND parent_outcome.node_id IS NOT NULL
           AND parent_outcome.outcome_kind = ancestor.outcome_kind
         )
       )
  )
  OR NOT EXISTS (
    SELECT 1
    FROM node_outcome_records AS outcome
    WHERE outcome.node_id = NEW.id
      AND outcome.outcome_kind = 'no_change'
      AND outcome.artifact_id IS NULL
      AND outcome.revision = COALESCE(
        (
          SELECT CASE
            WHEN ancestor.outcome_kind = 'commit' THEN ancestor.outcome_commit
            WHEN ancestor.outcome_kind = 'no_change' THEN parent_outcome.revision
          END
          FROM ancestor
          LEFT JOIN node_outcome_records AS parent_outcome
            ON parent_outcome.node_id = ancestor.id
          WHERE ancestor.state_kind = 'succeeded'
            AND ancestor.outcome_kind IN ('commit', 'no_change')
            AND parent_outcome.node_id IS NOT NULL
          ORDER BY ancestor.depth, ancestor.id
          LIMIT 1
        ),
        (
          SELECT tree.base_commit
          FROM nodes AS node
          JOIN trees AS tree ON tree.id = node.tree_id
          WHERE node.id = NEW.id
        )
      )
      AND outcome.evidence_id = NEW.outcome_evidence_id
      AND outcome.explanation = NEW.outcome_explanation
  );
END;
