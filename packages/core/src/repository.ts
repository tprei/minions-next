import { DomainError } from "./domain-error.js";
import type { DomainPorts } from "./ports.js";
import {
  hostId,
  repositoryId,
  repositoryRoot,
  timestampFromEpochMilliseconds,
  type HostId,
  type RepositoryId,
  type RepositoryRoot,
  type Timestamp,
} from "./value-objects.js";

declare const repositoryBrand: unique symbol;

export type Repository = Readonly<{
  readonly [repositoryBrand]: true;
  readonly id: RepositoryId;
  readonly hostId: HostId;
  readonly root: RepositoryRoot;
  readonly registeredAt: Timestamp;
}>;

export type CreateRepositoryInput = Readonly<{
  readonly hostId: HostId;
  readonly root: RepositoryRoot;
}>;

export function createRepository(input: CreateRepositoryInput, ports: DomainPorts): Repository {
  hostId(input.hostId);
  repositoryRoot(input.root);
  const id = repositoryId(ports.ids.nextId());
  const repositoryIdValue: string = id;
  const hostIdValue: string = input.hostId;
  if (repositoryIdValue === hostIdValue) {
    throw new DomainError("duplicate_id", "repository and host IDs must differ");
  }
  const registeredAt = timestampFromEpochMilliseconds(ports.clock.now());

  return Object.freeze({
    id,
    hostId: input.hostId,
    root: input.root,
    registeredAt,
  }) as Repository;
}
