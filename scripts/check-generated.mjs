import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const generatedRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/contracts/src/gen",
);
const before = snapshot(generatedRoot);
const generated = spawnSync("buf", ["generate"], { stdio: "inherit" });
if (generated.error !== undefined) {
  throw generated.error;
}
if (generated.status !== 0) {
  process.exit(generated.status ?? 1);
}

const after = snapshot(generatedRoot);
const changedPaths = [...new Set([...before.keys(), ...after.keys()])]
  .filter((path) => before.get(path) !== after.get(path))
  .sort();
if (changedPaths.length > 0) {
  process.stderr.write("Generated Protobuf contracts are out of date:\n");
  for (const path of changedPaths) {
    process.stderr.write(`${path}\n`);
  }
  process.exit(1);
}
const sqliteGenerated = spawnSync(
  process.execPath,
  [resolve(dirname(fileURLToPath(import.meta.url)), "generate-sqlite-schema.mjs"), "--check"],
  { stdio: "inherit" },
);
if (sqliteGenerated.error !== undefined) {
  throw sqliteGenerated.error;
}
if (sqliteGenerated.status !== 0) {
  process.exit(sqliteGenerated.status ?? 1);
}

function snapshot(root) {
  const files = new Map();
  if (!existsSync(root)) {
    return files;
  }

  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) {
      throw new Error("generated contract directory traversal failed");
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (entry.isFile()) {
        files.set(
          relative(root, path),
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        );
      }
    }
  }
  return files;
}
