import type { Writable } from "node:stream";

type LogLevel = "error" | "info" | "warn";
type LogFields = Readonly<Record<string, unknown>>;

export interface StructuredLogger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

export type CreateStructuredLoggerOptions = Readonly<{
  stream: Writable;
  now: () => number;
}>;

export function createStructuredLogger(options: CreateStructuredLoggerOptions): StructuredLogger {
  return new JsonStructuredLogger(options);
}

class JsonStructuredLogger implements StructuredLogger {
  readonly #options: CreateStructuredLoggerOptions;

  constructor(options: CreateStructuredLoggerOptions) {
    this.#options = options;
  }

  log(level: LogLevel, event: string, fields: LogFields = {}): void {
    if (!eventPattern.test(event)) {
      throw new TypeError("log event must be a stable lowercase identifier");
    }
    const timestamp = this.#options.now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new TypeError("log timestamp must be a non-negative safe integer");
    }
    const record = {
      timestamp_ms: timestamp,
      level,
      event,
      ...redactObject(fields),
    };
    this.#options.stream.write(`${JSON.stringify(record)}\n`);
  }
}

function redactObject(value: object): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = secretKeyPattern.test(key) ? "[REDACTED]" : redactValue(entry);
  }
  return redacted;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (typeof value === "object" && value !== null) {
    return redactObject(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  return typeof value;
}

const eventPattern = /^[a-z][a-z0-9_]*$/u;
const secretKeyPattern = /authorization|cookie|credential|password|secret|token/iu;
