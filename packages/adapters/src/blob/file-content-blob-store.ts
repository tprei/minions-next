import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
  link,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

import {
  BlobPersistenceRejected,
  contentHash,
  nonEmptyText,
  type BlobReconciliation,
  type Clock,
  type ContentBlobStore,
  type ContentHash,
  type ExpectedBlob,
  type IdGenerator,
  type NonEmptyText,
  type StoredBlob,
} from "@minions/core";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_BLOB_SIZE_BYTES = 64n * 1024n * 1024n;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const PREFIX_PATTERN = /^[0-9a-f]{2}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_DIRECTORY = "sha256";
const NO_FOLLOW_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const NO_FOLLOW_DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export type CreateFileContentBlobStoreOptions = Readonly<{
  rootPath: string;
  clock: Clock;
  ids: IdGenerator;
}>;

type NormalizedExpectedBlob = Readonly<{
  digest: ContentHash;
  sizeBytes: bigint;
  relativePath: NonEmptyText;
}>;

type TemporaryBlob = Readonly<{
  path: string;
  handle: FileHandle;
}>;

export function createFileContentBlobStore(
  options: CreateFileContentBlobStoreOptions,
): ContentBlobStore {
  assertPosixBlobStoreSupport();
  if (typeof options.rootPath !== "string" || options.rootPath.trim().length === 0) {
    throw new TypeError("blob store root path must not be empty");
  }
  const rootPath = resolve(options.rootPath);
  if (dirname(rootPath) === rootPath) {
    throw new TypeError("blob store root path must not be the filesystem root");
  }
  return new FileContentBlobStore(rootPath, options.clock, options.ids);
}

class FileContentBlobStore implements ContentBlobStore {
  readonly #rootPath: string;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(rootPath: string, clock: Clock, ids: IdGenerator) {
    this.#rootPath = rootPath;
    this.#clock = clock;
    this.#ids = ids;
  }

  withPublishedBlob<T>(content: Uint8Array, persist: (blob: StoredBlob) => Promise<T>): Promise<T> {
    if (!(content instanceof Uint8Array)) {
      return Promise.reject(new TypeError("blob content must be a Uint8Array"));
    }
    const contentSize = BigInt(content.byteLength);
    if (contentSize < 1n || contentSize > MAX_BLOB_SIZE_BYTES) {
      return Promise.reject(new RangeError("blob content must be between 1 and 64 MiB"));
    }
    if (typeof persist !== "function") {
      return Promise.reject(new TypeError("blob persistence callback must be a function"));
    }
    const stableContent = new Uint8Array(content);
    const digest = digestFor(stableContent);
    return this.#runExclusive(async () => {
      const blob = await this.#putStable(stableContent, digest);
      try {
        return await persist(blob);
      } catch (error: unknown) {
        if (!(error instanceof BlobPersistenceRejected)) {
          throw error;
        }
        const cause = error.cause;
        if (!(cause instanceof Error)) {
          throw error;
        }
        if (blob.created) {
          try {
            await this.#removePublishedBlob(blob);
          } catch (cleanupError: unknown) {
            throw new AggregateError([cause, cleanupError], "blob persistence cleanup failed", {
              cause: cleanupError,
            });
          }
        }
        throw cause;
      }
    });
  }

  readVerified(expected: ExpectedBlob): Promise<Uint8Array> {
    return this.#runExclusive(async () => {
      const normalized = normalizeExpectedBlob(expected);
      try {
        const directory = await this.#assertBlobDirectories(normalized.digest);
        const path = join(directory, normalized.digest);
        return await readExpectedBlobFile(path, normalized.digest, normalized.sizeBytes);
      } catch (error: unknown) {
        if (hasErrorCode(error, "ENOENT")) {
          throw new BlobCorruptionError(normalized.digest, "blob is missing", { cause: error });
        }
        throw error;
      }
    });
  }

  reconcile(expected: readonly ExpectedBlob[]): Promise<BlobReconciliation> {
    return this.#runExclusive(() => this.#reconcileStable(expected));
  }

  async #reconcileStable(expected: readonly ExpectedBlob[]): Promise<BlobReconciliation> {
    const normalizedExpected = normalizeExpectedBlobs(expected);
    await ensureDirectory(this.#rootPath, true);
    const sha256Path = join(this.#rootPath, SHA256_DIRECTORY);
    await ensureDirectory(sha256Path, true);
    const rootEntries = await readdir(this.#rootPath, { withFileTypes: true });
    for (const rootEntry of rootEntries) {
      if (rootEntry.name !== SHA256_DIRECTORY) {
        throw nonCanonicalEntry(this.#rootPath, rootEntry.name);
      }
      if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
        throw nonCanonicalEntry(this.#rootPath, rootEntry.name);
      }
    }

    const expectedByDigest = new Map<string, NormalizedExpectedBlob>();
    for (const item of normalizedExpected) {
      const prior = expectedByDigest.get(item.digest);
      if (prior !== undefined && prior.sizeBytes !== item.sizeBytes) {
        throw new BlobStoreError(`expected blob ${item.digest} has conflicting sizes`);
      }
      expectedByDigest.set(item.digest, item);
    }

    const removedTemporaryPaths: string[] = [];
    const removedOrphanPaths: string[] = [];
    const corruptDigests = new Set<ContentHash>();
    const presentDigests = new Set<ContentHash>();
    const shaEntries = (await readdir(sha256Path, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );

    for (const shaEntry of shaEntries) {
      const firstPrefix = shaEntry.name;
      if (shaEntry.isSymbolicLink() || !shaEntry.isDirectory()) {
        throw nonCanonicalEntry(sha256Path, firstPrefix);
      }
      if (!PREFIX_PATTERN.test(firstPrefix)) {
        throw nonCanonicalEntry(sha256Path, firstPrefix);
      }
      const firstPrefixPath = join(sha256Path, firstPrefix);
      await assertDirectory(firstPrefixPath);
      const secondEntries = (await readdir(firstPrefixPath, { withFileTypes: true })).sort(
        (left, right) => left.name.localeCompare(right.name),
      );

      for (const secondEntry of secondEntries) {
        const secondPrefix = secondEntry.name;
        if (secondEntry.isSymbolicLink() || !secondEntry.isDirectory()) {
          throw nonCanonicalEntry(firstPrefixPath, secondPrefix);
        }
        if (!PREFIX_PATTERN.test(secondPrefix)) {
          throw nonCanonicalEntry(firstPrefixPath, secondPrefix);
        }
        const digestDirectory = join(firstPrefixPath, secondPrefix);
        await assertDirectory(digestDirectory);
        const digestEntries = (await readdir(digestDirectory, { withFileTypes: true })).sort(
          (left, right) => left.name.localeCompare(right.name),
        );

        for (const digestEntry of digestEntries) {
          const name = digestEntry.name;
          const entryPath = join(digestDirectory, name);
          const relativePath = relativePathForEntry(firstPrefix, secondPrefix, name);
          if (name.startsWith(".tmp-")) {
            if (!UUID_PATTERN.test(name.slice(".tmp-".length))) {
              throw nonCanonicalEntry(digestDirectory, name);
            }
            const metadata = await lstat(entryPath);
            if (metadata.isSymbolicLink() || !metadata.isFile()) {
              throw nonCanonicalEntry(digestDirectory, name);
            }
            await unlink(entryPath);
            await syncDirectory(digestDirectory);
            removedTemporaryPaths.push(relativePath);
            continue;
          }
          if (!DIGEST_PATTERN.test(name)) {
            throw nonCanonicalEntry(digestDirectory, name);
          }
          if (name.slice(0, 2) !== firstPrefix || name.slice(2, 4) !== secondPrefix) {
            throw nonCanonicalEntry(digestDirectory, name);
          }
          const metadata = await lstat(entryPath);
          if (metadata.isSymbolicLink() || !metadata.isFile()) {
            throw nonCanonicalEntry(digestDirectory, name);
          }
          const expectedBlob = expectedByDigest.get(name);
          if (expectedBlob === undefined) {
            await unlink(entryPath);
            await syncDirectory(digestDirectory);
            removedOrphanPaths.push(relativePath);
            continue;
          }
          try {
            await readVerifiedFile(entryPath, expectedBlob.digest, expectedBlob.sizeBytes);
            presentDigests.add(expectedBlob.digest);
          } catch (error: unknown) {
            if (error instanceof BlobCorruptionError) {
              corruptDigests.add(expectedBlob.digest);
              continue;
            }
            if (hasErrorCode(error, "ENOENT")) {
              continue;
            }
            throw error;
          }
        }
      }
    }

    const missingDigests: ContentHash[] = [];
    for (const item of normalizedExpected) {
      if (!presentDigests.has(item.digest) && !corruptDigests.has(item.digest)) {
        missingDigests.push(item.digest);
      }
    }

    return Object.freeze({
      removedTemporaryPaths: Object.freeze([...new Set(removedTemporaryPaths)].sort()),
      removedOrphanPaths: Object.freeze([...new Set(removedOrphanPaths)].sort()),
      missingDigests: Object.freeze([...new Set(missingDigests)].sort()),
      corruptDigests: Object.freeze([...corruptDigests].sort()),
    });
  }

  async #putStable(content: Uint8Array, digest: ContentHash): Promise<StoredBlob> {
    await ensureDirectory(this.#rootPath, true);
    const digestDirectory = await this.#ensureBlobDirectories(digest);
    const finalPath = join(digestDirectory, digest);
    const sizeBytes = BigInt(content.byteLength);

    const existing = await tryReadVerifiedFile(finalPath, digest, sizeBytes);
    if (existing) {
      await syncDirectory(digestDirectory);
      return storedBlob(digest, sizeBytes, this.#clock, false);
    }

    const temporary = await this.#createTemporary(digestDirectory);
    let handle: FileHandle | undefined = temporary.handle;
    try {
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;

      try {
        await link(temporary.path, finalPath);
      } catch (error: unknown) {
        if (!hasErrorCode(error, "EEXIST")) {
          throw error;
        }
        await readVerifiedFile(finalPath, digest, sizeBytes);
        await unlink(temporary.path);
        await syncDirectory(digestDirectory);
        return storedBlob(digest, sizeBytes, this.#clock, false);
      }

      try {
        await readVerifiedFile(finalPath, digest, sizeBytes);
      } catch (publicationError: unknown) {
        try {
          await readVerifiedFile(finalPath, digest, sizeBytes);
        } catch (recheckError: unknown) {
          if (!hasErrorCode(recheckError, "ENOENT")) {
            await unlink(finalPath);
            await syncDirectory(digestDirectory);
          }
        }
        throw publicationError;
      }

      await unlink(temporary.path);
      await syncDirectory(digestDirectory);
      return storedBlob(digest, sizeBytes, this.#clock, true);
    } catch (error: unknown) {
      let closeError: unknown;
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch (error: unknown) {
          closeError = error;
        }
      }
      let cleanupError: unknown;
      try {
        await removeTemporaryAfterFailure(temporary.path, digestDirectory);
      } catch (error: unknown) {
        cleanupError = error;
      }
      if (closeError !== undefined || cleanupError !== undefined) {
        const causes: unknown[] = [error];
        if (closeError !== undefined) {
          causes.push(closeError);
        }
        if (cleanupError !== undefined) {
          causes.push(cleanupError);
        }
        throw new AggregateError(causes, "blob publication cleanup failed", { cause: error });
      }
      throw error;
    }
  }

  async #removePublishedBlob(blob: StoredBlob): Promise<void> {
    const directory = await this.#assertBlobDirectories(blob.digest);
    const path = join(directory, blob.digest);
    try {
      await readVerifiedFile(path, blob.digest, blob.sizeBytes);
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    await unlink(path);
    await syncDirectory(directory);
  }

  #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#operationTail.then(operation, operation);
    this.#operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #createTemporary(directory: string): Promise<TemporaryBlob> {
    for (;;) {
      const id = this.#ids.nextId();
      if (!UUID_PATTERN.test(id)) {
        throw new BlobStoreError("temporary blob ID must be a lowercase RFC UUID");
      }
      const path = join(directory, `.tmp-${id}`);
      try {
        const handle = await open(path, "wx", PRIVATE_FILE_MODE);
        return Object.freeze({ path, handle });
      } catch (error: unknown) {
        if (hasErrorCode(error, "EEXIST")) {
          continue;
        }
        throw error;
      }
    }
  }

  async #ensureBlobDirectories(digest: ContentHash): Promise<string> {
    const sha256Path = join(this.#rootPath, SHA256_DIRECTORY);
    await ensureDirectory(sha256Path, true);
    const firstPrefixPath = join(sha256Path, digest.slice(0, 2));
    await ensureDirectory(firstPrefixPath, true);
    const secondPrefixPath = join(firstPrefixPath, digest.slice(2, 4));
    await ensureDirectory(secondPrefixPath, true);
    return secondPrefixPath;
  }

  async #assertBlobDirectories(digest: ContentHash): Promise<string> {
    const sha256Path = join(this.#rootPath, SHA256_DIRECTORY);
    await assertDirectory(this.#rootPath);
    await assertDirectory(sha256Path);
    const firstPrefixPath = join(sha256Path, digest.slice(0, 2));
    await assertDirectory(firstPrefixPath);
    const secondPrefixPath = join(firstPrefixPath, digest.slice(2, 4));
    await assertDirectory(secondPrefixPath);
    return secondPrefixPath;
  }
}

function assertPosixBlobStoreSupport(): void {
  if (
    typeof constants.O_NOFOLLOW !== "number" ||
    constants.O_NOFOLLOW === 0 ||
    typeof constants.O_DIRECTORY !== "number" ||
    constants.O_DIRECTORY === 0
  ) {
    throw new BlobStoreError("file content blob store requires POSIX no-follow filesystem flags");
  }
}

function digestFor(content: Uint8Array): ContentHash {
  return contentHash(createHash("sha256").update(content).digest("hex"));
}

function relativePathFor(digest: ContentHash): NonEmptyText {
  return nonEmptyText(
    posix.join(SHA256_DIRECTORY, digest.slice(0, 2), digest.slice(2, 4), digest),
    "blob relative path",
  );
}

function relativePathForEntry(firstPrefix: string, secondPrefix: string, name: string): string {
  return posix.join(SHA256_DIRECTORY, firstPrefix, secondPrefix, name);
}

function normalizeExpectedBlob(input: ExpectedBlob): NormalizedExpectedBlob {
  const digest = contentHash(input.digest);
  if (
    typeof input.sizeBytes !== "bigint" ||
    input.sizeBytes < 1n ||
    input.sizeBytes > MAX_BLOB_SIZE_BYTES
  ) {
    throw new TypeError("expected blob size must be between 1 and 64 MiB");
  }
  const relativePath = relativePathFor(digest);
  if (input.relativePath !== relativePath) {
    throw new BlobStoreError(`expected blob ${digest} has a non-canonical relative path`);
  }
  return Object.freeze({ digest, sizeBytes: input.sizeBytes, relativePath });
}

function normalizeExpectedBlobs(
  expected: readonly ExpectedBlob[],
): readonly NormalizedExpectedBlob[] {
  return Object.freeze(expected.map((item) => normalizeExpectedBlob(item)));
}

async function ensureDirectory(path: string, secure: boolean): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
    const parent = dirname(path);
    if (parent === path) {
      throw new BlobStoreError(`cannot create blob directory ${path}`);
    }
    await ensureDirectory(parent, false);
    let created = false;
    try {
      await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
      created = true;
    } catch (mkdirError: unknown) {
      if (!hasErrorCode(mkdirError, "EEXIST")) {
        throw mkdirError;
      }
    }
    if (created) {
      await syncDirectory(parent);
    }
    metadata = await lstat(path);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw nonCanonicalEntry(dirname(path), path.slice(dirname(path).length + 1));
  }
  if (secure) {
    await chmod(path, PRIVATE_DIRECTORY_MODE);
  }
}

async function assertDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw nonCanonicalEntry(dirname(path), path.slice(dirname(path).length + 1));
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, NO_FOLLOW_DIRECTORY_FLAGS);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readVerifiedFile(
  path: string,
  digest: ContentHash,
  expectedSizeBytes?: bigint,
): Promise<Uint8Array> {
  const handle = await open(path, NO_FOLLOW_READ_FLAGS);
  try {
    const initialMetadata = await handle.stat({ bigint: true });
    if (!initialMetadata.isFile()) {
      throw new BlobNonRegularError(`blob ${digest} is not a regular file`);
    }
    const sizeBytes = initialMetadata.size;
    if (sizeBytes < 1n || sizeBytes > MAX_BLOB_SIZE_BYTES) {
      throw new BlobCorruptionError(digest, "blob size is outside the supported range");
    }
    if (expectedSizeBytes !== undefined && sizeBytes !== expectedSizeBytes) {
      throw new BlobCorruptionError(digest, "blob size does not match metadata");
    }
    const content = Buffer.allocUnsafe(Number(sizeBytes));
    let bytesRead = 0;
    while (bytesRead < content.byteLength) {
      const result = await handle.read(content, bytesRead, content.byteLength - bytesRead, null);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const extraResult = await handle.read(extra, 0, 1, null);
    const finalMetadata = await handle.stat({ bigint: true });
    if (
      bytesRead !== content.byteLength ||
      extraResult.bytesRead !== 0 ||
      finalMetadata.size !== sizeBytes
    ) {
      throw new BlobCorruptionError(digest, "blob size changed while it was read");
    }
    const actualContent = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    if (digestFor(actualContent) !== digest) {
      throw new BlobCorruptionError(digest, "blob digest does not match its path");
    }
    return actualContent;
  } finally {
    await handle.close();
  }
}

async function readExpectedBlobFile(
  path: string,
  digest: ContentHash,
  expectedSizeBytes: bigint,
): Promise<Uint8Array> {
  try {
    return await readVerifiedFile(path, digest, expectedSizeBytes);
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT") || error instanceof BlobNonRegularError) {
      throw new BlobCorruptionError(digest, "blob is missing or not a regular file", {
        cause: error,
      });
    }
    throw error;
  }
}

async function tryReadVerifiedFile(
  path: string,
  digest: ContentHash,
  expectedSizeBytes: bigint,
): Promise<boolean> {
  try {
    await readVerifiedFile(path, digest, expectedSizeBytes);
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function removeTemporaryAfterFailure(path: string, directory: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
    return;
  }
  await syncDirectory(directory);
}

function storedBlob(
  digest: ContentHash,
  sizeBytes: bigint,
  clock: Clock,
  created: boolean,
): StoredBlob {
  return Object.freeze({
    digest,
    sizeBytes,
    relativePath: relativePathFor(digest),
    verifiedAt: clock.now(),
    created,
  });
}

function nonCanonicalEntry(parent: string, name: string): BlobStoreError {
  const entryPath = parent === "/" ? `/${name}` : join(parent, name);
  return new BlobStoreError(`non-canonical blob entry ${entryPath}`);
}

function hasErrorCode(error: unknown, code: string): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  const value = error.code;
  return typeof value === "string" && value === code;
}

class BlobStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BlobStoreError";
  }
}

class BlobNonRegularError extends BlobStoreError {}

export type BlobCorruptionErrorCode = "blob_corrupt";

export class BlobCorruptionError extends Error {
  readonly code: BlobCorruptionErrorCode = "blob_corrupt";
  readonly digest: ContentHash;
  constructor(digest: ContentHash, message: string, options?: ErrorOptions) {
    super(`${message}: ${digest}`, options);
    this.name = "BlobCorruptionError";
    this.digest = digest;
  }
}
