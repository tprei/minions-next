export { inspectRepository, RepositoryInspectionError } from "./repository-inspector.js";
export type {
  RepositoryInspection,
  RepositoryInspectionErrorCode,
} from "./repository-inspector.js";
export { createSecureIdGenerator } from "./secure-id-generator.js";
export {
  acquireLifecycleLock,
  daemonLifecyclePath,
  inspectLifecycleLock,
  LifecycleLockError,
} from "./lifecycle-lock.js";
export type {
  AcquiredLifecycleLock,
  AcquireLifecycleLockOptions,
  DaemonLifecycleRecord,
  DaemonModeName,
  LifecycleLockErrorCode,
  LifecycleLockInspection,
} from "./lifecycle-lock.js";
export { createEventCommitWaiter } from "./event-commit-waiter.js";
export type {
  EventCommitWaiter,
  EventCommitWaitOptions,
  EventCommitWaitResult,
} from "./event-commit-waiter.js";
export { SqliteCommandError } from "./sqlite/command-error.js";
export type { SqliteCommandErrorCode } from "./sqlite/command-error.js";
export { createSqliteCommandStore } from "./sqlite/command-store.js";
export type {
  ApplySqliteCommand,
  CommandCommitNotifier,
  OpenSqliteCommandStoreOptions,
  SqliteCommandStore,
  SqliteCommandTransaction,
} from "./sqlite/command.js";
export { createSqliteEventStore } from "./sqlite/event-store.js";
export type {
  OpenSqliteEventStoreOptions,
  SqliteAttentionSummary,
  SqliteEventBounds,
  SqliteEventSnapshot,
  SqliteEventStore,
  SqliteHostSummary,
  SqliteNodeSummary,
  SqliteRepositorySummary,
  SqliteStoredEvent,
  SqliteTreeSummary,
} from "./sqlite/event-store.js";
export { createSupervisorHostRegistry, HostRegistryError } from "./sqlite/host-registry.js";
export type {
  CreateSupervisorHostRegistryOptions,
  EnsureLocalHostInput,
  ExecutionHostKind,
  ExecutionHostRecord,
  ExecutionHostState,
  HostRegistryErrorCode,
  ListExecutionHostsInput,
  SupervisorHostRegistry,
} from "./sqlite/host-registry.js";
export { createRepositoryRegistry, RepositoryRegistryError } from "./sqlite/repository-registry.js";
export type {
  CreateRepositoryRegistryOptions,
  ListRepositoriesInput,
  RegisterRepositoryInput,
  RepositoryRegistration,
  RepositoryRegistry,
  RepositoryRegistryErrorCode,
} from "./sqlite/repository-registry.js";
export { openHostDatabase, openSupervisorDatabase } from "./sqlite/database.js";
export type {
  ManagedSqliteDatabase,
  OpenSqliteDatabaseOptions,
  SqliteReader,
  SqliteRow,
  SqliteTransaction,
  SqliteValue,
  SqliteWriteResult,
} from "./sqlite/database.js";
export { SqliteDatabaseError } from "./sqlite/error.js";
export type { SqliteDatabaseErrorCode } from "./sqlite/error.js";
export {
  hostMigrations,
  migrationsByDatabaseKind,
  supervisorMigrations,
} from "./sqlite/generated-migrations.js";
export type { DatabaseKind, MigrationReceipt, SqliteMigration } from "./sqlite/migration.js";
