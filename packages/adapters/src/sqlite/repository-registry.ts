import { create, fromBinary, toBinary, type MessageShape } from "@bufbuild/protobuf";
import type { Timestamp as ProtoTimestamp } from "@bufbuild/protobuf/wkt";
import {
  RegisterRepositoryRequestSchema,
  RegisterRepositoryResponseSchema,
  ProjectionChangeSchema,
  RegisteredRepositorySchema,
  RepositorySummarySchema,
  findUnknownField,
} from "@minions/contracts";
import type { RegisterRepositoryRequest } from "@minions/contracts";
import {
  actorSessionId,
  commandId,
  gitSha,
  hostId,
  nonEmptyText,
  repositoryId,
  repositoryRoot,
  timestampFromEpochMilliseconds,
} from "@minions/core";
import type {
  ActorSessionId,
  CommandId,
  GitSha,
  HostId,
  NonEmptyText,
  RepositoryId,
  RepositoryRoot,
  Timestamp,
} from "@minions/core";
import { isAbsolute, normalize as normalizePath, sep as pathSeparator } from "node:path";

import {
  canonicalizeRemote,
  isValidBranchName,
  type RepositoryInspection,
} from "../repository-inspector.js";
import type { ManagedSqliteDatabase, SqliteReader, SqliteRow } from "./database.js";
import { SqliteCommandError } from "./command-error.js";
import type { SqliteCommandStore, SqliteCommandTransaction } from "./command.js";

export type RepositoryRegistration = Readonly<{
  id: RepositoryId;
  hostId: HostId;
  canonicalRoot: RepositoryRoot;
  canonicalRemote: NonEmptyText;
  defaultBranch: NonEmptyText;
  baseCommit: GitSha;
  caseSensitive: boolean;
  submodulePaths: readonly string[];
  lfsPaths: readonly string[];
  nestedRepositoryPaths: readonly string[];
  allowedWorkspaceRoot: RepositoryRoot;
  registeredAt: Timestamp;
}>;

export type RegisterRepositoryInput = Readonly<{
  request: RegisterRepositoryRequest;
  inspection: RepositoryInspection;
  allowedWorkspaceRoot: string;
  registeredAt: Timestamp;
}>;

export type ListRepositoriesInput = Readonly<{
  afterId: RepositoryId | undefined;
  limit: number;
}>;

export type CreateRepositoryRegistryOptions = Readonly<{
  database: ManagedSqliteDatabase;
  commandStore: SqliteCommandStore;
  hostId: HostId;
}>;

export interface RepositoryRegistry {
  register(input: RegisterRepositoryInput): Promise<RepositoryRegistration>;
  get(id: RepositoryId): RepositoryRegistration;
  list(input: ListRepositoriesInput): readonly RepositoryRegistration[];
}

export type RepositoryRegistryErrorCode =
  "not_found" | "overlap" | "identity_conflict" | "facts_changed" | "corrupt" | "invalid_input";

export class RepositoryRegistryError extends Error {
  readonly code: RepositoryRegistryErrorCode;

  constructor(code: RepositoryRegistryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepositoryRegistryError";
    this.code = code;
  }
}

type RegisterSnapshot = Readonly<{
  requestBytes: Uint8Array;
  commandId: CommandId;
  actorSessionId: ActorSessionId;
  repositoryId: RepositoryId;
  canonicalRoot: RepositoryRoot;
  canonicalRemote: NonEmptyText;
  defaultBranch: NonEmptyText;
  baseCommit: GitSha;
  caseSensitive: boolean;
  submodulePaths: readonly NonEmptyText[];
  lfsPaths: readonly NonEmptyText[];
  nestedRepositoryPaths: readonly NonEmptyText[];
  allowedWorkspaceRoot: RepositoryRoot;
  registeredAt: Timestamp;
}>;

export function createRepositoryRegistry(
  options: CreateRepositoryRegistryOptions,
): RepositoryRegistry {
  const trustedHostId = parseHostId(options.hostId, "host ID");
  return new DefaultRepositoryRegistry(options.database, options.commandStore, trustedHostId);
}

class DefaultRepositoryRegistry implements RepositoryRegistry {
  readonly #database: ManagedSqliteDatabase;
  readonly #commandStore: SqliteCommandStore;
  readonly #hostId: HostId;

  constructor(
    database: ManagedSqliteDatabase,
    commandStore: SqliteCommandStore,
    hostIdValue: HostId,
  ) {
    this.#database = database;
    this.#commandStore = commandStore;
    this.#hostId = hostIdValue;
  }

  async register(input: RegisterRepositoryInput): Promise<RepositoryRegistration> {
    const snapshot = snapshotRegisterInput(input);
    const commandRequest = {
      id: snapshot.commandId,
      actorSessionId: snapshot.actorSessionId,
      aggregateKind: "repository" as const,
      aggregateId: snapshot.repositoryId,
      expectedVersion: null,
      command: {
        typeName: nonEmptyText(RegisterRepositoryRequestSchema.typeName, "command type name"),
        bytes: snapshot.requestBytes,
      },
    };

    try {
      const receipt = await this.#commandStore.execute(commandRequest, (transaction) =>
        applyRegistration(transaction, snapshot, this.#hostId),
      );
      if (receipt.result.typeName !== RegisterRepositoryResponseSchema.typeName) {
        throw new RepositoryRegistryError(
          "corrupt",
          "registered repository command result has an unexpected type",
        );
      }
      const registration = decodeRegistrationResult(receipt.result.bytes);
      if (registration.id !== snapshot.repositoryId || registration.hostId !== this.#hostId) {
        throw new RepositoryRegistryError(
          "corrupt",
          "registered repository command result identity does not match the request",
        );
      }
      assertRegistrationMatchesSnapshot(registration, snapshot);
      return registration;
    } catch (error) {
      throw normalizeRegisterError(error);
    }
  }

  get(id: RepositoryId): RepositoryRegistration {
    const repository = parseRepositoryId(id, "repository ID");
    return this.#database.read((reader) => {
      const row = readRegistrationRow(reader, repository);
      if (row === undefined) {
        throw new RepositoryRegistryError("not_found", "repository registration does not exist");
      }
      return toRegistration(reader, row);
    });
  }

  list(input: ListRepositoriesInput): readonly RepositoryRegistration[] {
    const afterId =
      input.afterId === undefined
        ? undefined
        : parseRepositoryId(input.afterId, "cursor repository ID");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 101) {
      throw new RepositoryRegistryError(
        "invalid_input",
        "repository list limit must be between 1 and 101",
      );
    }
    return this.#database.read((reader) => {
      const rows =
        afterId === undefined
          ? reader.all(
              `SELECT rr.repository_id, rr.host_id, rr.canonical_root, rr.canonical_remote,
                      rr.default_branch, rr.base_commit, rr.allowed_workspace_root,
                      rr.case_sensitive, rr.registered_at_ms,
                      r.id AS projection_id, r.host_id AS projection_host_id,
                      r.root_path AS projection_root_path, r.version AS projection_version,
                      r.registered_at_ms AS projection_registered_at_ms,
                      r.archived_at_ms AS projection_archived_at_ms
                 FROM repository_registrations AS rr
                 LEFT JOIN repositories AS r ON r.id = rr.repository_id
                ORDER BY rr.repository_id
                LIMIT ?`,
              [input.limit],
            )
          : reader.all(
              `SELECT rr.repository_id, rr.host_id, rr.canonical_root, rr.canonical_remote,
                      rr.default_branch, rr.base_commit, rr.allowed_workspace_root,
                      rr.case_sensitive, rr.registered_at_ms,
                      r.id AS projection_id, r.host_id AS projection_host_id,
                      r.root_path AS projection_root_path, r.version AS projection_version,
                      r.registered_at_ms AS projection_registered_at_ms,
                      r.archived_at_ms AS projection_archived_at_ms
                 FROM repository_registrations AS rr
                 LEFT JOIN repositories AS r ON r.id = rr.repository_id
                WHERE rr.repository_id > ?
                ORDER BY rr.repository_id
                LIMIT ?`,
              [afterId, input.limit],
            );
      return Object.freeze(rows.map((row) => toRegistration(reader, row)));
    });
  }
}

function applyRegistration(
  transaction: SqliteCommandTransaction,
  input: RegisterSnapshot,
  trustedHostId: HostId,
): Readonly<{
  event: Readonly<{ typeName: NonEmptyText; bytes: Uint8Array }>;
  result: Readonly<{ typeName: NonEmptyText; bytes: Uint8Array }>;
  externalOperations: readonly [];
}> {
  const candidate = snapshotToRegistration(input, trustedHostId);
  if (
    pathsOverlap(candidate.canonicalRoot, candidate.allowedWorkspaceRoot, candidate.caseSensitive)
  ) {
    throw new RepositoryRegistryError(
      "overlap",
      "repository root overlaps its allowed workspace root",
    );
  }

  const existing = readRegistrationRows(transaction);
  for (const registration of existing) {
    if (registration.id === candidate.id) {
      throw new RepositoryRegistryError(
        "identity_conflict",
        "repository registration identity is already registered",
      );
    }
    const caseSensitive = candidate.caseSensitive && registration.caseSensitive;
    if (
      pathsOverlap(candidate.canonicalRoot, registration.canonicalRoot, caseSensitive) ||
      pathsOverlap(candidate.canonicalRoot, registration.allowedWorkspaceRoot, caseSensitive) ||
      pathsOverlap(candidate.allowedWorkspaceRoot, registration.canonicalRoot, caseSensitive) ||
      pathsOverlap(candidate.allowedWorkspaceRoot, registration.allowedWorkspaceRoot, caseSensitive)
    ) {
      throw new RepositoryRegistryError(
        "overlap",
        "repository root or workspace overlaps an existing registration",
      );
    }
  }

  transaction.run(
    `INSERT INTO repositories (
       id, host_id, root_path, version, registered_at_ms, archived_at_ms
     ) VALUES (?, ?, ?, 0, ?, NULL)`,
    [candidate.id, candidate.hostId, candidate.canonicalRoot, candidate.registeredAt],
  );
  transaction.run(
    `INSERT INTO repository_registrations (
       repository_id, host_id, canonical_root, canonical_remote, default_branch,
       base_commit, allowed_workspace_root, case_sensitive, registered_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      candidate.id,
      candidate.hostId,
      candidate.canonicalRoot,
      candidate.canonicalRemote,
      candidate.defaultBranch,
      candidate.baseCommit,
      candidate.allowedWorkspaceRoot,
      candidate.caseSensitive ? 1 : 0,
      candidate.registeredAt,
    ],
  );
  insertFeatures(transaction, candidate.id, "submodule", candidate.submodulePaths);
  insertFeatures(transaction, candidate.id, "lfs", candidate.lfsPaths);
  insertFeatures(transaction, candidate.id, "nested_repository", candidate.nestedRepositoryPaths);

  const event = create(ProjectionChangeSchema, {
    change: {
      case: "repositoryUpserted",
      value: create(RepositorySummarySchema, {
        id: candidate.id,
        hostId: candidate.hostId,
        version: 0n,
        archived: false,
      }),
    },
  });
  const response = create(RegisterRepositoryResponseSchema, {
    repository: registrationMessage(candidate),
  });
  return Object.freeze({
    event: Object.freeze({
      typeName: nonEmptyText(ProjectionChangeSchema.typeName, "event type name"),
      bytes: toBinary(ProjectionChangeSchema, event),
    }),
    result: Object.freeze({
      typeName: nonEmptyText(RegisterRepositoryResponseSchema.typeName, "result type name"),
      bytes: toBinary(RegisterRepositoryResponseSchema, response),
    }),
    externalOperations: [],
  });
}

function insertFeatures(
  transaction: SqliteCommandTransaction,
  repository: RepositoryId,
  kind: "submodule" | "lfs" | "nested_repository",
  paths: readonly string[],
): void {
  for (const path of paths) {
    transaction.run(
      `INSERT INTO repository_features (repository_id, feature_kind, relative_path)
       VALUES (?, ?, ?)`,
      [repository, kind, path],
    );
  }
}

function snapshotRegisterInput(input: RegisterRepositoryInput): RegisterSnapshot {
  try {
    const request = snapshotRequest(input.request);
    const command = commandId(request.commandId);
    const actor = actorSessionId(request.actorSessionId);
    const repository = repositoryId(request.repositoryId);
    const inspection = snapshotInspection(input.inspection);
    const allowedWorkspaceRoot = repositoryRoot(input.allowedWorkspaceRoot);
    const registeredAt = timestampFromEpochMilliseconds(input.registeredAt);
    validateTextLength(inspection.canonicalRoot, 4096, "canonical root");
    validateTextLength(inspection.canonicalRemote, 2048, "canonical remote");
    validateTextLength(inspection.defaultBranch, 255, "default branch");
    validateTextLength(allowedWorkspaceRoot, 4096, "allowed workspace root");
    validateCanonicalAbsolutePath(inspection.canonicalRoot, "canonical root");
    validateCanonicalAbsolutePath(allowedWorkspaceRoot, "allowed workspace root");
    validateCanonicalFacts(
      inspection.canonicalRoot,
      inspection.canonicalRemote,
      inspection.defaultBranch,
      allowedWorkspaceRoot,
    );
    return Object.freeze({
      requestBytes: new Uint8Array(request.bytes),
      commandId: command,
      actorSessionId: actor,
      repositoryId: repository,
      canonicalRoot: inspection.canonicalRoot,
      canonicalRemote: inspection.canonicalRemote,
      defaultBranch: inspection.defaultBranch,
      baseCommit: inspection.baseCommit,
      caseSensitive: inspection.caseSensitive,
      submodulePaths: inspection.submodulePaths,
      lfsPaths: inspection.lfsPaths,
      nestedRepositoryPaths: inspection.nestedRepositoryPaths,
      allowedWorkspaceRoot,
      registeredAt,
    });
  } catch (error) {
    if (error instanceof RepositoryRegistryError) {
      throw error;
    }
    throw new RepositoryRegistryError("invalid_input", "repository registration input is invalid", {
      cause: error,
    });
  }
}
function validateCanonicalFacts(
  canonicalRoot: string,
  canonicalRemote: string,
  defaultBranch: string,
  allowedWorkspaceRoot: string,
): void {
  validateCanonicalAbsolutePath(canonicalRoot, "canonical root");
  validateCanonicalAbsolutePath(allowedWorkspaceRoot, "allowed workspace root");
  if (canonicalizeRemote(canonicalRemote) !== canonicalRemote) {
    throw new TypeError("canonical remote is not normalized");
  }
  if (!isValidBranchName(defaultBranch)) {
    throw new TypeError("default branch is invalid");
  }
}

function assertRegistrationMatchesSnapshot(
  registration: RepositoryRegistration,
  snapshot: RegisterSnapshot,
): void {
  if (
    registration.canonicalRoot !== snapshot.canonicalRoot ||
    registration.canonicalRemote !== snapshot.canonicalRemote ||
    registration.defaultBranch !== snapshot.defaultBranch ||
    registration.baseCommit !== snapshot.baseCommit ||
    registration.allowedWorkspaceRoot !== snapshot.allowedWorkspaceRoot ||
    registration.caseSensitive !== snapshot.caseSensitive ||
    !sameFeaturePaths(registration.submodulePaths, snapshot.submodulePaths) ||
    !sameFeaturePaths(registration.lfsPaths, snapshot.lfsPaths) ||
    !sameFeaturePaths(registration.nestedRepositoryPaths, snapshot.nestedRepositoryPaths)
  ) {
    throw new RepositoryRegistryError(
      "facts_changed",
      "repository facts changed after registration",
    );
  }
}

function sameFeaturePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function snapshotRequest(input: RegisterRepositoryRequest): Readonly<{
  message: RegisterRepositoryRequest;
  bytes: Uint8Array;
  commandId: string;
  actorSessionId: string;
  repositoryId: string;
}> {
  try {
    const bytes = toBinary(RegisterRepositoryRequestSchema, input);
    const message = fromBinary(RegisterRepositoryRequestSchema, bytes);
    const unknownField = findUnknownField(RegisterRepositoryRequestSchema, message);
    if (unknownField !== undefined) {
      throw new TypeError("register repository request contains an unknown field");
    }
    if (
      typeof message.commandId !== "string" ||
      typeof message.actorSessionId !== "string" ||
      typeof message.repositoryId !== "string" ||
      typeof message.rootPath !== "string"
    ) {
      throw new TypeError("register repository request fields are malformed");
    }
    repositoryRoot(message.rootPath);
    validateTextLength(message.rootPath, 4096, "root path");
    return Object.freeze({
      message,
      bytes,
      commandId: message.commandId,
      actorSessionId: message.actorSessionId,
      repositoryId: message.repositoryId,
    });
  } catch (error) {
    throw new RepositoryRegistryError("invalid_input", "register repository request is invalid", {
      cause: error,
    });
  }
}

function snapshotInspection(input: RepositoryInspection): Readonly<{
  canonicalRoot: RepositoryRoot;
  canonicalRemote: NonEmptyText;
  defaultBranch: NonEmptyText;
  baseCommit: GitSha;
  caseSensitive: boolean;
  submodulePaths: readonly NonEmptyText[];
  lfsPaths: readonly NonEmptyText[];
  nestedRepositoryPaths: readonly NonEmptyText[];
}> {
  const canonicalRoot = repositoryRoot(input.canonicalRoot);
  const canonicalRemote = nonEmptyText(input.canonicalRemote, "canonical remote");
  const defaultBranch = nonEmptyText(input.defaultBranch, "default branch");
  const baseCommit = gitSha(input.baseCommit);
  if (typeof input.caseSensitive !== "boolean") {
    throw new TypeError("case sensitivity must be boolean");
  }
  if (typeof input.dirty !== "boolean") {
    throw new TypeError("dirty state must be boolean");
  }
  return Object.freeze({
    canonicalRoot,
    canonicalRemote,
    defaultBranch,
    baseCommit,
    caseSensitive: input.caseSensitive,
    submodulePaths: snapshotFeaturePaths(input.submodulePaths, "submodule"),
    lfsPaths: snapshotFeaturePaths(input.lfsPaths, "LFS"),
    nestedRepositoryPaths: snapshotFeaturePaths(input.nestedRepositoryPaths, "nested repository"),
  });
}

function snapshotFeaturePaths(input: unknown, fieldName: string): readonly NonEmptyText[] {
  if (!Array.isArray(input)) {
    throw new TypeError(`${fieldName} paths must be an array`);
  }
  const values: unknown[] = input;
  const paths = values.map((path, index) => {
    if (typeof path !== "string") {
      throw new TypeError(`${fieldName} path ${String(index)} must be a string`);
    }
    const value = nonEmptyText(path, `${fieldName} path ${String(index)}`);
    validateTextLength(value, 4096, `${fieldName} path`);
    validateRelativeFeaturePath(value, `${fieldName} path`);
    return value;
  });
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) {
      throw new TypeError(`${fieldName} paths must not contain duplicates`);
    }
  }
  return Object.freeze(sorted);
}

function validateTextLength(value: string, maximum: number, fieldName: string): void {
  if (value.length > maximum) {
    throw new TypeError(`${fieldName} exceeds its maximum length`);
  }
}

function validateCanonicalAbsolutePath(value: string, fieldName: string): void {
  if (!isAbsolute(value) || normalizePath(value) !== value) {
    throw new TypeError(`${fieldName} must be a normalized absolute path`);
  }
}

function validateRelativeFeaturePath(value: string, fieldName: string): void {
  if (
    isAbsolute(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith(`..${pathSeparator}`) ||
    normalizePath(value) !== value
  ) {
    throw new TypeError(`${fieldName} must stay within the repository`);
  }
}

function snapshotToRegistration(
  input: RegisterSnapshot,
  trustedHostId: HostId,
): RepositoryRegistration {
  return Object.freeze({
    id: input.repositoryId,
    hostId: trustedHostId,
    canonicalRoot: input.canonicalRoot,
    canonicalRemote: input.canonicalRemote,
    defaultBranch: input.defaultBranch,
    baseCommit: input.baseCommit,
    caseSensitive: input.caseSensitive,
    submodulePaths: Object.freeze([...input.submodulePaths]),
    lfsPaths: Object.freeze([...input.lfsPaths]),
    nestedRepositoryPaths: Object.freeze([...input.nestedRepositoryPaths]),
    allowedWorkspaceRoot: input.allowedWorkspaceRoot,
    registeredAt: input.registeredAt,
  });
}

function registrationMessage(registration: RepositoryRegistration) {
  return create(RegisteredRepositorySchema, {
    id: registration.id,
    hostId: registration.hostId,
    canonicalRoot: registration.canonicalRoot,
    canonicalRemote: registration.canonicalRemote,
    defaultBranch: registration.defaultBranch,
    baseCommit: registration.baseCommit,
    allowedWorkspaceRoot: registration.allowedWorkspaceRoot,
    caseSensitive: registration.caseSensitive,
    submodulePaths: [...registration.submodulePaths],
    lfsPaths: [...registration.lfsPaths],
    nestedRepositoryPaths: [...registration.nestedRepositoryPaths],
    registeredAt: timestampMessage(registration.registeredAt),
  });
}

function decodeRegistrationResult(bytes: Uint8Array): RepositoryRegistration {
  try {
    const message = fromBinary(RegisterRepositoryResponseSchema, bytes);
    const unknownField = findUnknownField(RegisterRepositoryResponseSchema, message);
    if (unknownField !== undefined || message.repository === undefined) {
      throw new TypeError("registered repository result violates its Protobuf contract");
    }
    return registrationFromMessage(message.repository);
  } catch (error) {
    if (error instanceof RepositoryRegistryError) {
      throw error;
    }
    throw new RepositoryRegistryError(
      "corrupt",
      "registered repository command result is corrupt",
      {
        cause: error,
      },
    );
  }
}

function registrationFromMessage(
  message: MessageShape<typeof RegisteredRepositorySchema>,
): RepositoryRegistration {
  try {
    const canonicalRoot = repositoryRoot(message.canonicalRoot);
    const canonicalRemote = nonEmptyText(message.canonicalRemote, "canonical remote");
    const defaultBranch = nonEmptyText(message.defaultBranch, "default branch");
    const baseCommit = gitSha(message.baseCommit);
    const allowedWorkspaceRoot = repositoryRoot(message.allowedWorkspaceRoot);
    validateTextLength(canonicalRoot, 4096, "canonical root");
    validateTextLength(canonicalRemote, 2048, "canonical remote");
    validateTextLength(defaultBranch, 255, "default branch");
    validateTextLength(allowedWorkspaceRoot, 4096, "allowed workspace root");
    validateCanonicalFacts(canonicalRoot, canonicalRemote, defaultBranch, allowedWorkspaceRoot);
    return Object.freeze({
      id: repositoryId(message.id),
      hostId: hostId(message.hostId),
      canonicalRoot,
      canonicalRemote,
      defaultBranch,
      baseCommit,
      caseSensitive: message.caseSensitive,
      submodulePaths: snapshotFeaturePaths(message.submodulePaths, "submodule"),
      lfsPaths: snapshotFeaturePaths(message.lfsPaths, "LFS"),
      nestedRepositoryPaths: snapshotFeaturePaths(
        message.nestedRepositoryPaths,
        "nested repository",
      ),
      allowedWorkspaceRoot,
      registeredAt: timestampFromMessage(message.registeredAt),
    });
  } catch (error) {
    if (error instanceof RepositoryRegistryError) {
      throw error;
    }
    throw new RepositoryRegistryError("corrupt", "registered repository message is corrupt", {
      cause: error,
    });
  }
}

function timestampMessage(value: Timestamp): { seconds: bigint; nanos: number } {
  const milliseconds = BigInt(value);
  return {
    seconds: milliseconds / 1_000n,
    nanos: Number(milliseconds % 1_000n) * 1_000_000,
  };
}

function timestampFromMessage(value: ProtoTimestamp | undefined): Timestamp {
  if (
    value === undefined ||
    typeof value.seconds !== "bigint" ||
    typeof value.nanos !== "number" ||
    !Number.isInteger(value.nanos) ||
    value.nanos < 0 ||
    value.nanos > 999_999_999
  ) {
    throw new TypeError("registered timestamp is malformed");
  }
  if (value.nanos % 1_000_000 !== 0) {
    throw new TypeError("registered timestamp must have millisecond precision");
  }
  const milliseconds = value.seconds * 1_000n + BigInt(Math.floor(value.nanos / 1_000_000));
  if (milliseconds < 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("registered timestamp is outside the safe integer range");
  }
  return timestampFromEpochMilliseconds(Number(milliseconds));
}

function readRegistrationRows(reader: SqliteReader): readonly RepositoryRegistration[] {
  const rows = reader.all(
    `SELECT rr.repository_id, rr.host_id, rr.canonical_root, rr.canonical_remote,
            rr.default_branch, rr.base_commit, rr.allowed_workspace_root,
            rr.case_sensitive, rr.registered_at_ms,
            r.id AS projection_id, r.host_id AS projection_host_id,
            r.root_path AS projection_root_path, r.version AS projection_version,
            r.registered_at_ms AS projection_registered_at_ms,
            r.archived_at_ms AS projection_archived_at_ms
       FROM repository_registrations AS rr
       LEFT JOIN repositories AS r ON r.id = rr.repository_id
      ORDER BY rr.repository_id`,
  );
  return Object.freeze(rows.map((row) => toRegistration(reader, row)));
}

function readRegistrationRow(reader: SqliteReader, id: RepositoryId): SqliteRow | undefined {
  return reader.get(
    `SELECT rr.repository_id, rr.host_id, rr.canonical_root, rr.canonical_remote,
            rr.default_branch, rr.base_commit, rr.allowed_workspace_root,
            rr.case_sensitive, rr.registered_at_ms,
            r.id AS projection_id, r.host_id AS projection_host_id,
            r.root_path AS projection_root_path, r.version AS projection_version,
            r.registered_at_ms AS projection_registered_at_ms,
            r.archived_at_ms AS projection_archived_at_ms
       FROM repository_registrations AS rr
       LEFT JOIN repositories AS r ON r.id = rr.repository_id
      WHERE rr.repository_id = ?`,
    [id],
  );
}

function toRegistration(reader: SqliteReader, row: SqliteRow): RepositoryRegistration {
  try {
    const id = repositoryId(requiredString(row, "repository_id"));
    const host = hostId(requiredString(row, "host_id"));
    const canonicalRoot = repositoryRoot(requiredString(row, "canonical_root"));
    const canonicalRemote = nonEmptyText(
      requiredString(row, "canonical_remote"),
      "canonical remote",
    );
    const defaultBranch = nonEmptyText(requiredString(row, "default_branch"), "default branch");
    const baseCommit = gitSha(requiredString(row, "base_commit"));
    const allowedWorkspaceRoot = repositoryRoot(requiredString(row, "allowed_workspace_root"));
    const caseSensitive = parseBoolean(row, "case_sensitive");
    const registeredAt = timestampFromEpochMilliseconds(
      safeNonNegativeInteger(row, "registered_at_ms"),
    );
    validateTextLength(canonicalRoot, 4096, "canonical root");
    validateTextLength(canonicalRemote, 2048, "canonical remote");
    validateTextLength(defaultBranch, 255, "default branch");
    validateCanonicalAbsolutePath(canonicalRoot, "canonical root");
    validateCanonicalAbsolutePath(allowedWorkspaceRoot, "allowed workspace root");
    validateTextLength(allowedWorkspaceRoot, 4096, "allowed workspace root");
    validateCanonicalFacts(canonicalRoot, canonicalRemote, defaultBranch, allowedWorkspaceRoot);
    const projectionId = requiredNullableString(row, "projection_id");
    const projectionHostId = requiredNullableString(row, "projection_host_id");
    const projectionRoot = requiredNullableString(row, "projection_root_path");
    const projectionVersion = safeNonNegativeInteger(row, "projection_version");
    const projectionRegisteredAt = safeNonNegativeInteger(row, "projection_registered_at_ms");
    if (
      projectionId !== id ||
      projectionHostId !== host ||
      projectionRoot !== canonicalRoot ||
      projectionVersion !== 0 ||
      projectionRegisteredAt !== registeredAt ||
      row["projection_archived_at_ms"] !== null
    ) {
      throw new TypeError("repository projection does not match its registration");
    }
    const features = readFeatures(reader, id);
    return Object.freeze({
      id,
      hostId: host,
      canonicalRoot,
      canonicalRemote,
      defaultBranch,
      baseCommit,
      caseSensitive,
      submodulePaths: features.submodulePaths,
      lfsPaths: features.lfsPaths,
      nestedRepositoryPaths: features.nestedRepositoryPaths,
      allowedWorkspaceRoot,
      registeredAt,
    });
  } catch (error) {
    if (error instanceof RepositoryRegistryError) {
      throw error;
    }
    throw new RepositoryRegistryError("corrupt", "repository registration data is corrupt", {
      cause: error,
    });
  }
}

function readFeatures(
  reader: SqliteReader,
  repository: RepositoryId,
): Readonly<{
  submodulePaths: readonly string[];
  lfsPaths: readonly string[];
  nestedRepositoryPaths: readonly string[];
}> {
  const rows = reader.all(
    `SELECT feature_kind, relative_path
       FROM repository_features
      WHERE repository_id = ?
      ORDER BY feature_kind, relative_path`,
    [repository],
  );
  const submodules: string[] = [];
  const lfs: string[] = [];
  const nested: string[] = [];
  for (const row of rows) {
    const kind = requiredString(row, "feature_kind");
    const path = nonEmptyText(requiredString(row, "relative_path"), "feature path");
    validateTextLength(path, 4096, "feature path");
    validateRelativeFeaturePath(path, "feature path");
    if (kind === "submodule") {
      submodules.push(path);
    } else if (kind === "lfs") {
      lfs.push(path);
    } else if (kind === "nested_repository") {
      nested.push(path);
    } else {
      throw new RepositoryRegistryError("corrupt", "repository feature kind is invalid");
    }
  }
  return Object.freeze({
    submodulePaths: Object.freeze(submodules),
    lfsPaths: Object.freeze(lfs),
    nestedRepositoryPaths: Object.freeze(nested),
  });
}

function parseBoolean(row: SqliteRow, key: string): boolean {
  const value = row[key];
  if (typeof value === "bigint") {
    if (value === 0n) {
      return false;
    }
    if (value === 1n) {
      return true;
    }
  } else if (value === 0 || value === 1) {
    return value === 1;
  }
  throw new TypeError(`${key} is not a Boolean integer`);
}

function safeNonNegativeInteger(row: SqliteRow, key: string): number {
  const value = row[key];
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new TypeError(`${key} is outside the safe integer range`);
    }
    return Number(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new TypeError(`${key} is not a non-negative safe integer`);
}

function requiredString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${key} is not a non-empty string`);
  }
  return value;
}

function requiredNullableString(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${key} is not a non-null non-empty string`);
  }
  return value;
}

function parseHostId(value: unknown, fieldName: string): HostId {
  try {
    if (typeof value !== "string") {
      throw new TypeError(`${fieldName} must be a string`);
    }
    return hostId(value);
  } catch (error) {
    throw new RepositoryRegistryError("invalid_input", `${fieldName} is invalid`, {
      cause: error,
    });
  }
}

function parseRepositoryId(value: unknown, fieldName: string): RepositoryId {
  try {
    if (typeof value !== "string") {
      throw new TypeError(`${fieldName} must be a string`);
    }
    return repositoryId(value);
  } catch (error) {
    throw new RepositoryRegistryError("invalid_input", `${fieldName} is invalid`, {
      cause: error,
    });
  }
}

function pathsOverlap(left: string, right: string, caseSensitive: boolean): boolean {
  const leftComponents = pathComponents(left, caseSensitive);
  const rightComponents = pathComponents(right, caseSensitive);
  return isPrefix(leftComponents, rightComponents) || isPrefix(rightComponents, leftComponents);
}

function pathComponents(value: string, caseSensitive: boolean): readonly string[] {
  const normalized = normalizePath(value);
  const components = normalized.split(pathSeparator).filter((component) => component.length > 0);
  return caseSensitive ? components : components.map((component) => component.toLowerCase());
}

function isPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  if (prefix.length > value.length) {
    return false;
  }
  return prefix.every((component, index) => component === value[index]);
}
function normalizeRegisterError(error: unknown): RepositoryRegistryError | Error {
  let current = error;
  const visited = new Set<Error>();
  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof RepositoryRegistryError) {
      return current;
    }
    visited.add(current);
    current = current.cause;
  }
  if (error instanceof SqliteCommandError) {
    if (error.code === "aggregate_version_conflict" || error.code === "command_id_conflict") {
      return new RepositoryRegistryError(
        "identity_conflict",
        "repository registration command conflicts with an existing command or repository",
        { cause: error },
      );
    }
    if (error.code === "command_result_corrupt") {
      return new RepositoryRegistryError("corrupt", "repository command result is corrupt", {
        cause: error,
      });
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}
