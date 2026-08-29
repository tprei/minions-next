DROP TRIGGER node_plan_policy_definition_is_immutable;

ALTER TABLE node_plan_policies DROP COLUMN check_profile;

CREATE TRIGGER node_plan_policy_definition_is_immutable
BEFORE UPDATE OF node_id, max_attempts
ON node_plan_policies
BEGIN
  SELECT RAISE(ABORT, 'node plan policy definition is immutable');
END;
