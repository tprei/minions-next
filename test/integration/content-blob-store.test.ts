import {
  BlobCorruptionError,
  createFileContentBlobStore,
  type CreateFileContentBlobStoreOptions,
} from "@minions/adapters";
import {
  BlobPersistenceRejected,
  contentHash,
  nonEmptyText,
  timestampFromEpochMilliseconds,
  type ContentBlobStore,
  type ContentHash,
  type ExpectedBlob,
  type StoredBlob,
} from "@minions/core";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const fsFaults = vi.hoisted(() => ({
  failLink: false,
  failTempCloseRemaining: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return {
    ...actual,
    open: async (...arguments_: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...arguments_);
      if (arguments_[1] === "wx" && fsFaults.failTempCloseRemaining > 0) {
        const originalClose = handle.close.bind(handle);
        handle.close = async () => {
          if (fsFaults.failTempCloseRemaining > 0) {
            fsFaults.failTempCloseRemaining -= 1;
            throw new Error("injected temp close failure");
          }
          return originalClose();
        };
      }
      return handle;
    },
    link: async (...arguments_: Parameters<typeof actual.link>): Promise<void> => {
      if (fsFaults.failLink) {
        fsFaults.failLink = false;
        throw Object.assign(new Error("injected publication link failure"), { code: "EIO" });
      }
      await actual.link(...arguments_);
    },
  };
});

const NOW = 1_700_000_000_123;
const IDS = [
  "018f3a2e-4a20-7b90-8123-abcdef123456",
  "018f3a2e-4a20-7b90-8123-abcdef123457",
  "018f3a2e-4a20-7b90-8123-abcdef123458",
  "018f3a2e-4a20-7b90-8123-abcdef123459",
  "018f3a2e-4a20-7b90-8123-abcdef12345a",
  "018f3a2e-4a20-7b90-8123-abcdef12345b",
];

async function withRoot<T>(operation: (rootPath: string) => Promise<T>): Promise<T> {
  const rootPath = await mkdtemp(join(tmpdir(), "minions-content-blobs-"));
  try {
    return await operation(rootPath);
  } finally {
    await rm(rootPath, { force: true, recursive: true });
  }
}

function storeOptions(rootPath: string, ids = IDS): CreateFileContentBlobStoreOptions {
  let index = 0;
  return {
    rootPath,
    clock: { now: () => timestampFromEpochMilliseconds(NOW) },
    ids: {
      nextId: () => {
        const id = ids[index];
        if (id === undefined) {
          throw new Error("test ID sequence exhausted");
        }
        index += 1;
        return id;
      },
    },
  };
}

function relativePath(digest: ContentHash): string {
  return `sha256/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
}

function publish(store: ContentBlobStore, content: Uint8Array): Promise<StoredBlob> {
  return store.withPublishedBlob(content, (blob) => Promise.resolve(blob));
}
function expectedBlob(digest: ContentHash, sizeBytes: bigint): ExpectedBlob {
  return {
    digest,
    sizeBytes,
    relativePath: nonEmptyText(relativePath(digest), "blob relative path"),
  };
}
function digestForContent(content: Uint8Array): ContentHash {
  return contentHash(createHash("sha256").update(content).digest("hex"));
}

async function prepareDigestLayout(rootPath: string, digest: ContentHash): Promise<void> {
  const digestDirectory = join(rootPath, "sha256", digest.slice(0, 2), digest.slice(2, 4));
  await mkdir(digestDirectory, { recursive: true, mode: 0o700 });
}

type FileHandlePrototype = Pick<FileHandle, "stat" | "sync" | "writeFile">;

function isFileHandlePrototype(value: object | null): value is FileHandlePrototype {
  return (
    value !== null &&
    "stat" in value &&
    typeof value.stat === "function" &&
    "sync" in value &&
    typeof value.sync === "function" &&
    "writeFile" in value &&
    typeof value.writeFile === "function"
  );
}
async function fileHandlePrototype(rootPath: string): Promise<FileHandlePrototype> {
  const probe = await fsPromises.open(rootPath, "r");
  const prototype = Reflect.getPrototypeOf(probe);
  await probe.close();
  if (!isFileHandlePrototype(prototype)) {
    throw new Error("opened file handle has an unexpected prototype");
  }
  return prototype;
}

async function failNextTempWrite(rootPath: string): Promise<void> {
  const prototype = await fileHandlePrototype(rootPath);
  vi.spyOn(prototype, "writeFile").mockRejectedValueOnce(new Error("injected temp write failure"));
}

function failTempClose(): void {
  fsFaults.failTempCloseRemaining = 2;
}

async function failNextTempSync(rootPath: string): Promise<void> {
  const prototype = await fileHandlePrototype(rootPath);
  const originalSync = prototype.sync;
  let failed = false;
  vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
    const metadata = await this.stat();
    if (!failed && metadata.isFile()) {
      failed = true;
      throw new Error("injected temp fsync failure");
    }
    return originalSync.call(this);
  });
}

async function failNextDirectorySync(rootPath: string): Promise<void> {
  const prototype = await fileHandlePrototype(rootPath);
  const originalSync = prototype.sync;
  let failed = false;
  vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
    const metadata = await this.stat();
    if (!failed && metadata.isDirectory()) {
      failed = true;
      throw new Error("injected directory fsync failure");
    }
    return originalSync.call(this);
  });
}
afterEach(() => {
  fsFaults.failLink = false;
  fsFaults.failTempCloseRemaining = 0;
  vi.restoreAllMocks();
});

describe("file content blob store", () => {
  it("publishes durable canonical blobs and verifies reads", async () => {
    await withRoot(async (rootPath) => {
      const store = createFileContentBlobStore(storeOptions(rootPath));
      const content = new TextEncoder().encode("hello blob");
      const stored = await publish(store, content);
      const finalPath = join(rootPath, stored.relativePath);

      expect(stored.sizeBytes).toBe(BigInt(content.byteLength));
      expect(stored.relativePath).toBe(relativePath(stored.digest));
      expect(stored.created).toBe(true);
      expect(new Uint8Array(await store.readVerified(stored))).toEqual(content);
      expect((await lstat(rootPath)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(rootPath, "sha256"))).mode & 0o777).toBe(0o700);
      expect((await lstat(finalPath)).mode & 0o777).toBe(0o600);

      const repeated = await publish(store, content);
      expect(repeated).toEqual({ ...stored, created: false });
      expect(new Uint8Array(await readFile(finalPath))).toEqual(content);
    });
  });

  it("deduplicates concurrent puts and never replaces a verified final", async () => {
    await withRoot(async (rootPath) => {
      const content = new TextEncoder().encode("same bytes");
      const firstStore = createFileContentBlobStore(storeOptions(rootPath, IDS.slice(0, 1)));
      const secondStore = createFileContentBlobStore(storeOptions(rootPath, IDS.slice(1, 2)));
      const [first, second] = await Promise.all([
        publish(firstStore, content),
        publish(secondStore, content),
      ]);
      expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
      expect(first.digest).toBe(second.digest);
      expect(await publish(firstStore, content)).toEqual({ ...first, created: false });

      const digestDirectory = join(
        rootPath,
        "sha256",
        first.digest.slice(0, 2),
        first.digest.slice(2, 4),
      );
      const entries = await readdir(digestDirectory);
      expect(entries).toEqual([first.digest]);
    });
  });

  it("serializes persistence callbacks and verified reads", async () => {
    await withRoot(async (rootPath) => {
      const store = createFileContentBlobStore(storeOptions(rootPath));
      const firstContent = new TextEncoder().encode("first serialized blob");
      const secondContent = new TextEncoder().encode("second serialized blob");
      let startPersistence: () => void = () => undefined;
      const persistenceStarted = new Promise<void>((resolve) => {
        startPersistence = resolve;
      });
      let releasePersistence: () => void = () => undefined;
      const persistenceReleased = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      let secondPersistenceRan = false;
      const first = store.withPublishedBlob(firstContent, async (blob) => {
        startPersistence();
        await persistenceReleased;
        return blob;
      });
      await persistenceStarted;
      let readCompleted = false;
      const readObservation = store
        .readVerified(expectedBlob(digestForContent(firstContent), BigInt(firstContent.byteLength)))
        .then(() => {
          readCompleted = true;
        });
      const second = store.withPublishedBlob(secondContent, (blob) => {
        secondPersistenceRan = true;
        return Promise.resolve(blob);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(secondPersistenceRan).toBe(false);
      expect(readCompleted).toBe(false);
      releasePersistence();
      await Promise.all([first, second, readObservation]);
      expect(secondPersistenceRan).toBe(true);
      expect(readCompleted).toBe(true);
    });
  });

  it("rejects a corrupt existing final without replacing it", async () => {
    await withRoot(async (rootPath) => {
      const store = createFileContentBlobStore(storeOptions(rootPath));
      const content = new TextEncoder().encode("original");
      const stored = await publish(store, content);
      const finalPath = join(rootPath, stored.relativePath);
      await writeFile(finalPath, "corrupt");

      await expect(publish(store, content)).rejects.toThrow(/digest|size/u);
      expect(await readFile(finalPath, "utf8")).toBe("corrupt");
    });
  });

  it("reconciles sorted temporary, orphan, missing, and corrupt records", async () => {
    await withRoot(async (rootPath) => {
      const store = createFileContentBlobStore(storeOptions(rootPath));
      const retained = await publish(store, new TextEncoder().encode("retained"));
      const missingDigest = contentHash("a".repeat(64));
      const orphanDigest = contentHash("b".repeat(64));
      const secondOrphanDigest = contentHash("c".repeat(64));
      const orphanPath = join(rootPath, relativePath(orphanDigest));
      const secondOrphanPath = join(rootPath, relativePath(secondOrphanDigest));
      await mkdir(dirname(orphanPath), { recursive: true, mode: 0o700 });
      await mkdir(dirname(secondOrphanPath), { recursive: true, mode: 0o700 });
      await writeFile(orphanPath, "orphan");
      await writeFile(secondOrphanPath, "orphan-2");
      const digestDirectory = join(
        rootPath,
        "sha256",
        retained.digest.slice(0, 2),
        retained.digest.slice(2, 4),
      );
      const temporaryPath = join(digestDirectory, ".tmp-018f3a2e-4a20-7b90-8123-abcdef12345a");
      await writeFile(temporaryPath, "temporary");
      await writeFile(join(rootPath, retained.relativePath), "corrupt");

      const result = await store.reconcile([
        expectedBlob(retained.digest, retained.sizeBytes),
        expectedBlob(missingDigest, 1n),
      ]);

      expect(result.removedTemporaryPaths).toEqual([
        relativePath(retained.digest).replace(
          retained.digest,
          ".tmp-018f3a2e-4a20-7b90-8123-abcdef12345a",
        ),
      ]);
      expect(result.removedOrphanPaths).toEqual([
        relativePath(orphanDigest),
        relativePath(secondOrphanDigest),
      ]);
      expect(result.missingDigests).toEqual([missingDigest]);
      expect(result.corruptDigests).toEqual([retained.digest]);
      await expect(readFile(orphanPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(secondOrphanPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("leaves no invalid final across write, fsync, link, and directory-fsync failures", async () => {
    await withRoot(async (rootPath) => {
      const scenarios = [
        {
          content: new TextEncoder().encode("temp write failure"),
          inject: () => failNextTempWrite(rootPath),
          finalMayExist: false,
        },
        {
          content: new TextEncoder().encode("temp fsync failure"),
          inject: () => failNextTempSync(rootPath),
          finalMayExist: false,
        },
        {
          content: new TextEncoder().encode("temp close failure"),
          inject: () => {
            failTempClose();
          },
          finalMayExist: false,
        },
        {
          content: new TextEncoder().encode("publication link failure"),
          inject: () => {
            fsFaults.failLink = true;
          },
          finalMayExist: false,
        },
        {
          content: new TextEncoder().encode("directory fsync failure"),
          inject: () => failNextDirectorySync(rootPath),
          finalMayExist: true,
        },
      ] as const;

      for (const scenario of scenarios) {
        vi.restoreAllMocks();
        const digest = digestForContent(scenario.content);
        await prepareDigestLayout(rootPath, digest);
        await scenario.inject();
        const store = createFileContentBlobStore(storeOptions(rootPath));
        await expect(publish(store, scenario.content)).rejects.toThrow(/injected|cleanup/u);

        const finalPath = join(rootPath, relativePath(digest));
        if (scenario.finalMayExist) {
          expect(new Uint8Array(await readFile(finalPath))).toEqual(scenario.content);
        } else {
          await expect(lstat(finalPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
        const digestDirectory = dirname(finalPath);
        const entries = await readdir(digestDirectory);
        expect(entries.filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);

        vi.restoreAllMocks();
        const retry = await publish(store, scenario.content);
        expect(retry.created).toBe(!scenario.finalMayExist);
        expect(new Uint8Array(await store.readVerified(retry))).toEqual(scenario.content);
        const reconciliation = await store.reconcile([expectedBlob(retry.digest, retry.sizeBytes)]);
        expect(reconciliation).toEqual({
          removedTemporaryPaths: [],
          removedOrphanPaths: [],
          missingDigests: [],
          corruptDigests: [],
        });
        await store.reconcile([]);
      }
    });
  });

  it("removes newly published blobs only for typed persistence rejection", async () => {
    await withRoot(async (rootPath) => {
      const store = createFileContentBlobStore(storeOptions(rootPath));
      const content = new TextEncoder().encode("callback rejection");
      const cause = new Error("metadata rejected");
      await expect(
        store.withPublishedBlob(content, (blob) => {
          expect(blob.created).toBe(true);
          return Promise.reject(new BlobPersistenceRejected(cause));
        }),
      ).rejects.toBe(cause);
      const digest = digestForContent(content);
      await expect(lstat(join(rootPath, relativePath(digest)))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const stored = await publish(store, content);
      const retainedCause = new Error("existing metadata rejected");
      await expect(
        store.withPublishedBlob(content, () =>
          Promise.reject(new BlobPersistenceRejected(retainedCause)),
        ),
      ).rejects.toBe(retainedCause);
      await expect(store.readVerified(stored)).resolves.toEqual(content);
    });
  });

  it("rejects sparse oversized finals before reading their contents", async () => {
    await withRoot(async (rootPath) => {
      const store = createFileContentBlobStore(storeOptions(rootPath));
      const content = new TextEncoder().encode("bounded blob");
      const stored = await publish(store, content);
      const finalPath = join(rootPath, stored.relativePath);
      await truncate(finalPath, 64 * 1024 * 1024 + 1);

      await expect(store.readVerified(stored)).rejects.toThrow(/supported range|metadata/u);
      const reconciliation = await store.reconcile([expectedBlob(stored.digest, stored.sizeBytes)]);
      expect(reconciliation.corruptDigests).toEqual([stored.digest]);
      expect(reconciliation.missingDigests).toEqual([]);
    });
  });

  it("reports missing and non-regular canonical finals as corruption", async () => {
    await withRoot(async (rootPath) => {
      const store = createFileContentBlobStore(storeOptions(rootPath));
      const content = new TextEncoder().encode("missing blob");
      const stored = await publish(store, content);
      const finalPath = join(rootPath, stored.relativePath);

      await rm(finalPath);
      await expect(store.readVerified(stored)).rejects.toBeInstanceOf(BlobCorruptionError);
      await expect(store.readVerified(stored)).rejects.toMatchObject({
        code: "blob_corrupt",
        digest: stored.digest,
      });

      await mkdir(finalPath);
      await expect(store.readVerified(stored)).rejects.toMatchObject({
        code: "blob_corrupt",
        digest: stored.digest,
      });

      await rm(finalPath, { force: true, recursive: true });
      await rm(dirname(finalPath), { force: true, recursive: true });
      await expect(store.readVerified(stored)).rejects.toMatchObject({
        code: "blob_corrupt",
        digest: stored.digest,
      });
    });
  });

  it(
    "rejects a FIFO at the canonical path instead of blocking on open",
    async () => {
      await withRoot(async (rootPath) => {
        const store = createFileContentBlobStore(storeOptions(rootPath));
        const content = new TextEncoder().encode("fifo blob");
        const stored = await publish(store, content);
        const finalPath = join(rootPath, stored.relativePath);

        await rm(finalPath);
        execFileSync("mkfifo", [finalPath]);

        // A FIFO with no writer attached blocks a plain O_RDONLY open()
        // indefinitely; readVerified must reject promptly (not hang) once no
        // writer ever connects.
        await expect(store.readVerified(stored)).rejects.toMatchObject({
          code: "blob_corrupt",
          digest: stored.digest,
        });
      });
    },
    5_000,
  );

  it("rejects symlinked layout entries without touching their targets", async () => {
    await withRoot(async (rootPath) => {
      const outsidePath = await mkdtemp(join(tmpdir(), "minions-outside-"));
      try {
        const store = createFileContentBlobStore(storeOptions(rootPath));
        await store.reconcile([]);
        const linkPath = join(rootPath, "sha256", "aa");
        await symlink(outsidePath, linkPath);
        const sentinelPath = join(outsidePath, "sentinel");
        await writeFile(sentinelPath, "outside");

        await expect(store.reconcile([])).rejects.toThrow(/canonical/u);
        expect(await readFile(sentinelPath, "utf8")).toBe("outside");
      } finally {
        await rm(outsidePath, { force: true, recursive: true });
      }
    });
  });

  it("rejects non-canonical metadata paths before accessing files", async () => {
    await withRoot(async (rootPath) => {
      const store = createFileContentBlobStore(storeOptions(rootPath));
      const content = new TextEncoder().encode("path validation");
      const stored = await publish(store, content);

      await expect(
        store.readVerified({
          ...stored,
          relativePath: nonEmptyText("../outside", "blob relative path"),
        }),
      ).rejects.toThrow(/canonical/u);
    });
  });
});
