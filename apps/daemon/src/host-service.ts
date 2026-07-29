import { randomUUID } from "node:crypto";
import {
  createSecureIdGenerator,
  HostRegistryError,
  type ExecutionHostRecord,
  type SupervisorHostRegistry,
} from "@minions/adapters";
import {
  create,
  type DescMessage,
  type MessageShape,
  type MessageValidType,
} from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { createValidator } from "@bufbuild/protovalidate";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import {
  ExecutionHostKind,
  ExecutionHostSchema,
  ExecutionHostState,
  HostService,
  ListHostsResponseSchema,
} from "@minions/contracts";
import { DomainError, hostId, timestampFromEpochMilliseconds, type HostId } from "@minions/core";

const responseValidator = createValidator();

export function registerHostService(router: ConnectRouter, registry: SupervisorHostRegistry): void {
  const ids = createSecureIdGenerator({ now: () => timestampFromEpochMilliseconds(Date.now()) });
  router.service(HostService, {
    listHosts(request) {
      const afterId = parsePageToken(request.pageToken);
      const rows = registry.list({ afterId, limit: request.pageSize + 1 });
      const hosts = rows.slice(0, request.pageSize);
      const response = create(ListHostsResponseSchema, {
        hosts: hosts.map(toHostMessage),
        nextPageToken: rows.length > request.pageSize ? hosts.at(-1)?.id : undefined,
      });
      return validateResponse(ListHostsResponseSchema, response);
    },
    async registerSshHost(request) {
      if (request.profile === undefined) {
        throw new ConnectError("profile is required", Code.InvalidArgument);
      }
      const profile = request.profile;
      if (profile.alias.trim().length === 0) {
        throw new ConnectError("alias must not be empty", Code.InvalidArgument);
      }
      const host = await registry.registerSsh({
        id: hostId(ids.nextId()),
        displayName: profile.alias,
        hostname: profile.hostname,
        port: profile.port,
        username: profile.user,
        knownHostKeyFingerprint: profile.knownHostKey,
        registeredAt: timestampFromEpochMilliseconds(Date.now()),
      });
      return { host: toHostMessage(host) };
    },
    async removeHost(request) {
      const id = parseHostId(request.id);
      try {
        await registry.remove(id, timestampFromEpochMilliseconds(Date.now()));
      } catch (error) {
        // Idempotent: removing an unknown host id still succeeds — the caller's
        // postcondition ("this host is not trusted") holds either way.
        if (!(error instanceof HostRegistryError) || error.code !== "host_not_found") {
          throw error;
        }
      }
      return {};
    },
  });
}

function parseHostId(value: string): HostId {
  try {
    return hostId(value);
  } catch (error) {
    if (error instanceof DomainError) {
      throw new ConnectError(
        "id must be a UUIDv7 identifier",
        Code.InvalidArgument,
        undefined,
        undefined,
        error,
      );
    }
    throw error;
  }
}

function parsePageToken(value: string | undefined): HostId | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return hostId(value);
  } catch (error) {
    if (error instanceof DomainError) {
      throw new ConnectError(
        "page_token must be a UUIDv7 identifier",
        Code.InvalidArgument,
        undefined,
        undefined,
        error,
      );
    }
    throw error;
  }
}

function toHostMessage(host: ExecutionHostRecord) {
  const message = create(ExecutionHostSchema, {
    id: host.id,
    kind: toHostKind(host.kind),
    displayName: host.displayName,
    state: toHostState(host.state),
    endpoint: host.endpoint,
    version: BigInt(host.version),
    registeredAt: timestampFromMilliseconds(host.registeredAt),
    lastSeenAt:
      host.lastSeenAt === undefined ? undefined : timestampFromMilliseconds(host.lastSeenAt),
  });
  return validateResponse(ExecutionHostSchema, message);
}

function toHostKind(kind: ExecutionHostRecord["kind"]): ExecutionHostKind {
  switch (kind) {
    case "local":
      return ExecutionHostKind.LOCAL;
    case "ssh":
      return ExecutionHostKind.SSH;
    case "wsl2":
      return ExecutionHostKind.WSL2;
  }
}

function toHostState(state: ExecutionHostRecord["state"]): ExecutionHostState {
  switch (state) {
    case "pending":
      return ExecutionHostState.PENDING;
    case "online":
      return ExecutionHostState.ONLINE;
    case "offline":
      return ExecutionHostState.OFFLINE;
    case "degraded":
      return ExecutionHostState.DEGRADED;
    case "removed":
      return ExecutionHostState.REMOVED;
  }
}

function timestampFromMilliseconds(milliseconds: number) {
  return create(TimestampSchema, {
    seconds: BigInt(Math.floor(milliseconds / 1000)),
    nanos: (milliseconds % 1000) * 1_000_000,
  });
}

function validateResponse<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): MessageValidType<Desc> {
  const validation = responseValidator.validate(schema, message);
  if (validation.kind !== "valid") {
    throw new ConnectError(
      "host service produced an invalid response",
      Code.Internal,
      undefined,
      undefined,
      validation.error,
    );
  }
  return validation.message;
}
