# Minions

Minions is a local-first command center for supervising coding agents.

## Development

The repository pins Node.js 24.18.0 through `mise.toml` and pnpm 10.34.5 through `package.json`.

```sh
mise install
corepack enable
pnpm install --frozen-lockfile
pnpm verify:pr
```

`pnpm verify:pr` is cumulative and blocking. It runs formatting, linting with zero warnings, strict typechecking, dead-code analysis, unit tests, and every build introduced by the current stack.

## Graphite chain

`main` is the Graphite trunk. Product branches form one linear stack: PR 01 branches from `main`, and every later PR branches from its immediate predecessor. Create and update branches with Graphite, inspect each PR against its parent branch, and restack descendants parent-first whenever an ancestor changes.

```sh
gt create <exact-slice-branch>
gt modify --all
gt restack
gt submit --stack
```

Do not create sibling product stacks, enable auto-merge or stack merge, or land a PR automatically. Every PR requires current independent human approval and an explicit human landing action.

## Dogfood runbook

Minions reaches its bootstrap threshold by supervising a real, bounded self-change against
its own repository. This runbook is the operational procedure for that flow. Every step uses
the real CLI and scripts; there is no separate dogfood harness.

### Prerequisites

- A running daemon: `minions start` (loopback only, noninteractive). Confirm with
  `minions status` and `minions doctor` — the latter must report a healthy auth broker,
  host, and sandbox capability for the target platform.
- The maintained gate profile checked in at `.minions/gates.yaml` (the daemon loads it; a
  named `root_check_profile` only passes if its gate exists there).
- For a live run, a provider credential vaulted on the local host via `minions auth-login`
  (one interactive login per host; survives worker/daemon/machine restarts).

### Register the dogfood repository

```sh
node scripts/dogfood-register.mjs
```

This registers this checkout's own root as a Minions-tracked repository against the local
daemon. It is idempotent — a repeat run against an already-registered checkout reports
success without mutating anything. It fails closed on a dirty checkout, submodules, LFS
paths, nested repositories, or a rejected gate profile.

### Create, approve, inspect, steer

```sh
minions tree-create --repository <id> --text "<objective>" --root-check-profile <name>
minions tree-propose --tree <id> --max-depth N --max-fan-out M      # inspect/review first
minions tree-approve --tree <id> --expected-version <n>             # approval gates writable execution
minions tree-get --tree <id>                                        # inspect structure/state
minions tree-provenance --tree <id>                                 # tree -> node -> attempt -> commit -> gates -> PR
minions node-steer --node <id> --kind message --text "..."          # address any live node
minions node-attention --node <id>                                  # see pending questions/approvals
```

No writable node starts before the plan is approved; every command and node outcome is
durable and replayable from `tree-provenance`.

### Survive failures mid-run

The run must survive one forced harness restart and one forced gate repair without losing
completed siblings, queued steering, transcripts, or external receipts:

- Restart the daemon (`minions stop && minions start`) mid-run; completed nodes and queued
  steering persist (durable SQLite, not in-memory). The scheduler fences stale leases on
  recovery and resumes only the affected node.
- A failing gate produces a typed attention; `tree-repair` drives a bounded repair/retry,
  and `tree-provenance` shows the repaired evidence at the exact commit.

### Land parent-first (human action only)

Landing is never automatic. After independent human review approves a PR, land it
parent-first with the landing coordinator; each landing is one explicit user command that
lands only its named current PR and records a durable receipt. A new push invalidates prior
approval; there is no auto-merge or auto-land path.

### Exceptions are typed, not silent

Where a slice cannot yet run through the product (a capability the current UI/backend does
not yet expose), record a typed bootstrap reason rather than silently falling back. The
acceptance bar is that every manual exception is explicit and reviewable, not that no
exception ever exists during the bootstrap phase.
