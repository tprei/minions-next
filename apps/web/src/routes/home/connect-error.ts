import { Code, ConnectError } from "@connectrpc/connect";

export interface TypedError {
  readonly code: string;
  readonly message: string;
}

/**
 * Normalizes any thrown value from a Connect RPC call into a typed, displayable error
 * (PR 45 — host-repository-task-ui).
 *
 * `RegisterRepository` and `CreateTree` surface failures as a bare `ConnectError` with no
 * structured detail payload (plain `Code` + message text only — see
 * apps/daemon/src/repository-service.ts's `toConnectError`). This surfaces exactly that:
 * `error.code`'s human-readable name and `error.rawMessage`, the server's own text. It never
 * invents a client-side interpretation of *why* a request failed beyond what the server
 * actually said (PR 45 acceptance).
 */
export function describeConnectError(error: unknown): TypedError {
  const connectError = ConnectError.from(error);
  return { code: Code[connectError.code], message: connectError.rawMessage };
}
