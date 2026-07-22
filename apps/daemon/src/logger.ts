import type { Writable } from "node:stream";

import { redactObject } from "@minions/adapters";

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
    // Delegate redaction to the library `redactObject` so the daemon shares the
    // same string-shape pass + secret-key coverage (`api_key`, `bearer`, …) as
    // every other Minions surface. The library returns `unknown` (bigint and
    // other non-JSON leaves pass through verbatim); cast for the spread and let
    // the inline replacer below keep JSON.stringify from throwing on bigint.
    const redactedFields = redactObject(fields) as Record<string, unknown>;
    const record = {
      timestamp_ms: timestamp,
      level,
      event,
      ...redactedFields,
    };
    this.#options.stream.write(`${JSON.stringify(record, jsonReplacer)}\n`);
  }
}

// `redactObject` returns `unknown`; bigint and other non-JSON leaves pass through
// verbatim. JSON.stringify would throw on bigint, so coerce the unsafe leaves to
// JSON-safe strings here (matches the prior local redactor's behaviour).
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "function";
  if (typeof value === "symbol") return "symbol";
  if (value === undefined) return "undefined";
  return value;
}

const eventPattern = /^[a-z][a-z0-9_]*$/u;
