import { create } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import {
  GateProfileError,
  inspectRepository,
  loadGateProfile,
  RepositoryInspectionError,
  RepositoryRegistryError,
  type HostGateMinimum,
  type RepositoryRegistration,
  type RepositoryRegistry,
} from "@minions/adapters";
import {
  GetRepositoryResponseSchema,
  ListRepositoriesResponseSchema,
  RegisteredRepositorySchema,
  RegisterRepositoryResponseSchema,
  RepositoryService,
} from "@minions/contracts";
import { repositoryId, timestampFromEpochMilliseconds, type Clock } from "@minions/core";
import { isAbsolute, join, relative, sep } from "node:path";
const responseValidator = createValidator();
export type RepositoryServiceOptions = Readonly<{
  home: string;
  clock: Clock;
  registry: RepositoryRegistry;
  hostMinimum?: HostGateMinimum;
}>;

export function registerRepositoryService(
  router: ConnectRouter,
  options: RepositoryServiceOptions,
): void {
  router.service(RepositoryService, {
    async registerRepository(request) {
      try {
        const inspection = await inspectRepository(request.rootPath);
        assertRegistrationPolicy(inspection);
        assertRepositoryLocation(options.home, inspection.canonicalRoot);
        if (options.hostMinimum !== undefined) {
          await loadGateProfile(inspection.canonicalRoot, options.hostMinimum);
        }
        const registration = await options.registry.register({
          request,
          inspection,
          allowedWorkspaceRoot: join(options.home, "workspaces", request.repositoryId),
          registeredAt: timestampFromEpochMilliseconds(options.clock.now()),
        });
        return validateResponse(
          RegisterRepositoryResponseSchema,
          create(RegisterRepositoryResponseSchema, {
            repository: toRepositoryMessage(registration),
          }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    getRepository(request) {
      try {
        const registration = options.registry.get(repositoryId(request.repositoryId));
        return validateResponse(
          GetRepositoryResponseSchema,
          create(GetRepositoryResponseSchema, {
            repository: toRepositoryMessage(registration),
          }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
    listRepositories(request) {
      try {
        const afterId =
          request.pageToken === undefined ? undefined : repositoryId(request.pageToken);
        const rows = options.registry.list({ afterId, limit: request.pageSize + 1 });
        const registrations = rows.slice(0, request.pageSize);
        const next = rows.at(request.pageSize);
        return validateResponse(
          ListRepositoriesResponseSchema,
          create(ListRepositoriesResponseSchema, {
            repositories: registrations.map(toRepositoryMessage),
            ...(next === undefined ? {} : { nextPageToken: registrations.at(-1)?.id }),
          }),
        );
      } catch (error) {
        throw toConnectError(error);
      }
    },
  });
}
function assertRepositoryLocation(home: string, canonicalRoot: string): void {
  const workspaceRoot = join(home, "workspaces");
  if (isWithin(home, canonicalRoot) || isWithin(workspaceRoot, canonicalRoot)) {
    throw new ConnectError(
      "repository root must be outside the Minions home and workspace roots",
      Code.FailedPrecondition,
    );
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function assertRegistrationPolicy(inspection: Awaited<ReturnType<typeof inspectRepository>>): void {
  if (inspection.dirty) {
    throw new ConnectError("repository checkout must be clean", Code.FailedPrecondition);
  }
  if (inspection.submodulePaths.length > 0) {
    throw new ConnectError(
      "repositories with submodules are not supported",
      Code.FailedPrecondition,
    );
  }
  if (inspection.lfsPaths.length > 0) {
    throw new ConnectError(
      "repositories with Git LFS paths are not supported",
      Code.FailedPrecondition,
    );
  }
  if (inspection.nestedRepositoryPaths.length > 0) {
    throw new ConnectError(
      "repositories containing nested Git repositories are not supported",
      Code.FailedPrecondition,
    );
  }
}

function toRepositoryMessage(registration: RepositoryRegistration) {
  const registeredAt = BigInt(registration.registeredAt);
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
    registeredAt: {
      seconds: registeredAt / 1_000n,
      nanos: Number(registeredAt % 1_000n) * 1_000_000,
    },
  });
}

function toConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) {
    return error;
  }
  if (error instanceof RepositoryInspectionError) {
    const code = error.code === "invalid_root" ? Code.InvalidArgument : Code.FailedPrecondition;
    return new ConnectError(error.message, code, undefined, undefined, error);
  }
  if (error instanceof GateProfileError) {
    const code =
      error.code === "missing" || error.code === "invalid"
        ? Code.InvalidArgument
        : Code.FailedPrecondition;
    return new ConnectError(error.message, code, undefined, undefined, error);
  }
  if (error instanceof RepositoryRegistryError) {
    switch (error.code) {
      case "not_found":
        return new ConnectError(error.message, Code.NotFound, undefined, undefined, error);
      case "invalid_input":
        return new ConnectError(error.message, Code.InvalidArgument, undefined, undefined, error);
      case "identity_conflict":
      case "facts_changed":
      case "overlap":
        return new ConnectError(
          error.message,
          Code.FailedPrecondition,
          undefined,
          undefined,
          error,
        );
      case "corrupt":
        return new ConnectError(error.message, Code.DataLoss, undefined, undefined, error);
    }
  }
  return new ConnectError(
    "repository operation failed",
    Code.Internal,
    undefined,
    undefined,
    error,
  );
}

function validateResponse<Schema extends Parameters<typeof responseValidator.validate>[0]>(
  schema: Schema,
  message: Parameters<typeof responseValidator.validate<Schema>>[1],
) {
  const validation = responseValidator.validate(schema, message);
  if (validation.kind !== "valid") {
    throw new ConnectError(
      "repository service produced an invalid response",
      Code.Internal,
      undefined,
      undefined,
      validation.error,
    );
  }
  return validation.message;
}
