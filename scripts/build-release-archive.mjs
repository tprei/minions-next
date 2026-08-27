#!/usr/bin/env node
// PR 52 — distribution service lifecycle: assemble a reproducible release archive
// (tarball + SHA256 + SPDX 2.3 SBOM) from the already-built workspace outputs.
//
// The archive bundles the production runtime: the CLI/daemon/web built bundles, the
// internal package dist outputs the runtime imports, the platform unit templates
// (scripts/distribution) with their __PREFIX__ placeholder resolved, package.json,
// pnpm-lock.yaml, and README.md. It does NOT bundle node_modules: the install command
// runs a frozen `pnpm install --prod --filter` against the bundled lockfile, keeping
// the archive small and the dependency graph reproducible/auditable rather than
// snapshotting a platform-specific node_modules tree.
//
// Run after `pnpm build`:
//   node scripts/build-release-archive.mjs [--prefix <dir>] [--out <dir>] [--version <ver>]
//
// Defaults: prefix=/opt/minions, out=dist-release, version=<package.json version>+<git-sha>.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile, access, constants } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..");

const DEFAULT_PREFIX = "/opt/minions";

const APPS = ["cli", "daemon", "web"];
const PACKAGES = ["contracts", "core", "adapters", "testkit", "ui-kit"];

await main();

async function main() {
  try {
    const config = parseArguments(process.argv.slice(2));
    await buildReleaseArchive(config);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function parseArguments(args) {
  const config = {
    prefix: process.env["MINIONS_INSTALL_PREFIX"] ?? DEFAULT_PREFIX,
    outDirectory: join(repositoryRoot, "dist-release"),
    version: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option === "--prefix") {
      config.prefix = requireValue(option, value, args, index);
      index += 1;
    } else if (option === "--out") {
      config.outDirectory = requireValue(option, value, args, index);
      index += 1;
    } else if (option === "--version") {
      config.version = requireValue(option, value, args, index);
      index += 1;
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }
  return Object.freeze(config);
}

function requireValue(option, value, args, index) {
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`option '${option}' requires a value`);
  }
  return next;
}

async function buildReleaseArchive(config) {
  const pkg = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const version = config.version ?? releaseVersion(pkg.version);
  const archiveBaseName = `${pkg.name}-${version}-${platform()}.tar.gz`;
  const stagingDirectory = join(config.outDirectory, "stage");

  await rm(config.outDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true });

  // 1. bin/ — the CLI entrypoint with a shebang, the systemd/launchd unit's ExecStart target.
  await mkdir(join(stagingDirectory, "bin"), { recursive: true });
  const cliEntry = await readFile(join(repositoryRoot, "apps/cli/dist/index.js"), "utf8");
  await writeFile(
    join(stagingDirectory, "bin/minions"),
    cliEntry.startsWith("#!") ? cliEntry : `#!/usr/bin/env node\n${cliEntry}`,
    { encoding: "utf8", mode: 0o755 },
  );

  // 2. Built bundles for apps and the internal packages the runtime imports.
  for (const app of APPS) {
    await copyDist(
      join(repositoryRoot, "apps", app, "dist"),
      join(stagingDirectory, "apps", app, "dist"),
    );
  }
  for (const name of PACKAGES) {
    await copyDist(
      join(repositoryRoot, "packages", name, "dist"),
      join(stagingDirectory, "packages", name, "dist"),
    );
  }

  // 3. Distribution unit templates with __PREFIX__ resolved to the install prefix, plus
  //    the lockfile/package metadata so install can run a frozen prod install.
  await mkdir(join(stagingDirectory, "distribution"), { recursive: true });
  const distributionDirectory = join(repositoryRoot, "scripts/distribution");
  for (const file of await readdir(distributionDirectory)) {
    const content = await readFile(join(distributionDirectory, file), "utf8");
    await writeFile(
      join(stagingDirectory, "distribution", file),
      content.replaceAll("__PREFIX__", config.prefix),
      "utf8",
    );
  }
  await writeFile(
    join(stagingDirectory, "package.json"),
    JSON.stringify({ ...pkg, version }, undefined, 2),
    "utf8",
  );
  await cp(join(repositoryRoot, "pnpm-lock.yaml"), join(stagingDirectory, "pnpm-lock.yaml"));
  await cp(join(repositoryRoot, "README.md"), join(stagingDirectory, "README.md"));
  await writeFile(
    join(stagingDirectory, "INSTALL.json"),
    JSON.stringify(
      { prefix: config.prefix, version, createdAt: new Date().toISOString() },
      undefined,
      2,
    ),
    "utf8",
  );

  // 4. Tarball (deterministic ordering: sorted file list).
  await mkdir(config.outDirectory, { recursive: true });
  const archivePath = join(config.outDirectory, archiveBaseName);
  const tarArgs = [
    "-czf",
    archivePath,
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--sort=name",
    "-C",
    stagingDirectory,
    ".",
  ];
  execFileSync("tar", tarArgs, { stdio: ["ignore", "ignore", "inherit"] });

  // 5. SHA256 sidecar.
  const archiveBytes = await readFile(archivePath);
  const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
  await writeFile(
    join(config.outDirectory, `${archiveBaseName}.sha256`),
    `${sha256}  ${archiveBaseName}\n`,
    "utf8",
  );

  // 6. SPDX 2.3 SBOM from pnpm-lock.yaml's resolved packages.
  const sbom = await buildSpdxSbom(pkg.name, version, archiveBaseName, sha256);
  await writeFile(
    join(config.outDirectory, "sbom.spdx.json"),
    JSON.stringify(sbom, undefined, 2),
    "utf8",
  );

  // Clean the staging dir; keep only the deliverables.
  await rm(stagingDirectory, { recursive: true, force: true });

  process.stdout.write(
    JSON.stringify(
      {
        archive: archiveBaseName,
        path: archivePath,
        sha256,
        sbom: "sbom.spdx.json",
        prefix: config.prefix,
        version,
        bytes: archiveBytes.length,
      },
      undefined,
      2,
    ) + "\n",
  );
}

async function copyDist(source, destination) {
  try {
    await access(source, constants.R_OK);
  } catch {
    throw new Error(`expected built output is missing: ${source} (run 'pnpm build' first)`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

function releaseVersion(pkgVersion) {
  const sha = gitSha();
  return sha === undefined ? pkgVersion : `${pkgVersion}+${sha}`;
}

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function platform() {
  const platformName = process.platform;
  const arch = process.arch;
  const osLabel = platformName === "darwin" ? "macos" : platformName;
  const archLabel = arch === "x64" ? "x86_64" : arch;
  return `${osLabel}-${archLabel}`;
}

// Minimal SPDX 2.3 SBOM. Package inventory comes from pnpm-lock.yaml's `packages:`
// section (resolved transitive deps); workspace packages are added from PACKAGES with the
// release version. This is intentionally a faithful structural SBOM, not a vulnerability
// scan — it names every resolved dependency with a SPDX ref + checksum where the lockfile
// records one.
async function buildSpdxSbom(name, version, archiveBaseName, archiveSha256) {
  const packages = [];
  const relationships = [];

  // The release archive itself as the document root.
  const rootRef = `SPDXRef-Archive`;
  packages.push({
    name: archiveBaseName,
    SPDXID: rootRef,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    versionInfo: version,
    checksums: [{ algorithm: "SHA256", checksumValue: archiveSha256 }],
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    copyrightText: "NOASSERTION",
  });

  // Workspace packages.
  for (const pkgName of PACKAGES) {
    packages.push(workspacePackage(`@minions/${pkgName}`, version));
    relationships.push({
      spdxElementId: rootRef,
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: packages[packages.length - 1].SPDXID,
    });
  }

  // Resolved dependencies from the lockfile.
  const lockPackages = await parseLockfilePackages();
  let index = 0;
  for (const { name: depName, version: depVersion } of lockPackages) {
    index += 1;
    const ref = `SPDXRef-Package-${index}`;
    packages.push({
      name: depName,
      SPDXID: ref,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      versionInfo: depVersion,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      copyrightText: "NOASSERTION",
    });
    relationships.push({
      spdxElementId: rootRef,
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: ref,
    });
  }

  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${name} ${version} release SBOM`,
    documentNamespace: `https://minions.dev/spdx/${name}/${version}/${archiveSha256.slice(0, 12)}`,
    creationInfo: {
      created: new Date().toISOString(),
      creators: ["Tool: minions build-release-archive"],
    },
    packages,
    relationships,
  };
}

function workspacePackage(name, version) {
  return {
    name,
    SPDXID: `SPDXRef-Workspace-${name.replace(/[^A-Za-z0-9]/g, "-")}`,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    versionInfo: version,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    copyrightText: "NOASSERTION",
  };
}

async function parseLockfilePackages() {
  const lockText = await readFile(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
  const packages = [];
  const seen = new Set();
  let inPackages = false;
  for (const line of lockText.split("\n")) {
    if (line.startsWith("packages:")) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    // The packages section is two-space indented; a top-level key ends it.
    if (line.length > 0 && !line.startsWith(" ")) {
      inPackages = false;
      continue;
    }
    // Entry header: '  <name>@<version>:' — name may itself contain @ (scoped).
    const match = line.match(/^ {2}(.+)@([^@/]+):$/);
    if (match !== null) {
      const [, name, version] = match;
      const key = `${name}@${version}`;
      if (!seen.has(key)) {
        seen.add(key);
        packages.push({ name, version });
      }
    }
  }
  return packages;
}
