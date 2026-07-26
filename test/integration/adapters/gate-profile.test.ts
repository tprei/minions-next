import { rm, mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GateCategory } from "@minions/contracts";
import {
  assertProfileDoesNotWeaken,
  computeGateProfileHash,
  GateProfileError,
  loadGateProfile,
  parseGateProfile,
  profileWeakensBaseline,
  validateGateProfile,
  type HostGateMinimum,
} from "@minions/adapters";
import { describe, expect, it } from "vitest";

const VALID_PROFILE_YAML = `required_categories:
  - lint
  - typecheck
  - tests
  - build
gates:
  lint:
    executable: eslint
    args:
      - "--max-warnings"
      - "0"
      - "."
    env_allowlist:
      - NODE_ENV
  typecheck:
    executable: tsc
    args:
      - "--noEmit"
  tests:
    executable: vitest
    args:
      - run
  build:
    executable: tsc
    args:
      - "-b"
path_policy:
  allowed_paths:
    - "src/**"
  blocked_paths:
    - "**/*.env"
env_policy:
  allowed_keys:
    - NODE_ENV
    - PATH
  denied_keys:
    - GITHUB_TOKEN
network_policy:
  allowed_hosts: []
worktree_policy:
  weakening_permitted: false
`;

const REORDERED_PROFILE_YAML = `gates:
  build:
    executable: tsc
    args:
      - "-b"
  tests:
    executable: vitest
    args:
      - run
  typecheck:
    executable: tsc
    args:
      - "--noEmit"
  lint:
    executable: eslint
    args:
      - "--max-warnings"
      - "0"
      - "."
    env_allowlist:
      - NODE_ENV
required_categories:
  - build
  - tests
  - typecheck
  - lint
path_policy:
  blocked_paths:
    - "**/*.env"
  allowed_paths:
    - "src/**"
env_policy:
  denied_keys:
    - GITHUB_TOKEN
  allowed_keys:
    - PATH
    - NODE_ENV
network_policy:
  allowed_hosts: []
worktree_policy:
  weakening_permitted: false
`;

const PROFILE_WITHOUT_BUILD_YAML = `required_categories:
  - lint
  - typecheck
  - tests
gates:
  lint:
    executable: eslint
    args:
      - "."
  typecheck:
    executable: tsc
    args:
      - "--noEmit"
  tests:
    executable: vitest
    args:
      - run
path_policy:
  allowed_paths:
    - "src/**"
  blocked_paths:
    - "**/*.env"
env_policy:
  allowed_keys:
    - NODE_ENV
    - PATH
  denied_keys:
    - GITHUB_TOKEN
network_policy:
  allowed_hosts: []
worktree_policy:
  weakening_permitted: false
`;

const PROFILE_WITH_SECURITY_REVIEW_YAML = `required_categories:
  - lint
  - typecheck
  - tests
  - build
  - security_review
gates:
  lint:
    executable: eslint
    args:
      - "."
  typecheck:
    executable: tsc
    args:
      - "--noEmit"
  tests:
    executable: vitest
    args:
      - run
  build:
    executable: tsc
    args:
      - "-b"
  security_review:
    executable: audit-ci
    args:
      - "--moderate"
path_policy:
  allowed_paths:
    - "src/**"
  blocked_paths:
    - "**/*.env"
env_policy:
  allowed_keys:
    - NODE_ENV
    - PATH
  denied_keys:
    - GITHUB_TOKEN
network_policy:
  allowed_hosts: []
worktree_policy:
  weakening_permitted: false
`;

const HOST_MINIMUM: HostGateMinimum = Object.freeze({
  requiredCategories: [GateCategory.LINT, GateCategory.TYPECHECK, GateCategory.TESTS],
  allowedNetworkHosts: [],
  worktreeWeakeningPermitted: false,
  blockedPaths: [],
  deniedEnvKeys: [],
});

const HOST_MINIMUM_STRICT: HostGateMinimum = Object.freeze({
  requiredCategories: [
    GateCategory.LINT,
    GateCategory.TYPECHECK,
    GateCategory.TESTS,
    GateCategory.BUILD,
  ],
  allowedNetworkHosts: [],
  worktreeWeakeningPermitted: false,
  blockedPaths: ["**/*.env"],
  deniedEnvKeys: ["GITHUB_TOKEN"],
});

async function withRepoDir<T>(yaml: string, operation: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "minions-gate-"));
  await mkdir(join(dir, ".minions"), { recursive: true });
  await writeFile(join(dir, ".minions", "gates.yaml"), yaml, "utf8");
  try {
    return await operation(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function expectErrorCode(yaml: string, code: string, hostMinimum?: HostGateMinimum): void {
  try {
    parseGateProfile(yaml, hostMinimum);
    throw new Error(`expected GateProfileError with code "${code}" but parsing succeeded`);
  } catch (error) {
    if (error instanceof GateProfileError) {
      expect(error.code).toBe(code);
      return;
    }
    throw error;
  }
}

describe("gate profile loading and validation", () => {
  it("loads a valid profile and computes a deterministic hash", async () => {
    await withRepoDir(VALID_PROFILE_YAML, async (dir) => {
      const loaded = await loadGateProfile(dir);
      expect(loaded.profile.requiredCategories).toEqual([
        GateCategory.LINT,
        GateCategory.TYPECHECK,
        GateCategory.TESTS,
        GateCategory.BUILD,
      ]);
      expect(loaded.profile.gates).toHaveLength(4);
      expect(loaded.profile.worktreePolicy.weakeningPermitted).toBe(false);
      expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/u);
      expect(loaded.profile.profileHash).toBe(loaded.hash);
    });
  });

  it("produces the same hash for identical content regardless of key order", () => {
    const a = parseGateProfile(VALID_PROFILE_YAML);
    const b = parseGateProfile(REORDERED_PROFILE_YAML);
    expect(a.hash).toBe(b.hash);
  });

  it("produces a different hash when content differs", () => {
    const a = parseGateProfile(VALID_PROFILE_YAML);
    const b = parseGateProfile(PROFILE_WITHOUT_BUILD_YAML);
    expect(a.hash).not.toBe(b.hash);
  });

  it("fails closed when .minions/gates.yaml is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "minions-gate-empty-"));
    try {
      await expect(loadGateProfile(dir)).rejects.toMatchObject({
        name: "GateProfileError",
        code: "missing",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed YAML", () => {
    expectErrorCode("required_categories: [lint\n  - bad", "malformed_yaml");
  });

  it("rejects an empty file", () => {
    expectErrorCode("", "malformed_yaml");
    expectErrorCode("   \n  \n", "malformed_yaml");
  });
});

describe("gate profile structured command enforcement", () => {
  it("rejects shell-string executables", () => {
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: "eslint . && npm run lint"
    args: ["."]
`,
      "shell_command",
    );
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: "eslint|cat"
    args: ["."]
`,
      "shell_command",
    );
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: "eslint; rm -rf /"
    args: ["."]
`,
      "shell_command",
    );
  });

  it("rejects unknown top-level YAML fields", () => {
    expectErrorCode(VALID_PROFILE_YAML + "unknown_section: true\n", "unknown_field");
  });

  it("rejects unknown fields inside gate commands", () => {
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
    shell: bash
`,
      "unknown_field",
    );
  });

  it("rejects unknown fields inside path_policy", () => {
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
path_policy:
  allowed_paths: ["src/**"]
  extra_field: true
`,
      "unknown_field",
    );
  });

  it("rejects unknown category names in required_categories", () => {
    expectErrorCode(
      `required_categories: [not_a_real_category]
gates:
  lint:
    executable: eslint
    args: ["."]
`,
      "invalid",
    );
  });
});

describe("gate profile category coverage", () => {
  it("rejects when a required category has no gate", () => {
    expectErrorCode(
      `required_categories: [lint, typecheck]
gates:
  lint:
    executable: eslint
    args: ["."]
`,
      "missing_category",
    );
  });

  it("rejects empty required_categories", () => {
    expectErrorCode(
      `required_categories: []
gates:
  lint:
    executable: eslint
    args: ["."]
`,
      "missing_category",
    );
  });

  it("rejects duplicate required categories", () => {
    expectErrorCode(
      `required_categories: [lint, lint]
gates:
  lint:
    executable: eslint
    args: ["."]
`,
      "invalid",
    );
  });
});

describe("gate profile path safety", () => {
  it("rejects absolute paths in allowed_paths", () => {
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
path_policy:
  allowed_paths: ["/etc/passwd"]
`,
      "unsafe_path",
    );
  });

  it("rejects home-directory paths in allowed_paths", () => {
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
path_policy:
  allowed_paths: ["~/.ssh/id_rsa"]
`,
      "unsafe_path",
    );
  });

  it("rejects parent-traversal paths in allowed_paths", () => {
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
path_policy:
  allowed_paths: ["../../../etc/shadow"]
`,
      "unsafe_path",
    );
  });
});

describe("gate profile env safety", () => {
  it("rejects credential-bearing keys in env_policy.allowed_keys", () => {
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
env_policy:
  allowed_keys: [NODE_ENV, AWS_SECRET_ACCESS_KEY]
`,
      "unsafe_env",
    );
  });

  it("rejects token keys in env_policy.allowed_keys", () => {
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
env_policy:
  allowed_keys: [NODE_ENV, GITHUB_TOKEN]
`,
      "unsafe_env",
    );
  });

  it("rejects credential keys in gate env_allowlist", () => {
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
    env_allowlist: [DATABASE_PASSWORD]
`,
      "unsafe_env",
    );
  });
});

describe("gate profile network safety", () => {
  it("rejects the AWS metadata endpoint", () => {
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
network_policy:
  allowed_hosts: ["169.254.169.254"]
`,
      "unsafe_network",
    );
  });

  it("rejects the GCP metadata endpoint", () => {
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
network_policy:
  allowed_hosts: ["metadata.google.internal"]
`,
      "unsafe_network",
    );
  });

  it("rejects link-local addresses", () => {
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
network_policy:
  allowed_hosts: ["169.254.170.2"]
`,
      "unsafe_network",
    );
  });
});

describe("gate profile host-minimum enforcement", () => {
  it("accepts a profile that meets the host minimum", () => {
    const loaded = parseGateProfile(VALID_PROFILE_YAML, HOST_MINIMUM);
    expect(loaded.profile.requiredCategories).toContain(GateCategory.LINT);
  });

  it("rejects a profile that removes a host-minimum required category", () => {
    expectErrorCode(PROFILE_WITHOUT_BUILD_YAML, "weakens_host_minimum", {
      ...HOST_MINIMUM_STRICT,
    });
  });

  it("rejects a profile that opens network beyond the host minimum", () => {
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
network_policy:
  allowed_hosts: ["registry.npmjs.org"]
`,
      "weakens_host_minimum",
      HOST_MINIMUM,
    );
  });

  it("rejects a profile that permits worktree weakening against the host minimum", () => {
    expectErrorCode(
      `required_categories: [lint, typecheck, tests]
gates:
  lint:
    executable: eslint
    args: ["."]
  typecheck:
    executable: tsc
    args: ["--noEmit"]
  tests:
    executable: vitest
    args: [run]
worktree_policy:
  weakening_permitted: true
`,
      "worktree_weakening",
      HOST_MINIMUM,
    );
  });

  it("rejects a profile that drops a host-minimum blocked path", () => {
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
path_policy:
  blocked_paths: []
`,
      "weakens_host_minimum",
      HOST_MINIMUM_STRICT,
    );
  });

  it("rejects a profile that drops a host-minimum denied env key", () => {
    expectErrorCode(
      `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
env_policy:
  denied_keys: []
`,
      "weakens_host_minimum",
      HOST_MINIMUM_STRICT,
    );
  });
});

describe("gate profile snapshot and immutability", () => {
  it("a valid worktree copy whose hash matches the snapshot is accepted", () => {
    const baseline = parseGateProfile(VALID_PROFILE_YAML);
    expect(computeGateProfileHash(baseline.profile)).toBe(baseline.hash);
    assertProfileDoesNotWeaken(baseline.profile, baseline.profile);
  });

  it("a worktree copy that removes a gate weakens the snapshot and is rejected", () => {
    const baseline = parseGateProfile(VALID_PROFILE_YAML);
    const weakened = parseGateProfile(PROFILE_WITHOUT_BUILD_YAML);
    expect(profileWeakensBaseline(weakened.profile, baseline.profile)).toBe(true);
    expect(() => {
      assertProfileDoesNotWeaken(weakened.profile, baseline.profile);
    }).toThrow(GateProfileError);
    try {
      assertProfileDoesNotWeaken(weakened.profile, baseline.profile);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GateProfileError);
      expect((error as GateProfileError).code).toBe("worktree_weakening");
    }
  });

  it("a worktree copy that opens network weakens the snapshot and is rejected", () => {
    const baseline = parseGateProfile(VALID_PROFILE_YAML);
    const weakened = parseGateProfile(
      `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
network_policy:
  allowed_hosts: ["evil.example.com"]
`,
    );
    expect(profileWeakensBaseline(weakened.profile, baseline.profile)).toBe(true);
  });

  it("a worktree copy that permits weakening weakens the snapshot and is rejected", () => {
    const baseline = parseGateProfile(VALID_PROFILE_YAML);
    const weakened = parseGateProfile(
      `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
worktree_policy:
  weakening_permitted: true
`,
    );
    expect(profileWeakensBaseline(weakened.profile, baseline.profile)).toBe(true);
  });

  it("a worktree copy that strengthens (adds a gate) does NOT weaken and is accepted", () => {
    const baseline = parseGateProfile(VALID_PROFILE_YAML);
    const strengthened = parseGateProfile(PROFILE_WITH_SECURITY_REVIEW_YAML);
    expect(profileWeakensBaseline(strengthened.profile, baseline.profile)).toBe(false);
    assertProfileDoesNotWeaken(strengthened.profile, baseline.profile);
  });

  it("the active gate set remains at the snapshot even when the worktree strengthens", () => {
    const snapshot = parseGateProfile(VALID_PROFILE_YAML);
    const worktree = parseGateProfile(PROFILE_WITH_SECURITY_REVIEW_YAML);
    expect(worktree.hash).not.toBe(snapshot.hash);
    expect(profileWeakensBaseline(worktree.profile, snapshot.profile)).toBe(false);
    expect(computeGateProfileHash(snapshot.profile)).toBe(snapshot.hash);
  });
});

describe("gate profile base-policy change applies only to a new tree", () => {
  it("an existing tree keeps its snapshot; a new tree gets the updated policy", () => {
    const treeOneSnapshot = parseGateProfile(VALID_PROFILE_YAML);
    const treeTwoSnapshot = parseGateProfile(PROFILE_WITH_SECURITY_REVIEW_YAML);
    expect(treeOneSnapshot.hash).not.toBe(treeTwoSnapshot.hash);
    expect(treeOneSnapshot.profile.requiredCategories).not.toContain(GateCategory.SECURITY_REVIEW);
    expect(treeTwoSnapshot.profile.requiredCategories).toContain(GateCategory.SECURITY_REVIEW);
    expect(computeGateProfileHash(treeOneSnapshot.profile)).toBe(treeOneSnapshot.hash);
  });
});

describe("gate profile validateGateProfile round-trips through proto", () => {
  it("re-validates a loaded profile and recomputes the same hash", () => {
    const loaded = parseGateProfile(VALID_PROFILE_YAML);
    const validated = validateGateProfile(loaded.profile);
    expect(computeGateProfileHash(validated)).toBe(loaded.hash);
  });

  it("a profile with defaults applied (missing optional policies) still validates", () => {
    const minimalYaml = `required_categories: [lint]
gates:
  lint:
    executable: eslint
    args: ["."]
`;
    const loaded = parseGateProfile(minimalYaml);
    expect(loaded.profile.networkPolicy.allowedHosts).toEqual([]);
    expect(loaded.profile.worktreePolicy.weakeningPermitted).toBe(false);
    expect(loaded.profile.pathPolicy.allowedPaths).toEqual([]);
    expect(loaded.profile.envPolicy.deniedKeys).toEqual([]);
    expect(loaded.hash).toMatch(/^[0-9a-f]{64}$/u);
  });
});
