/**
 * Maintenance-tool registry, mirrored for the browser (PR 55 — maintenance-plane-readonly).
 *
 * The canonical registry is `MAINTENANCE_TOOLS` in packages/core/src/maintenance.ts, but
 * apps/web can never import `@minions/core` directly — see eslint.config.mjs's
 * `no-restricted-imports` for `apps/web/**`, which enforces the same "server-only domain
 * logic never ships to the browser bundle" boundary applied to the whole app. There is no
 * `MaintenanceService` RPC to fetch this over the wire yet (the daemon's maintenance
 * service — apps/daemon/src/maintenance-service.ts — isn't even wired into the running
 * server), so, exactly like apps/web/src/routes/node/steering-labels.ts mirrors
 * `@minions/contracts`' proto enums into hand-maintained label maps, this module
 * hand-mirrors the registry's data instead of its enum shape. Drift is caught by
 * test/unit/web/maintenance-tools.test.ts, which asserts this list is structurally
 * identical to `@minions/core`'s canonical one — treat that test failing as "update this
 * file to match," never as "adjust the test."
 */
export interface MaintenanceToolView {
  readonly name: string;
  readonly description: string;
  readonly mutating: boolean;
}

export const WEB_MAINTENANCE_TOOLS: readonly MaintenanceToolView[] = Object.freeze([
  { name: "doctor", description: "Health check the host and all capabilities", mutating: false },
  { name: "logs", description: "Inspect daemon and harness logs", mutating: false },
  { name: "stacks", description: "Capture process stack traces", mutating: false },
  { name: "processes", description: "List running processes and their state", mutating: false },
  { name: "leases", description: "Inspect scheduler leases", mutating: false },
  {
    name: "db-integrity",
    description: "Check database integrity and migrations",
    mutating: false,
  },
  { name: "source-inspect", description: "Read source files (read-only)", mutating: false },
]);
