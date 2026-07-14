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
