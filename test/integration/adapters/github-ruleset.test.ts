import { createVerify, generateKeyPairSync } from "node:crypto";

import {
  createGitHubAppAuth,
  GitHubRulesetError,
  inspectRuleset,
  installRuleset,
  detectDrift,
  resolveEngineBotIdentity,
  onboardRepository,
  REQUIRED_REVIEW_POLICY,
  scanForSecrets,
  type CredentialVault,
  type CredentialVaultProbeResult,
  type GitHubFetch,
} from "@minions/adapters";
import { describe, expect, it } from "vitest";

/**
 * Integration test for PR 31 GitHub App auth + ruleset enforcement. Drives the
 * ruleset classifier through a MOCK GitHub REST API (no real network). The mock
 * `fetch` is a stateful in-memory GitHub that the test configures per scenario:
 *
 * - inspectRuleset: enforceable → OK; missing → ruleset_missing; engine eligible
 *   (engine App granted a bypass) → engine_eligible; stale reviews not dismissed
 *   → ruleset_weak.
 * - installRuleset: create (absent) + update (present-but-mismatched) → receipt.
 * - detectDrift: rule removed → drift_detected; engine added → engine_eligible;
 *   clean → ok.
 * - resolveEngineBotIdentity: returns the App slug + bot login + ids.
 * - Token rotation: advancing the clock past the cached token's skew forces a new
 *   installation token mint.
 * - No credential leak: the App PEM private key never appears in any captured
 *   fetch URL/header/body, and `scanForSecrets` finds zero hits.
 *
 * The mock does NOT validate the App JWT cryptographically here — that is covered
 * by the explicit `createVerify` round-trip in the JWT suite below, which proves
 * the auth signs RS256 JWTs from the vault-held private key.
 */

const APP_ID = 123456;
const APP_SLUG = "minions-engine";
const BOT_LOGIN = "minions-engine[bot]";
const BOT_USER_ID = 9876543;
const INSTALLATION_ID = 555;
const REPO = "acme/landing-app";

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();

/** A distinctive substring of the PEM body used for leak assertions. */
const privateKeyMarker = privateKeyPem.split("\n").find((line) => line.length > 40) ?? "";

// -------------------------------------------------------------------------------------------------
// In-memory vault + mock GitHub.
// -------------------------------------------------------------------------------------------------

class MemoryVault implements CredentialVault {
  readonly backend = "systemd-creds" as const;
  private readonly store = new Map<string, Uint8Array>();

  probe(): CredentialVaultProbeResult {
    return { available: true, backend: this.backend, detail: "memory" };
  }
  put(name: string, secret: Uint8Array): Promise<void> {
    this.store.set(name, new Uint8Array(secret));
    return Promise.resolve();
  }
  get(name: string): Promise<Uint8Array> {
    const value = this.store.get(name);
    if (value === undefined) {
      throw new Error(`credential not found: ${name}`);
    }
    return Promise.resolve(new Uint8Array(value));
  }
  delete(name: string): Promise<void> {
    this.store.delete(name);
    return Promise.resolve();
  }
}

interface PullRequestParams {
  readonly requiredApprovingReviewCount: number;
  readonly dismissStaleReviewsOnPush: boolean;
  readonly requireCodeOwnerReviews: boolean;
  readonly requireLastPushApproval: boolean;
  readonly requiredReviewThreadResolution: boolean;
}

const enforceableParams: PullRequestParams = {
  requiredApprovingReviewCount: 1,
  dismissStaleReviewsOnPush: true,
  requireCodeOwnerReviews: false,
  requireLastPushApproval: true,
  requiredReviewThreadResolution: false,
};

function pullRequestRule(params: PullRequestParams): Readonly<Record<string, unknown>> {
  return {
    type: "pull_request",
    parameters: {
      required_approving_review_count: params.requiredApprovingReviewCount,
      dismiss_stale_reviews_on_push: params.dismissStaleReviewsOnPush,
      require_code_owner_reviews: params.requireCodeOwnerReviews,
      require_last_push_approval: params.requireLastPushApproval,
      required_review_thread_resolution: params.requiredReviewThreadResolution,
    },
  };
}

interface RulesetSeed {
  readonly id: number;
  readonly name: string;
  readonly rules: readonly Readonly<Record<string, unknown>>[];
  readonly bypassActors?: readonly Readonly<Record<string, unknown>>[];
  readonly enforcement?: string;
}

function serializeRuleset(seed: RulesetSeed): Readonly<Record<string, unknown>> {
  return {
    id: seed.id,
    name: seed.name,
    target: "branch",
    source_type: "Repository",
    enforcement: seed.enforcement ?? "active",
    rules: [...seed.rules],
    bypass_actors: [...(seed.bypassActors ?? [])],
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function engineBypassActor(): Readonly<Record<string, unknown>> {
  return { actor_id: APP_ID, actor_type: "Integration", bypass_mode: "always" };
}

interface FetchRecord {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
  readonly body: string;
}

class MockGitHub {
  private readonly rulesets = new Map<number, Readonly<Record<string, unknown>>>();
  private nextRulesetId = 1000;
  private tokenCounter = 0;
  readonly records: FetchRecord[] = [];
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  reset(seeds: readonly RulesetSeed[]): void {
    this.rulesets.clear();
    this.records.length = 0;
    for (const seed of seeds) {
      this.rulesets.set(seed.id, serializeRuleset(seed));
    }
  }

  /** Total times the installation-token endpoint was hit (rotation counter). */
  installationTokenMints(): number {
    return this.tokenCounter;
  }

  readonly fetch: GitHubFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization") ?? "";
    const body = typeof init?.body === "string" ? init.body : "";
    this.records.push({ method, url, authorization, body });
    return Promise.resolve(this.route(method, url, body));
  };

  private route(method: string, url: string, body: string): Response {
    if (method === "GET" && url.endsWith("/app")) {
      return jsonResponse({ id: APP_ID, slug: APP_SLUG, name: "Minions Engine" });
    }
    if (method === "GET" && url.includes(`/users/${BOT_LOGIN}`)) {
      return jsonResponse({ id: BOT_USER_ID, login: BOT_LOGIN, type: "Bot" });
    }
    if (method === "GET" && url.includes(`/repos/${REPO}/installation`)) {
      return jsonResponse({ id: INSTALLATION_ID, app_id: APP_ID, app_slug: APP_SLUG });
    }
    if (
      method === "POST" &&
      url.includes(`/app/installations/${String(INSTALLATION_ID)}/access_tokens`)
    ) {
      this.tokenCounter += 1;
      return jsonResponse({
        token: `ghs_install_token_${String(this.tokenCounter)}`,
        expires_at: new Date(this.now() + 60 * 60 * 1000).toISOString(),
        permissions: { administration: "read", pull_requests: "write" },
        repositories: [{ id: 4242, full_name: REPO }],
      });
    }
    const detailMatch = /\/repos\/[^/]+\/[^/]+\/rulesets\/(\d+)/u.exec(url);
    if (method === "GET" && detailMatch !== null) {
      const id = Number.parseInt(detailMatch[1] ?? "", 10);
      const detail = this.rulesets.get(id);
      if (detail === undefined) {
        return new Response("not found", { status: 404 });
      }
      return jsonResponse(detail);
    }
    if (method === "GET" && /\/repos\/[^/]+\/[^/]+\/rulesets\/?(\?.*)?$/u.test(url)) {
      return jsonResponse([...this.rulesets.values()]);
    }
    if (method === "POST" && url.includes(`/repos/${REPO}/rulesets`)) {
      const id = this.nextRulesetId;
      this.nextRulesetId += 1;
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const created = { ...serializeRuleset({ id, name: "x", rules: [] }), ...parsed, id };
      this.rulesets.set(id, created);
      return jsonResponse(created);
    }
    if (method === "PUT") {
      const match = /\/rulesets\/(\d+)$/u.exec(url);
      if (match !== null && url.includes(`/repos/${REPO}/rulesets`)) {
        const id = Number.parseInt(match[1] ?? "", 10);
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const updated = { ...(this.rulesets.get(id) ?? {}), ...parsed, id };
        this.rulesets.set(id, updated);
        return jsonResponse(updated);
      }
    }
    return new Response(`mock: unhandled ${method} ${url}`, { status: 500 });
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function buildAuth(now: () => number, mock: MockGitHub) {
  const vault = new MemoryVault();
  void vault.put("github-app.private-key", new TextEncoder().encode(privateKeyPem));
  return createGitHubAppAuth({
    vault,
    privateKeyCredentialName: "github-app.private-key",
    appId: APP_ID,
    fetch: mock.fetch,
    now,
    refreshSkewMs: 5 * 60 * 1000,
  });
}

// -------------------------------------------------------------------------------------------------
// JWT signing correctness (proves the auth materialises RS256 from the vault key).
// -------------------------------------------------------------------------------------------------

describe("github-app-auth JWT", () => {
  it("signs an RS256 JWT from the vault private key with iss=appId", async () => {
    const now = () => 1_700_000_000_000;
    const mock = new MockGitHub(now);
    const auth = buildAuth(now, mock);
    const client = await auth.appClient();
    // getApp triggers a JWT-bearing request; capture the Authorization header.
    await client.getApp();
    const appCall = mock.records.find((record) => record.url.endsWith("/app"));
    expect(appCall).toBeDefined();
    const header = appCall?.authorization ?? "";
    expect(header.startsWith("Bearer ")).toBe(true);
    const jwt = header.slice("Bearer ".length);
    const parts = jwt.split(".");
    const headerPart = parts[0] ?? "";
    const payloadPart = parts[1] ?? "";
    const signature = parts[2] ?? "";
    expect(parts[0]).toBeDefined();
    expect(parts[1]).toBeDefined();
    expect(parts[2]).toBeDefined();
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
      iss: number;
      iat: number;
      exp: number;
    };
    expect(payload.iss).toBe(APP_ID);
    // Verify the signature with the matching public key.
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerPart}.${payloadPart}`, "utf8");
    expect(verifier.verify(publicKeyPem, Buffer.from(signature, "base64url"))).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
// inspectRuleset
// -------------------------------------------------------------------------------------------------

describe("inspectRuleset", () => {
  it("classifies an enforceable ruleset as enforceable", async () => {
    const now = () => 1_700_000_000_000;
    const mock = new MockGitHub(now);
    mock.reset([
      {
        id: 10,
        name: "minions-independent-review",
        rules: [pullRequestRule(enforceableParams)],
      },
    ]);
    const auth = buildAuth(now, mock);
    const report = await inspectRuleset(auth, REPO);
    expect(report.classification).toBe("enforceable");
    expect(report.findings).toHaveLength(0);
    expect(report.matchedRuleset?.id).toBe(10);
  });

  it("classifies a missing ruleset as ruleset_missing", async () => {
    const now = () => 1_700_000_000_000;
    const mock = new MockGitHub(now);
    mock.reset([]);
    const auth = buildAuth(now, mock);
    const report = await inspectRuleset(auth, REPO);
    expect(report.classification).toBe("ruleset_missing");
    expect(report.findings.some((finding) => finding.kind === "missing_pull_request_rule")).toBe(
      true,
    );
  });

  it("classifies an engine-bypass grant as engine_eligible", async () => {
    const now = () => 1_700_000_000_000;
    const mock = new MockGitHub(now);
    mock.reset([
      {
        id: 11,
        name: "review",
        rules: [pullRequestRule(enforceableParams)],
        bypassActors: [engineBypassActor()],
      },
    ]);
    const auth = buildAuth(now, mock);
    const report = await inspectRuleset(auth, REPO);
    expect(report.classification).toBe("engine_eligible");
    expect(report.findings.some((finding) => finding.kind === "engine_bypass_granted")).toBe(true);
  });

  it("classifies stale reviews not dismissed as ruleset_weak", async () => {
    const now = () => 1_700_000_000_000;
    const mock = new MockGitHub(now);
    mock.reset([
      {
        id: 12,
        name: "review",
        rules: [pullRequestRule({ ...enforceableParams, dismissStaleReviewsOnPush: false })],
      },
    ]);
    const auth = buildAuth(now, mock);
    const report = await inspectRuleset(auth, REPO);
    expect(report.classification).toBe("ruleset_weak");
    expect(report.findings.some((finding) => finding.kind === "stale_reviews_not_dismissed")).toBe(
      true,
    );
  });
});

// -------------------------------------------------------------------------------------------------
// installRuleset
// -------------------------------------------------------------------------------------------------

describe("installRuleset", () => {
  it("creates the required ruleset when absent", async () => {
    const now = () => 1_700_000_000_000;
    const mock = new MockGitHub(now);
    mock.reset([]);
    const auth = buildAuth(now, mock);
    const receipt = await installRuleset(auth, REPO);
    expect(receipt.action).toBe("created");
    expect(receipt.policy).toEqual(REQUIRED_REVIEW_POLICY);
    expect(receipt.classification).toBe("enforceable");
    const created = mock.records.find(
      (record) => record.method === "POST" && record.url.includes(`/repos/${REPO}/rulesets`),
    );
    expect(created).toBeDefined();
  });

  it("updates the ruleset when present but mismatched", async () => {
    const now = () => 1_700_000_000_000;
    const mock = new MockGitHub(now);
    mock.reset([
      {
        id: 20,
        name: "minions-independent-review",
        rules: [pullRequestRule({ ...enforceableParams, requiredApprovingReviewCount: 0 })],
      },
    ]);
    const auth = buildAuth(now, mock);
    const receipt = await installRuleset(auth, REPO);
    expect(receipt.action).toBe("updated");
    expect(receipt.ruleset.id).toBe(20);
    expect(receipt.classification).toBe("enforceable");
    const updated = mock.records.find((record) => record.method === "PUT");
    expect(updated).toBeDefined();
  });

  it("leaves a matching ruleset unchanged", async () => {
    const now = () => 1_700_000_000_000;
    const mock = new MockGitHub(now);
    mock.reset([
      {
        id: 21,
        name: "minions-independent-review",
        rules: [pullRequestRule(enforceableParams)],
      },
    ]);
    const auth = buildAuth(now, mock);
    const receipt = await installRuleset(auth, REPO);
    expect(receipt.action).toBe("unchanged");
    expect(receipt.classification).toBe("enforceable");
  });
});

// -------------------------------------------------------------------------------------------------
// detectDrift
// -------------------------------------------------------------------------------------------------

describe("detectDrift", () => {
  it("reports drift_detected when the review rule is removed", async () => {
    const now = () => 1_700_000_000_000;
    const mock = new MockGitHub(now);
    mock.reset([
      {
        id: 30,
        name: "minions-independent-review",
        rules: [{ type: "required_status_checks", parameters: {} }],
      },
    ]);
    const auth = buildAuth(now, mock);
    const drift = await detectDrift(auth, REPO);
    expect(drift.status).toBe("drift_detected");
    expect(drift.findings.some((finding) => finding.kind === "rule_removed")).toBe(true);
  });

  it("reports engine_eligible when the engine is granted a bypass", async () => {
    const now = () => 1_700_000_000_000;
    const mock = new MockGitHub(now);
    mock.reset([
      {
        id: 31,
        name: "review",
        rules: [pullRequestRule(enforceableParams)],
        bypassActors: [engineBypassActor()],
      },
    ]);
    const auth = buildAuth(now, mock);
    const drift = await detectDrift(auth, REPO);
    expect(drift.status).toBe("engine_eligible");
    expect(drift.findings.some((finding) => finding.kind === "engine_bypass_granted")).toBe(true);
  });

  it("reports ok when the ruleset is clean", async () => {
    const now = () => 1_700_000_000_000;
    const mock = new MockGitHub(now);
    mock.reset([
      {
        id: 32,
        name: "review",
        rules: [pullRequestRule(enforceableParams)],
      },
    ]);
    const auth = buildAuth(now, mock);
    const drift = await detectDrift(auth, REPO);
    expect(drift.status).toBe("ok");
    expect(drift.findings).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------------
// resolveEngineBotIdentity + onboarding
// -------------------------------------------------------------------------------------------------

describe("resolveEngineBotIdentity", () => {
  it("returns the App slug, bot login, and ids", async () => {
    const now = () => 1_700_000_000_000;
    const mock = new MockGitHub(now);
    const auth = buildAuth(now, mock);
    const identity = await resolveEngineBotIdentity(auth);
    expect(identity.appId).toBe(APP_ID);
    expect(identity.appSlug).toBe(APP_SLUG);
    expect(identity.botLogin).toBe(BOT_LOGIN);
    expect(identity.botUserId).toBe(BOT_USER_ID);
  });
});

describe("onboardRepository", () => {
  it("installs the policy and lands an enforceable repository", async () => {
    const now = () => 1_700_000_000_000;
    const mock = new MockGitHub(now);
    mock.reset([]);
    const auth = buildAuth(now, mock);
    const receipt = await onboardRepository(auth, REPO);
    expect(receipt.classification).toBe("enforceable");
    expect(receipt.installReceipt.action).toBe("created");
  });

  it("fails closed when an org-level engine bypass cannot be removed", async () => {
    const now = () => 1_700_000_000_000;
    const mock = new MockGitHub(now);
    // A non-owned ruleset (different name) that grants the engine a bypass and is
    // NOT removed by installRuleset (which only manages its own named ruleset).
    mock.reset([
      {
        id: 40,
        name: "org-mandated-bypass",
        rules: [pullRequestRule(enforceableParams)],
        bypassActors: [engineBypassActor()],
      },
    ]);
    const auth = buildAuth(now, mock);
    await expect(onboardRepository(auth, REPO)).rejects.toBeInstanceOf(GitHubRulesetError);
  });
});

// -------------------------------------------------------------------------------------------------
// Token rotation
// -------------------------------------------------------------------------------------------------

describe("installation token rotation", () => {
  it("reuses the cached token and rotates after the skew window", async () => {
    let clockMs = 1_700_000_000_000;
    const now = () => clockMs;
    const mock = new MockGitHub(now);
    mock.reset([
      {
        id: 50,
        name: "review",
        rules: [pullRequestRule(enforceableParams)],
      },
    ]);
    const auth = buildAuth(now, mock);

    const first = await auth.getInstallationToken(REPO);
    expect(first.token).toBe("ghs_install_token_1");
    expect(mock.installationTokenMints()).toBe(1);

    // Same instant → cached, no new mint.
    const cached = await auth.getInstallationToken(REPO);
    expect(cached.token).toBe(first.token);
    expect(mock.installationTokenMints()).toBe(1);

    // Advance past the refresh skew (token expires at now+60min, skew=5min).
    clockMs += 56 * 60 * 1000;
    const rotated = await auth.getInstallationToken(REPO);
    expect(rotated.token).toBe("ghs_install_token_2");
    expect(mock.installationTokenMints()).toBe(2);
  });
});

// -------------------------------------------------------------------------------------------------
// No credential path into the wire (SEC-10)
// -------------------------------------------------------------------------------------------------

describe("credential custody (SEC-10)", () => {
  it("never leaks the App private key into URLs, headers, or request bodies", async () => {
    const now = () => 1_700_000_000_000;
    const mock = new MockGitHub(now);
    mock.reset([
      {
        id: 60,
        name: "review",
        rules: [pullRequestRule(enforceableParams)],
      },
    ]);
    const auth = buildAuth(now, mock);
    // Exercise every code path that touches the wire.
    await inspectRuleset(auth, REPO);
    await installRuleset(auth, REPO);
    await detectDrift(auth, REPO);

    for (const record of mock.records) {
      expect(record.url).not.toContain(privateKeyMarker);
      expect(record.url).not.toContain("PRIVATE KEY");
      expect(record.authorization).not.toContain(privateKeyMarker);
      expect(record.authorization).not.toContain("PRIVATE KEY");
      expect(record.body).not.toContain(privateKeyMarker);
      expect(record.body).not.toContain("PRIVATE KEY");
    }

    // scanForSecrets over the captured wire data must not surface the private key.
    const transcript = mock.records
      .map(
        (record) =>
          `${record.method} ${record.url}\nAuthorization: ${record.authorization}\n${record.body}`,
      )
      .join("\n---\n");
    const hits = scanForSecrets(
      [{ kind: "transcript", label: "wire-transcript", content: transcript }],
      [{ name: "app-private-key", value: privateKeyPem }],
    );
    // The scanner DOES surface the scoped installation tokens (default shape
    // patterns) — those are legitimate wire credentials, not the private key.
    // Assert specifically that the App private key (the only known_secret) is absent.
    const privateKeyHits = hits.filter((hit) => hit.patternName === "known_secret");
    expect(privateKeyHits).toHaveLength(0);
  });
});
