import { spawnSync } from "node:child_process";
import process from "node:process";

const baseRef = process.env.BUF_BREAKING_BASE_REF ?? "HEAD^";
const baseline = spawnSync("git", ["ls-tree", "-r", "--name-only", baseRef], { encoding: "utf8" });
if (baseline.error !== undefined) {
  throw baseline.error;
}
if (baseline.status !== 0) {
  process.stderr.write(baseline.stderr);
  process.exit(baseline.status ?? 1);
}

const hasProtobufBaseline = baseline.stdout
  .split("\n")
  .some((path) => path.startsWith("proto/") && path.endsWith(".proto"));
if (!hasProtobufBaseline) {
  process.stdout.write(
    `No Protobuf baseline exists at ${baseRef}; validating the initial schema with buf build.\n`,
  );
}
const command = hasProtobufBaseline ? ["breaking", "--against", `.git#ref=${baseRef}`] : ["build"];
const checked = spawnSync("buf", command, { stdio: "inherit" });
if (checked.error !== undefined) {
  throw checked.error;
}
if (checked.status !== 0) {
  process.exit(checked.status ?? 1);
}
