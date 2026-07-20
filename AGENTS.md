# Agent Instructions

This file is for AI coding agents working in this repository. Follow it unless a human gives a more specific instruction.

## Mission

Build Minions as a small, sovereign, local-first command center for supervising coding agents. Sovereignty and process isolation come first. Optimize for reviewability, product learning, and operational simplicity. Do not optimize for scale before the product asks for it.

## Current Stack Decision

Use this as the default architecture:

- Runtime: Node.js 24.18.0, pinned through `mise.toml`.
- Language: TypeScript, ESM (`"type": "module"`), strict mode.
- Package manager: pnpm 10.34.5 via Corepack, with pnpm workspaces.
- Monorepo: `apps/{cli,daemon,web}` + `packages/{core,contracts,adapters,testkit,ui-kit}`.
- Contracts: Protobuf + Connect-RPC, generated with the Buf toolchain.
- Persistence: SQLite through `node:sqlite`, with a crash-safe migration kernel.
- Daemon: a single local Connect-RPC server driven by a fenced, lease-based scheduler.
- CLI: the human-facing client; it can also embed the daemon runtime.

Do not introduce a message broker, a separate scheduler service, cloud agent runners, Postgres, Redis, a second persistence engine, or an external secrets service unless the user explicitly asks or the product requirement makes it unavoidable.

## Product Constraints

- Minions is local-first. The daemon, scheduler, and SQLite stores run on the user's own machine.
- Supervision is durable and replayable. Commands, events, and the outbox are written in one transaction; event streams are snapshot-resumable.
- Agent work runs in fenced isolation: independent git workspaces and a fail-closed sandbox policy. Default to denying access, not granting it.
- Contracts are the public boundary. The CLI and any future client speak Connect-RPC against the daemon; the wire shape is Protobuf.

## Reviewability Rules

AI code must be easy for a human to audit.

- Prefer boring, explicit code.
- Keep files small.
- Keep functions small.
- Do not create broad abstractions before there is repeated pain.
- Do not add dependencies without explaining why.
- Do not generate styling blobs.
- Do not create or version Markdown artifacts unless a human explicitly asks for them.
- Do not create `docs/*` trees. Architecture and product decisions belong in `README.md` unless a human explicitly chooses another home.
- Do not hide business rules in UI components, hooks, middleware, or database triggers.
- Do not mix unrelated refactors into feature work.
- Follow the writing guides in `agent-guidance/writing/WRITING_TYPESCRIPT.md` and `agent-guidance/writing/STACKED_DIFFS.md`.

## Domain-Driven Design

Use product language in code and boundaries:

- `minion` — the coding agent under supervision.
- `repository` — a registered, confined working repository.
- `task`, `task-node`, `task-tree` — the domain tree being worked.
- `plan`, `plan revision` — proposed and approved work.
- `attempt`, `attempt harness` — a fenced execution of work against a task node.
- `steering command` — a durable instruction fed to a minion.
- `artifact` — content-addressed input and output of an attempt.
- `sandbox` — the fail-closed execution policy and its fingerprint.
- `workspace` — an independent fenced git workspace for an attempt.
- `scheduler` — the fenced, lease-based, deterministic loop.
- `node outcome` — the terminal result of a task node.
- `host` — an execution host registered with the daemon.

Keep domain rules separate from delivery mechanisms:

- Connect-RPC handlers in `apps/daemon` translate requests and responses.
- Domain/application code in `packages/core` decides behavior.
- SQLite code in `packages/adapters` persists and queries data.
- The CLI in `apps/cli` presents state and collects intent.

Do not create generic `manager`, `processor`, `util`, or `service` packages when a domain name would be clearer.

## Workspace Rules

Dependency direction is enforced by ESLint `no-restricted-imports` per workspace and must match the manifests.

- `packages/contracts` is the leaf. It depends on nothing internal, only Protobuf, Connect, and protovalidate.
- `packages/core` is the pure domain kernel. It imports no `node:*` modules, no contracts, no adapters, no UI, and no testkit. Behavior lives here; I/O does not.
- `packages/adapters` implements the ports with SQLite, git, the sandbox, blob storage, and the registries and stores. It depends on `contracts` and `core`.
- `packages/testkit` provides test fixtures and contract doubles. It depends on `adapters` and `core`.
- `packages/ui-kit` holds presentational primitives. It imports no `node:*`, no core, no adapters, no testkit.
- `apps/daemon` is the Connect-RPC server. Handlers stay thin: validate, call a registry or store, map to a response. It depends on `adapters`, `contracts`, and `core`.
- `apps/cli` is the client. It depends on `contracts`, and on `adapters`, `core`, and `daemon` only where it embeds the runtime.
- `apps/web` is a client over `contracts`. It imports no `node:*`, no core, no adapters, no testkit.

Apps depend on packages. Packages never depend on apps. Keep generated code at the boundary: Protobuf-generated TypeScript lives under `packages/contracts/src/gen` and is consumed, not hand-edited. Regenerate with `pnpm generate`. Keep handlers and the CLI thin. Keep SQLite access explicit and migration-driven. Respect strict TypeScript: no `any`, deliberate nullability, `import type` for type-only imports, exhaustive switches.

## Tests

Write tests when they reduce real risk.

Tests should verify behavior, not implementation details. Prefer a few clear tests over many fragile ones. Tests must not depend on order or shared mutable state.

`pnpm verify:pr` is the cumulative CI contract. It gates formatting, zero-warning lint, typechecking across every workspace, dead-code analysis, generated-code and Protobuf checks, unit tests, all builds, integration tests, and security tests.

## Pull Requests

- Never push directly to `main`.
- Changes to `main` must go through PRs.
- Keep PRs under 1,000 changed lines, excluding generated code.
- Split larger work into stacked PRs.
- CI must pass before merge.
- Human review is required.
- AI review can assist, but cannot approve its own work.

## Stacked Diffs

For large work, follow `agent-guidance/writing/STACKED_DIFFS.md`.

Use Graphite CLI for stack management when it is available. If it is unavailable, use plain Git. Either way, the output must be normal GitHub PRs with the standard stack section, position-prefixed titles, passing CI, and human review.

## Documentation

Update `README.md` when architecture decisions change. Update `CONTRIBUTING.md` when workflow rules change. Keep guidance direct and current; do not write aspirational architecture that the repo does not follow.
