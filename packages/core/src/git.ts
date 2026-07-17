export type GitProcessFailureKind = "exit" | "spawn" | "timeout" | "output_limit";

export type GitProcessRequest = Readonly<{
  workingDirectory: string;
  workingDirectoryDevice: bigint;
  workingDirectoryInode: bigint;
  arguments: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
}>;

export type GitProcessResult = Readonly<{
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

export interface GitProcess {
  run(request: GitProcessRequest): Promise<GitProcessResult>;
}

export class GitProcessError extends Error {
  readonly kind: GitProcessFailureKind;
  readonly exitCode: number | undefined;

  constructor(
    kind: GitProcessFailureKind,
    message: string,
    options: Readonly<{
      exitCode?: number;
      cause?: unknown;
    }> = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "GitProcessError";
    this.kind = kind;
    this.exitCode = options.exitCode;
  }
}
