export type DomainErrorCode =
  | "duplicate_id"
  | "invalid_artifact_input"
  | "invalid_outcome"
  | "invalid_transition"
  | "invalid_tree"
  | "invalid_value"
  | "not_found";

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
