import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ProjectionChangeSchema,
  RegisterRepositoryRequestSchema,
  RegisterRepositoryResponseSchema,
} from "@minions/contracts";
import type { RegisterRepositoryRequest } from "@minions/contracts";
import {
  createEventCommitWaiter,
  createRepositoryRegistry,
  createSqliteCommandStore,
  RepositoryRegistryError,
} from "@minions/adapters";
import type {
  EventCommitWaiter,
  RepositoryInspection,
  RepositoryRegistry,
} from "@minions/adapters";
import { repositoryId, hostId, timestampFromEpochMilliseconds } from "@minions/core";
import { DatabaseSync } from "node:sqlite";
import type { RepositoryId, Timestamp } from "@minions/core";
import { FixedClock, SequenceIdGenerator } from "@minions/testkit";
import { FaultInjectingSqliteDatabase, TemporarySqliteDatabase } from "@minions/testkit/sqlite";
import { describe, expect, it } from "vitest";

const REGISTERED_AT = timestampFromEpochMilliseconds(1_700_000_000_000);
const HOST_ID = hostId("018f3a2e-4a20-7b90-8123-abcdef123456");
const ACTOR_ID = "018f3a2e-4a20-7b90-8123-abcdef123457";
const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const EVENT_IDS = [
  "018f3a2e-4a20-7b90-8123-abcdef123458",
  "018f3a2e-4a20-7b90-8123-abcdef123459",
  "018f3a2e-4a20-7b90-8123-abcdef12345a",
  "018f3a2e-4a20-7b90-8123-abcdef12345b",
  "018f3a2e-4a20-7b90-8123-abcdef12345c",
  "018f3a2e-4a20-7b90-8123-abcdef12345d",
  "018f3a2e-4a20-7b90-8123-abcdef12345e",
  "018f3a2e-4a20-7b90-8123-abcdef12345f",
];
const CLOCK = new FixedClock(REGISTERED_AT);

type Fixture = Readonly<{
  temporary: TemporarySqliteDatabase;
  registry: RepositoryRegistry;
  notifier: EventCommitWaiter;
}>;

async function withFixture<T>(operation: (fixture: Fixture) => Promise<T>): Promise<T> {
  const temporary = await TemporarySqliteDatabase.create("host", CLOCK);
  const notifier = createEventCommitWaiter();
  const commandStore = createSqliteCommandStore({
    database: temporary.database,
    ports: { clock: CLOCK, ids: new SequenceIdGenerator(EVENT_IDS) },
    notifier,
  });
  const registry = createRepositoryRegistry({
    database: temporary.database,
    commandStore,
    hostId: HOST_ID,
  });
  try {
    return await operation({ temporary, registry, notifier });
  } finally {
    notifier.close();
    await temporary.dispose();
  }
}

function request(
  command: string,
  repository: string,
  root: string,
  actor = ACTOR_ID,
): RegisterRepositoryRequest {
  return create(RegisterRepositoryRequestSchema, {
    commandId: command,
    actorSessionId: actor,
    repositoryId: repository,
    rootPath: root,
  });
}

function inspection(
  root: string,
  options: Readonly<{
    canonicalRemote?: string;
    defaultBranch?: string;
    baseCommit?: string;
    caseSensitive?: boolean;
    submodulePaths?: readonly string[];
    lfsPaths?: readonly string[];
    nestedRepositoryPaths?: readonly string[];
    dirty?: boolean;
  }> = {},
): RepositoryInspection {
  return {
    canonicalRoot: root,
    canonicalRemote: options.canonicalRemote ?? "https://example.test/project",
    defaultBranch: options.defaultBranch ?? "main",
    baseCommit: options.baseCommit ?? BASE_COMMIT,
    caseSensitive: options.caseSensitive ?? true,
    submodulePaths: options.submodulePaths ?? [],
    lfsPaths: options.lfsPaths ?? [],
    nestedRepositoryPaths: options.nestedRepositoryPaths ?? [],
    dirty: options.dirty ?? false,
  };
}

async function register(
  registry: RepositoryRegistry,
  command: string,
  repository: string,
  root: string,
  options: Readonly<{
    allowedWorkspaceRoot?: string;
    inspection?: RepositoryInspection;
    registeredAt?: Timestamp;
  }> = {},
) {
  return registry.register({
    request: request(command, repository, root),
    inspection: options.inspection ?? inspection(root),
    allowedWorkspaceRoot: options.allowedWorkspaceRoot ?? `/workspaces/${repository.slice(-4)}`,
    registeredAt: options.registeredAt ?? REGISTERED_AT,
  });
}

function binary(row: Readonly<Record<string, unknown>> | undefined, key: string): Uint8Array {
  const value = row?.[key];
  if (!(value instanceof Uint8Array)) {
    throw new Error(`${key} is not binary`);
  }
  return value;
}

function repo(value: string): RepositoryId {
  return repositoryId(value);
}

describe("SQLite repository registry", () => {
  it("atomically persists metadata, features, command journals, and a projection event", async () => {
    await withFixture(async ({ temporary, registry, notifier }) => {
      const repository = await register(
        registry,
        "018f3a2e-4a20-7b90-8123-abcdef123457",
        "018f3a2e-4a20-7b90-8123-abcdef123460",
        "/repos/alpha",
        {
          allowedWorkspaceRoot: "/workspaces/alpha",
          inspection: inspection("/repos/alpha", {
            canonicalRemote: "ssh://git@example.test/project",
            defaultBranch: "trunk",
            submodulePaths: ["vendor/submodule"],
            lfsPaths: ["assets/large.bin"],
            nestedRepositoryPaths: ["tools/embedded"],
            dirty: true,
          }),
        },
      );

      expect(repository).toEqual({
        id: repo("018f3a2e-4a20-7b90-8123-abcdef123460"),
        hostId: HOST_ID,
        canonicalRoot: "/repos/alpha",
        canonicalRemote: "ssh://git@example.test/project",
        defaultBranch: "trunk",
        baseCommit: BASE_COMMIT,
        caseSensitive: true,
        submodulePaths: ["vendor/submodule"],
        lfsPaths: ["assets/large.bin"],
        nestedRepositoryPaths: ["tools/embedded"],
        allowedWorkspaceRoot: "/workspaces/alpha",
        registeredAt: REGISTERED_AT,
      });
      expect(Object.isFrozen(repository)).toBe(true);
      expect(Object.isFrozen(repository.submodulePaths)).toBe(true);
      expect(notifier.getRevision()).toBe(1n);

      const rows = temporary.database.read((reader) => ({
        repositories: reader.all("SELECT * FROM repositories"),
        registrations: reader.all("SELECT * FROM repository_registrations"),
        features: reader.all(
          "SELECT feature_kind, relative_path FROM repository_features ORDER BY feature_kind, relative_path",
        ),
        commands: reader.all("SELECT * FROM operator_commands"),
        idempotency: reader.all("SELECT * FROM idempotency_records"),
        events: reader.all("SELECT * FROM events"),
      }));
      expect(rows.repositories).toHaveLength(1);
      expect(rows.registrations).toHaveLength(1);
      expect(rows.features).toEqual([
        { feature_kind: "lfs", relative_path: "assets/large.bin" },
        { feature_kind: "nested_repository", relative_path: "tools/embedded" },
        { feature_kind: "submodule", relative_path: "vendor/submodule" },
      ]);
      expect(rows.commands).toHaveLength(1);
      expect(rows.idempotency).toHaveLength(1);
      expect(rows.events).toHaveLength(1);
      const event = fromBinary(ProjectionChangeSchema, binary(rows.events[0], "event_payload"));
      expect(event.change.case).toBe("repositoryUpserted");
      if (event.change.case === "repositoryUpserted") {
        expect(event.change.value.id).toBe(repository.id);
        expect(event.change.value.hostId).toBe(HOST_ID);
        expect(event.change.value.version).toBe(0n);
        expect(event.change.value.archived).toBe(false);
      }
      const command = fromBinary(
        RegisterRepositoryRequestSchema,
        binary(rows.commands[0], "command_payload"),
      );
      expect(command.rootPath).toBe("/repos/alpha");
      const result = fromBinary(
        RegisterRepositoryResponseSchema,
        binary(rows.idempotency[0], "result_payload"),
      );
      expect(result.repository?.id).toBe(repository.id);
      expect(rows.idempotency[0]?.["committed_sequence"]).toBe(rows.events[0]?.["sequence"]);
      expect(registry.get(repository.id)).toEqual(repository);
    });
  });

  it("replays an exact command and rejects a changed request or immutable re-registration", async () => {
    await withFixture(async ({ registry, notifier }) => {
      const first = await register(
        registry,
        "018f3a2e-4a20-7b90-8123-abcdef123457",
        "018f3a2e-4a20-7b90-8123-abcdef123460",
        "/repos/replay",
      );
      const replay = await registry.register({
        request: request(
          "018f3a2e-4a20-7b90-8123-abcdef123457",
          "018f3a2e-4a20-7b90-8123-abcdef123460",
          "/repos/replay",
        ),
        inspection: inspection("/repos/replay"),
        allowedWorkspaceRoot: "/workspaces/3460",
        registeredAt: timestampFromEpochMilliseconds(1_700_000_000_100),
      });
      expect(replay).toEqual(first);
      expect(notifier.getRevision()).toBe(1n);
      await expect(
        registry.register({
          request: request(
            "018f3a2e-4a20-7b90-8123-abcdef123457",
            "018f3a2e-4a20-7b90-8123-abcdef123460",
            "/repos/replay",
          ),
          inspection: inspection("/repos/replay", {
            canonicalRemote: "https://changed.test/replay",
          }),
          allowedWorkspaceRoot: "/workspaces/3460",
          registeredAt: timestampFromEpochMilliseconds(1_700_000_000_200),
        }),
      ).rejects.toMatchObject({ code: "facts_changed" });
      expect(notifier.getRevision()).toBe(1n);

      await expect(
        registry.register({
          request: request(
            "018f3a2e-4a20-7b90-8123-abcdef123457",
            "018f3a2e-4a20-7b90-8123-abcdef123460",
            "/repos/replay-changed",
          ),
          inspection: inspection("/repos/replay-changed"),
          allowedWorkspaceRoot: "/workspaces/replay-changed",
          registeredAt: REGISTERED_AT,
        }),
      ).rejects.toMatchObject({ code: "identity_conflict" });
      await expect(
        register(
          registry,
          "018f3a2e-4a20-7b90-8123-abcdef12345f",
          "018f3a2e-4a20-7b90-8123-abcdef123460",
          "/repos/replay",
        ),
      ).rejects.toMatchObject({ code: "identity_conflict" });
    });
  });

  it("rejects semantically corrupt replay payloads and persisted canonical facts", async () => {
    await withFixture(async ({ temporary, registry }) => {
      const command = "018f3a2e-4a20-7b90-8123-abcdef123458";
      const repository = "018f3a2e-4a20-7b90-8123-abcdef123461";
      const registered = await register(registry, command, repository, "/repos/corrupt-facts");
      const payload = temporary.database.read((reader) =>
        reader.get("SELECT result_payload FROM idempotency_records WHERE command_id = ?", [
          command,
        ]),
      );
      if (payload === undefined) {
        throw new Error("idempotency payload was not persisted");
      }
      const message = fromBinary(
        RegisterRepositoryResponseSchema,
        binary(payload, "result_payload"),
      );
      if (message.repository === undefined) {
        throw new Error("repository result was not persisted");
      }
      message.repository.defaultBranch = ".hidden";
      const corruptReplayDatabase = new DatabaseSync(temporary.path);
      try {
        corruptReplayDatabase.exec(
          "DROP TRIGGER idempotency_record_is_immutable; DROP TRIGGER repository_registration_identity_immutable;",
        );
        corruptReplayDatabase
          .prepare("UPDATE idempotency_records SET result_payload = ? WHERE command_id = ?")
          .run(toBinary(RegisterRepositoryResponseSchema, message), command);
      } finally {
        corruptReplayDatabase.close();
      }
      await expect(
        register(registry, command, repository, "/repos/corrupt-facts"),
      ).rejects.toMatchObject({ code: "corrupt" });

      const corruptRemoteDatabase = new DatabaseSync(temporary.path);
      try {
        corruptRemoteDatabase
          .prepare(
            "UPDATE repository_registrations SET canonical_remote = ? WHERE repository_id = ?",
          )
          .run("file:///tmp/unsafe", repository);
      } finally {
        corruptRemoteDatabase.close();
      }
      expect(() => registry.get(registered.id)).toThrow(
        expect.objectContaining({ code: "corrupt" }),
      );
      const corruptBranchDatabase = new DatabaseSync(temporary.path);
      try {
        corruptBranchDatabase
          .prepare(
            "UPDATE repository_registrations SET canonical_remote = ?, default_branch = ? WHERE repository_id = ?",
          )
          .run(registered.canonicalRemote, "release.lock", repository);
      } finally {
        corruptBranchDatabase.close();
      }
      expect(() => registry.get(registered.id)).toThrow(
        expect.objectContaining({ code: "corrupt" }),
      );
    });
  });
  it.each(["release.lock", ".hidden", "topic[1", "@", "-option"])(
    "rejects the Git-invalid default branch %s",
    async (defaultBranch) => {
      await withFixture(async ({ registry }) => {
        await expect(
          register(
            registry,
            "018f3a2e-4a20-7b90-8123-abcdef123458",
            "018f3a2e-4a20-7b90-8123-abcdef123461",
            "/repos/invalid-branch",
            {
              inspection: inspection("/repos/invalid-branch", { defaultBranch }),
              allowedWorkspaceRoot: "/workspaces/invalid-branch",
            },
          ),
        ).rejects.toMatchObject({ code: "invalid_input" });
      });
    },
  );

  it("rejects path-boundary overlap in both root/workspace directions but allows lexical prefixes", async () => {
    await withFixture(async ({ registry }) => {
      await register(
        registry,
        "018f3a2e-4a20-7b90-8123-abcdef123457",
        "018f3a2e-4a20-7b90-8123-abcdef123460",
        "/workspace/root",
        { allowedWorkspaceRoot: "/workspace/workspace" },
      );
      await expect(
        register(
          registry,
          "018f3a2e-4a20-7b90-8123-abcdef12345f",
          "018f3a2e-4a20-7b90-8123-abcdef123461",
          "/workspace/workspace/child",
          { allowedWorkspaceRoot: "/isolated/child" },
        ),
      ).rejects.toMatchObject({ code: "overlap" });
      await expect(
        register(
          registry,
          "018f3a2e-4a20-7b90-8123-abcdef12345e",
          "018f3a2e-4a20-7b90-8123-abcdef123462",
          "/isolated/root",
          { allowedWorkspaceRoot: "/workspace/root/child" },
        ),
      ).rejects.toMatchObject({ code: "overlap" });
      const lexical = await register(
        registry,
        "018f3a2e-4a20-7b90-8123-abcdef12345d",
        "018f3a2e-4a20-7b90-8123-abcdef123463",
        "/workspace/root-sibling",
        { allowedWorkspaceRoot: "/workspace/workspace-sibling" },
      );
      expect(lexical.canonicalRoot).toBe("/workspace/root-sibling");
    });
  });

  it("folds path components when either registration is case-insensitive and rejects self-overlap", async () => {
    await withFixture(async ({ registry }) => {
      await register(
        registry,
        "018f3a2e-4a20-7b90-8123-abcdef123457",
        "018f3a2e-4a20-7b90-8123-abcdef123460",
        "/Workspace/CaseRoot",
        {
          allowedWorkspaceRoot: "/Workspace/CaseWorkspace",
          inspection: inspection("/Workspace/CaseRoot", { caseSensitive: false }),
        },
      );
      await expect(
        register(
          registry,
          "018f3a2e-4a20-7b90-8123-abcdef12345f",
          "018f3a2e-4a20-7b90-8123-abcdef123461",
          "/workspace/caseroot/child",
          {
            allowedWorkspaceRoot: "/isolated/case",
            inspection: inspection("/workspace/caseroot/child"),
          },
        ),
      ).rejects.toMatchObject({ code: "overlap" });
      await expect(
        register(
          registry,
          "018f3a2e-4a20-7b90-8123-abcdef12345e",
          "018f3a2e-4a20-7b90-8123-abcdef123462",
          "/self/repository",
          { allowedWorkspaceRoot: "/self/repository/workspace" },
        ),
      ).rejects.toMatchObject({ code: "overlap" });
    });
  });

  it("gets not-found, paginates by repository UUID, and detects projection corruption", async () => {
    await withFixture(async ({ temporary, registry }) => {
      const ids = [
        "018f3a2e-4a20-7b90-8123-abcdef123463",
        "018f3a2e-4a20-7b90-8123-abcdef123461",
        "018f3a2e-4a20-7b90-8123-abcdef123462",
      ] as const;
      for (const [index, id] of ids.entries()) {
        await register(
          registry,
          `018f3a2e-4a20-7b90-8123-abcdef1234${String(70 + index)}`,
          id,
          `/pagination/${String(index)}`,
          { allowedWorkspaceRoot: `/pagination-workspaces/${String(index)}` },
        );
      }
      expect(registry.list({ afterId: undefined, limit: 2 }).map((value) => value.id)).toEqual([
        repo(ids[1]),
        repo(ids[2]),
      ]);
      expect(registry.list({ afterId: repo(ids[2]), limit: 2 }).map((value) => value.id)).toEqual([
        repo(ids[0]),
      ]);
      expect(() => registry.get(repo("018f3a2e-4a20-7b90-8123-abcdef1234ff"))).toThrow(
        RepositoryRegistryError,
      );
      expect(() => registry.get(repo("018f3a2e-4a20-7b90-8123-abcdef1234ff"))).toThrow(
        expect.objectContaining({ code: "not_found" }),
      );

      await temporary.database.write((transaction) => {
        transaction.run("UPDATE repositories SET version = 1 WHERE id = ?", [ids[1]]);
      });
      expect(() => registry.get(repo(ids[1]))).toThrow(
        expect.objectContaining({ code: "corrupt" }),
      );
    });
  });

  it("rolls back every write when SQLite fails during feature persistence", async () => {
    const temporary = await TemporarySqliteDatabase.create("host", CLOCK);
    const notifier = createEventCommitWaiter();
    const database = new FaultInjectingSqliteDatabase(temporary.applicationDatabase, {
      failAtWrite: 5,
      timing: "after",
    });
    const commandStore = createSqliteCommandStore({
      database,
      ports: { clock: CLOCK, ids: new SequenceIdGenerator(EVENT_IDS) },
      notifier,
    });
    const registry = createRepositoryRegistry({ database, commandStore, hostId: HOST_ID });
    try {
      await expect(
        register(
          registry,
          "018f3a2e-4a20-7b90-8123-abcdef123457",
          "018f3a2e-4a20-7b90-8123-abcdef123460",
          "/rollback/repository",
          {
            allowedWorkspaceRoot: "/rollback/workspace",
            inspection: inspection("/rollback/repository", {
              submodulePaths: ["submodule"],
              lfsPaths: ["large.bin"],
              nestedRepositoryPaths: ["nested"],
            }),
          },
        ),
      ).rejects.toMatchObject({ code: "command_failed" });
      const counts = database.read((reader) => ({
        repositories: reader.get("SELECT count(*) AS count FROM repositories"),
        registrations: reader.get("SELECT count(*) AS count FROM repository_registrations"),
        features: reader.get("SELECT count(*) AS count FROM repository_features"),
        commands: reader.get("SELECT count(*) AS count FROM operator_commands"),
        idempotency: reader.get("SELECT count(*) AS count FROM idempotency_records"),
        events: reader.get("SELECT count(*) AS count FROM events"),
      }));
      for (const row of Object.values(counts)) {
        expect(row?.["count"]).toBe(0n);
      }
    } finally {
      notifier.close();
      await temporary.dispose();
    }
  });
});
