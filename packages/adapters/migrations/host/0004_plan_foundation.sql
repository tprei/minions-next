CREATE TABLE tree_budgets (
  tree_id TEXT PRIMARY KEY CHECK (length(tree_id) = 36),
  max_depth INTEGER NOT NULL CHECK (max_depth >= 2),
  max_fan_out INTEGER NOT NULL CHECK (max_fan_out > 0),
  max_nodes INTEGER NOT NULL CHECK (max_nodes >= 2),
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency > 0),
  max_attempts_per_node INTEGER NOT NULL CHECK (max_attempts_per_node > 0),
  FOREIGN KEY (tree_id) REFERENCES trees (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE node_repository_scope (
  node_id TEXT NOT NULL CHECK (length(node_id) = 36),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  repository_path TEXT NOT NULL CHECK (
    length(repository_path) BETWEEN 1 AND 512
  ),
  PRIMARY KEY (node_id, ordinal),
  FOREIGN KEY (node_id) REFERENCES nodes (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE node_plan_policies (
  node_id TEXT PRIMARY KEY CHECK (length(node_id) = 36),
  check_profile TEXT NOT NULL CHECK (
    length(check_profile) BETWEEN 1 AND 512
  ),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  FOREIGN KEY (node_id) REFERENCES nodes (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE plan_attentions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tree_id TEXT NOT NULL CHECK (length(tree_id) = 36),
  plan_revision_id TEXT CHECK (
    plan_revision_id IS NULL OR length(plan_revision_id) = 36
  ),
  kind TEXT NOT NULL CHECK (
    kind IN ('plan_required', 'plan_invalid', 'repair_required')
  ),
  message TEXT NOT NULL CHECK (length(message) > 0),
  state_kind TEXT NOT NULL CHECK (state_kind IN ('open', 'resolved')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  resolved_at_ms INTEGER CHECK (
    (state_kind = 'open' AND resolved_at_ms IS NULL)
    OR (
      state_kind = 'resolved'
      AND resolved_at_ms IS NOT NULL
      AND resolved_at_ms >= created_at_ms
    )
  ),
  FOREIGN KEY (tree_id) REFERENCES trees (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (tree_id, plan_revision_id)
    REFERENCES plan_revisions (tree_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX plan_attentions_open
  ON plan_attentions (tree_id)
  WHERE state_kind = 'open';

CREATE TRIGGER node_repository_scope_definition_is_immutable
BEFORE UPDATE OF node_id, ordinal, repository_path
ON node_repository_scope
BEGIN
  SELECT RAISE(ABORT, 'node repository scope definition is immutable');
END;

CREATE TRIGGER node_plan_policy_definition_is_immutable
BEFORE UPDATE OF node_id, check_profile, max_attempts
ON node_plan_policies
BEGIN
  SELECT RAISE(ABORT, 'node plan policy definition is immutable');
END;

CREATE TRIGGER tree_budget_definition_is_immutable
BEFORE UPDATE OF tree_id, max_depth, max_fan_out, max_nodes, max_concurrency,
  max_attempts_per_node
ON tree_budgets
BEGIN
  SELECT RAISE(ABORT, 'tree budget definition is immutable');
END;

CREATE TRIGGER plan_attention_definition_is_immutable
BEFORE UPDATE OF id, tree_id, plan_revision_id, kind, message, created_at_ms
ON plan_attentions
BEGIN
  SELECT RAISE(ABORT, 'plan attention definition is immutable');
END;
