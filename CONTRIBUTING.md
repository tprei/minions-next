# Contributing

This project values small, reviewable changes. The goal is not just to make code work, but to keep the codebase understandable enough that humans can stay in charge of it.

## Branches And Pull Requests

- `main` is protected.
- Changes enter `main` only through pull requests.
- Pushing non-`main` branches is fine.
- Every PR must be human reviewed before merge.
- AI review automation is welcome, but it never replaces human review.
- PRs must pass CI before merge.

## PR Size

PRs should stay under 1,000 changed lines.

Generated code, lockfile churn, snapshots, and other clearly machine-generated artifacts may exceed that limit, but the human-authored part of the PR should still be small and reviewable.

If a change would exceed the limit, split it into several PRs. Prefer stacked PRs when the changes naturally depend on each other.

## Stacked Diffs

Stacked diffs are encouraged for larger work because they preserve review quality while still letting us move quickly.

Use the standard workflow in `agent-guidance/writing/STACKED_DIFFS.md`. The GitHub-visible PR structure is the standard. Graphite CLI is the preferred helper when available, especially for coding agents, but plain Git is fine when it produces the same branch shape, PR titles, and PR descriptions.

## CI

CI is the main feedback loop for preventing regressions.

CI currently runs:

- `pnpm verify:pr`, which gates Prettier formatting, zero-warning ESLint, strict typechecking across every workspace, Knip dead-code analysis, generated-code checks, Protobuf lint and breaking-change checks, unit tests, all builds, integration tests, and security tests.
- A dedicated `protobuf` job that re-runs `generate:check`, `proto:lint`, and `proto:breaking`.

GitHub Actions are SHA-pinned and run with least-privilege permissions. Do not merge failing CI because "it is probably unrelated" without a clear human decision recorded on the PR.

## Tests

Tests should prove behavior, not decorate coverage reports.

Good tests:

- Assert user-visible or domain-visible behavior.
- Use clear arrange/act/assert structure.
- Avoid depending on execution order.
- Avoid shared mutable state between tests.
- Prefer a few high-value tests over many brittle tests.

Avoid tests that only verify mocks, implementation details, or framework wiring without proving product behavior.

This repo has three test layers:

- Domain unit tests under `test/unit/domain`, run with `pnpm test:domain`. They exercise the `packages/core` kernel directly: aggregate boundaries, task-node lifecycle, and task-tree invariants.
- Integration tests under `test/integration`, run with `pnpm test:integration`. They wire adapters, SQLite, and daemon Connect services together to prove assembled runtime behavior: services, the scheduler loop, daemon runtime, steering, registries, migrations, and workspace fencing.
- Security tests under `test/security`, run with `pnpm test:security`. They prove the fail-closed sandbox contract and repository confinement.

`pnpm test:unit` is the fast local gate across `apps`, `packages`, and `test/unit`. During development, choose the highest layer needed to prove the product risk before opening a PR: domain invariants get a domain unit test; anything that touches adapters, SQLite, Connect services, the scheduler, or the daemon runtime gets an integration test; anything that changes confinement or the sandbox policy gets a security test.

## Domain-Driven Design

Respect DDD principles, scaled to a small codebase:

- Use product language in code: minion, repository, task, task-node, task-tree, plan, attempt, steering command, artifact, sandbox, workspace, scheduler, node outcome.
- Keep domain rules out of Connect-RPC handlers and CLI code.
- Keep infrastructure concerns at the edges, in `packages/adapters`.
- Make boundaries visible through workspaces, not through excessive abstraction.
- Do not introduce generic service layers unless they clarify domain behavior.

## Dependencies

New dependencies need a short justification in the PR description.

JavaScript dependencies are managed with pnpm workspaces. Run `pnpm install --frozen-lockfile` from the repo root, and keep `pnpm-lock.yaml` committed. The workspace enforces `strictPeerDependencies`, `strictDepBuilds`, `engineStrict`, `saveExact`, and `preferWorkspacePackages`.

Before adding a dependency, ask:

- Can the standard library or existing stack solve this clearly?
- Does this make code easier to review?
- Does this increase operational burden?
- Does this weaken sovereignty or data ownership?

Avoid dependencies that introduce hidden services, unnecessary global state, or large framework conventions.

Workspace dependency direction is enforced by ESLint and must match the manifests. Apps depend on packages; packages never depend on apps. See the Workspace Review Rules below.

## Workspace Review Rules

- Keep Connect-RPC handlers in `apps/daemon` thin: validate the request, delegate to a registry or store, and map the result to a response.
- Keep domain decisions in `packages/core`, which has no Node I/O and no transport.
- Keep persistence in `packages/adapters`: explicit SQL, numbered migrations with checksums, crash-safe applies.
- Keep generated Protobuf code in `packages/contracts/src/gen`; regenerate with `pnpm generate` and never hand-edit it.
- Keep the CLI in `apps/cli` to presentation and intent; embed the daemon runtime only where a command needs it.
- Keep `apps/web` and `packages/ui-kit` free of domain and infrastructure code.
- Respect strict TypeScript: no `any`, deliberate nullability, `import type` for type-only imports, exhaustive switches.
- Do not add a background worker, a message broker, a separate scheduler service, or a second persistence engine until the product need is real.

## PR Checklist

Before requesting review:

- The PR is under 1,000 changed lines, excluding generated code.
- The change is scoped to one coherent idea.
- CI passes locally with `pnpm verify:pr`, or the expected CI path is documented.
- Tests prove behavior where risk justifies them, at the right layer: domain unit, integration, or security.
- New dependencies are justified.
- The PR description explains what changed and why.
- If the PR changes a Protobuf contract, it explains the Protobuf impact, passes `pnpm proto:lint` and `pnpm proto:breaking`, and regenerates clients with `pnpm generate`.
- If the PR changes SQLite schema, it adds a numbered migration and explains migration impact, rollback, and recovery.
- Stacked PRs include the stack section described in `agent-guidance/writing/STACKED_DIFFS.md`.
- Any AI-generated sections were read and edited by a human or explicitly called out.
