import { generateUuidV7 } from "./id-generator.js";

/**
 * One stable UUIDv7 minted per browser session (module-load), reused as `actorSessionId` on
 * every command this tab issues (PR 45). Unlike the CLI — a one-shot process where each
 * invocation mints its own — the browser is long-lived, so a stable id per page load lets the
 * daemon correlate a burst of commands to one operator session.
 */
let cachedActorSessionId: string | undefined;

export function actorSessionId(): string {
  cachedActorSessionId ??= generateUuidV7();
  return cachedActorSessionId;
}
