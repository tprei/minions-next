import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { ListRecoveryActionsResponseSchema, RecoveryService } from "@minions/contracts";

/**
 * Recovery elevation service handler (PR 56 — maintenance-elevation-recovery).
 *
 * ListRecoveryActions is functional: returns the (initially empty) action history.
 * RequestElevation and ExecuteRecoveryAction require per-action elevation grants,
 * actor binding, and a shadow daemon — return Code.Unimplemented until the grant
 * store exists.
 */
export interface RecoveryServiceOptions {
  readonly placeholder?: undefined;
}

export function registerRecoveryService(
  router: ConnectRouter,
  _options: RecoveryServiceOptions,
): void {
  void _options;
  router.service(RecoveryService, {
    requestElevation() {
      throw new ConnectError(
        "RequestElevation requires an elevation grant store",
        Code.Unimplemented,
      );
    },
    executeRecoveryAction() {
      throw new ConnectError("ExecuteRecoveryAction requires a shadow daemon", Code.Unimplemented);
    },
    listRecoveryActions() {
      return create(ListRecoveryActionsResponseSchema, {
        actions: [],
      });
    },
  });
}
