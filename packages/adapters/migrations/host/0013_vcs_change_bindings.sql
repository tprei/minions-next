CREATE TABLE vcs_change_bindings (
  tree_id TEXT NOT NULL CHECK (length(tree_id) = 36),
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  jj_change_id TEXT NOT NULL CHECK (
    length(jj_change_id) = 64
    AND jj_change_id NOT GLOB '*[^0-9a-f]*'
  ),
  current_commit_id TEXT NOT NULL CHECK (
    length(current_commit_id) IN (40, 64)
    AND current_commit_id NOT GLOB '*[^0-9a-f]*'
  ),
  parent_change_id TEXT CHECK (
    parent_change_id IS NULL
    OR (length(parent_change_id) = 64 AND parent_change_id NOT GLOB '*[^0-9a-f]*')
  ),
  bookmark TEXT CHECK (bookmark IS NULL OR length(bookmark) > 0),
  rewrite_generation INTEGER NOT NULL DEFAULT 0 CHECK (rewrite_generation >= 0),
  last_jj_operation_id TEXT NOT NULL CHECK (
    length(last_jj_operation_id) = 64
    AND last_jj_operation_id NOT GLOB '*[^0-9a-f]*'
  ),
  last_pushed_commit_id TEXT CHECK (
    last_pushed_commit_id IS NULL
    OR (
      length(last_pushed_commit_id) IN (40, 64)
      AND last_pushed_commit_id NOT GLOB '*[^0-9a-f]*'
    )
  ),
  last_reviewed_commit_id TEXT CHECK (
    last_reviewed_commit_id IS NULL
    OR (
      length(last_reviewed_commit_id) IN (40, 64)
      AND last_reviewed_commit_id NOT GLOB '*[^0-9a-f]*'
    )
  ),
  conflict_state TEXT NOT NULL DEFAULT 'clean' CHECK (
    conflict_state IN ('clean', 'conflict', 'resolved')
  ),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
  PRIMARY KEY (tree_id, node_id)
) STRICT;

CREATE INDEX vcs_change_bindings_tree_change
  ON vcs_change_bindings (tree_id, jj_change_id);

CREATE INDEX vcs_change_bindings_tree_commit
  ON vcs_change_bindings (tree_id, current_commit_id);

CREATE TRIGGER vcs_change_binding_identity_is_immutable
BEFORE UPDATE OF tree_id, node_id ON vcs_change_bindings
WHEN NEW.tree_id <> OLD.tree_id OR NEW.node_id <> OLD.node_id
BEGIN
  SELECT RAISE(ABORT, 'vcs change binding identity is immutable');
END;

CREATE TRIGGER vcs_change_binding_rewrite_is_monotonic
BEFORE UPDATE OF rewrite_generation ON vcs_change_bindings
WHEN NEW.rewrite_generation < OLD.rewrite_generation
BEGIN
  SELECT RAISE(ABORT, 'vcs change binding rewrite generation is not monotonic');
END;

CREATE TRIGGER vcs_change_binding_is_durable
BEFORE DELETE ON vcs_change_bindings
BEGIN
  SELECT RAISE(ABORT, 'vcs change binding is durable');
END;
