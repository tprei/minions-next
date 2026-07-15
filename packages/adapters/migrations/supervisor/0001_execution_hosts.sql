CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE CHECK (length(name) > 0),
  checksum TEXT NOT NULL CHECK (
    length(checksum) = 64
    AND checksum NOT GLOB '*[^0-9a-f]*'
  ),
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
) STRICT;

CREATE TABLE execution_hosts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  host_kind TEXT NOT NULL CHECK (host_kind IN ('local', 'ssh', 'wsl2')),
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  state_kind TEXT NOT NULL CHECK (
    state_kind IN ('pending', 'online', 'offline', 'degraded', 'removed')
  ),
  endpoint TEXT CHECK (endpoint IS NULL OR length(endpoint) > 0),
  version INTEGER NOT NULL CHECK (version >= 0),
  registered_at_ms INTEGER NOT NULL CHECK (registered_at_ms >= 0),
  last_seen_at_ms INTEGER CHECK (
    last_seen_at_ms IS NULL OR last_seen_at_ms >= registered_at_ms
  ),
  removed_at_ms INTEGER CHECK (
    (
      state_kind = 'removed'
      AND removed_at_ms IS NOT NULL
      AND removed_at_ms >= registered_at_ms
    )
    OR (state_kind <> 'removed' AND removed_at_ms IS NULL)
  ),
  CHECK (
    (host_kind = 'local' AND endpoint IS NULL)
    OR (host_kind IN ('ssh', 'wsl2') AND endpoint IS NOT NULL)
  ),
  UNIQUE (id, host_kind)
) STRICT;

CREATE INDEX execution_hosts_state
  ON execution_hosts (state_kind, display_name, id);

CREATE TABLE ssh_profiles (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  host_id TEXT NOT NULL UNIQUE CHECK (length(host_id) = 36),
  host_kind TEXT NOT NULL CHECK (host_kind = 'ssh'),
  hostname TEXT NOT NULL CHECK (length(hostname) > 0),
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  username TEXT NOT NULL CHECK (length(username) > 0),
  credential_reference TEXT NOT NULL CHECK (length(credential_reference) > 0),
  host_key_fingerprint TEXT NOT NULL CHECK (length(host_key_fingerprint) > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  FOREIGN KEY (host_id, host_kind) REFERENCES execution_hosts (id, host_kind)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TABLE host_projection_cache (
  host_id TEXT PRIMARY KEY CHECK (length(host_id) = 36),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
  minimum_available_sequence INTEGER NOT NULL CHECK (
    minimum_available_sequence >= 0
    AND minimum_available_sequence <= last_sequence + 1
  ),
  snapshot_type TEXT NOT NULL CHECK (length(snapshot_type) > 0),
  snapshot_payload BLOB NOT NULL CHECK (length(snapshot_payload) > 0),
  refreshed_at_ms INTEGER NOT NULL CHECK (refreshed_at_ms >= 0),
  FOREIGN KEY (host_id) REFERENCES execution_hosts (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER execution_host_identity_is_immutable
BEFORE UPDATE OF id, host_kind, registered_at_ms ON execution_hosts
BEGIN
  SELECT RAISE(ABORT, 'execution host identity is immutable');
END;

CREATE TRIGGER ssh_profile_binding_is_immutable
BEFORE UPDATE OF id, host_id, host_kind, created_at_ms ON ssh_profiles
BEGIN
  SELECT RAISE(ABORT, 'SSH profile binding is immutable');
END;
