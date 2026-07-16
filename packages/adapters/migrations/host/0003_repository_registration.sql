CREATE TABLE repository_registrations (
  repository_id TEXT PRIMARY KEY REFERENCES repositories (id) ON DELETE RESTRICT CHECK (length(repository_id) = 36),
  host_id TEXT NOT NULL CHECK (length(host_id) = 36),
  canonical_root TEXT NOT NULL UNIQUE CHECK (length(canonical_root) > 0),
  canonical_remote TEXT NOT NULL CHECK (length(canonical_remote) > 0),
  default_branch TEXT NOT NULL CHECK (length(default_branch) > 0),
  base_commit TEXT NOT NULL CHECK (
    length(base_commit) IN (40, 64)
    AND base_commit NOT GLOB '*[^0-9a-f]*'
  ),
  allowed_workspace_root TEXT NOT NULL UNIQUE CHECK (length(allowed_workspace_root) > 0),
  case_sensitive INTEGER NOT NULL CHECK (case_sensitive IN (0, 1)),
  registered_at_ms INTEGER NOT NULL CHECK (registered_at_ms >= 0),
  UNIQUE (repository_id, host_id),
  FOREIGN KEY (repository_id, host_id) REFERENCES repositories (id, host_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE repository_features (
  repository_id TEXT NOT NULL REFERENCES repository_registrations (repository_id) ON DELETE RESTRICT,
  feature_kind TEXT NOT NULL CHECK (feature_kind IN ('submodule', 'lfs', 'nested_repository')),
  relative_path TEXT NOT NULL CHECK (length(relative_path) > 0),
  PRIMARY KEY (repository_id, feature_kind, relative_path)
) STRICT;

CREATE TRIGGER repository_registration_identity_immutable
BEFORE UPDATE ON repository_registrations
BEGIN
  SELECT RAISE(ABORT, 'repository registration identity is immutable');
END;
