import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationRoot = join(repositoryRoot, "packages/adapters/migrations");
const generatedPath = join(repositoryRoot, "packages/adapters/src/sqlite/generated-migrations.ts");
const documentationPath = join(repositoryRoot, "docs/2026-07-13-sqlite-schema.md");
const databaseKinds = ["host", "supervisor"];
const migrationFilePattern = /^(\d{4})_([a-z0-9_]+)\.sql$/u;

const migrationsByKind = Object.fromEntries(
  databaseKinds.map((kind) => [kind, readMigrations(kind)]),
);
const outputs = new Map([
  [generatedPath, renderGeneratedModule(migrationsByKind)],
  [documentationPath, renderDocumentation(migrationsByKind)],
]);

if (process.argv.includes("--check")) {
  const stalePaths = [...outputs].flatMap(([path, expected]) => {
    if (!existsSync(path)) {
      return [path];
    }
    return readFileSync(path, "utf8") === expected ? [] : [path];
  });
  if (stalePaths.length > 0) {
    process.stderr.write("Generated SQLite schema artifacts are out of date:\n");
    for (const path of stalePaths) {
      process.stderr.write(`${path}\n`);
    }
    process.exit(1);
  }
  process.exit(0);
}

for (const [path, content] of outputs) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function readMigrations(kind) {
  const directory = join(migrationRoot, kind);
  const migrations = readdirSync(directory)
    .map((fileName) => {
      const match = migrationFilePattern.exec(fileName);
      if (match === null) {
        throw new Error(`invalid ${kind} migration file name: ${fileName}`);
      }
      const versionText = match[1];
      const name = match[2];
      if (versionText === undefined || name === undefined) {
        throw new Error(`failed to parse ${kind} migration file name: ${fileName}`);
      }
      const source = readFileSync(join(directory, fileName), "utf8").replace(/\r\n?/gu, "\n");
      const sql = `${source.trimEnd()}\n`;
      return {
        version: Number.parseInt(versionText, 10),
        name,
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    })
    .sort((left, right) => left.version - right.version);

  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `${kind} migrations must be contiguous from version 1; expected ${expectedVersion}, found ${migration.version}`,
      );
    }
  }
  if (migrations.length === 0) {
    throw new Error(`${kind} requires at least one migration`);
  }
  return migrations;
}

function renderGeneratedModule(migrations) {
  const sections = ['import type { SqliteMigration } from "./migration.js";', ""];
  for (const kind of databaseKinds) {
    const variableName = `${kind}Migrations`;
    sections.push(`export const ${variableName} = Object.freeze([`);
    for (const migration of migrations[kind]) {
      sections.push("  Object.freeze({");
      sections.push(`    version: ${migration.version},`);
      sections.push(`    name: ${JSON.stringify(migration.name)},`);
      sections.push(`    checksum: ${JSON.stringify(migration.checksum)},`);
      sections.push(`    sql: \`${escapeTemplateLiteral(migration.sql)}\`,`);
      sections.push("  }),");
    }
    sections.push(`]) satisfies readonly SqliteMigration[];`, "");
  }
  sections.push(
    "export const migrationsByDatabaseKind = Object.freeze({",
    "  host: hostMigrations,",
    "  supervisor: supervisorMigrations,",
    "});",
    "",
  );
  return sections.join("\n");
}

function renderDocumentation(migrations) {
  const sections = [
    "# SQLite schema",
    "",
    "This file is generated from the canonical forward-only SQL migrations. Run `pnpm generate` after changing a migration.",
    "",
  ];
  for (const kind of databaseKinds) {
    sections.push(`## ${capitalize(kind)} database`, "");
    for (const migration of migrations[kind]) {
      const version = String(migration.version).padStart(4, "0");
      sections.push(
        `### ${version} ${migration.name}`,
        "",
        `SHA-256: \`${migration.checksum}\``,
        "",
        "```sql",
        migration.sql.trimEnd(),
        "```",
        "",
      );
    }
  }
  return sections.join("\n");
}

function escapeTemplateLiteral(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
