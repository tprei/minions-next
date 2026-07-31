import { fromBinary, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { reflect, type ReflectMessage } from "@bufbuild/protobuf/reflect";
import { createValidator } from "@bufbuild/protovalidate";

import { ProjectionChangeSchema, type ProjectionChange } from "./gen/minions/v1/event_pb.js";

export type UnknownFieldLocation = Readonly<{
  fieldNumber: number;
  messageType: string;
}>;

export type ProjectionChangeDecodeErrorCode = "invalid_message" | "unknown_field";

export class ProjectionChangeDecodeError extends Error {
  readonly code: ProjectionChangeDecodeErrorCode;

  constructor(code: ProjectionChangeDecodeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectionChangeDecodeError";
    this.code = code;
  }
}

const validator = createValidator();

export function decodeProjectionChange(bytes: Uint8Array): ProjectionChange {
  let message: ProjectionChange;
  try {
    message = fromBinary(ProjectionChangeSchema, bytes);
  } catch (error) {
    throw new ProjectionChangeDecodeError(
      "invalid_message",
      "projection change bytes are malformed",
      {
        cause: error,
      },
    );
  }
  const unknownField = findUnknownField(ProjectionChangeSchema, message);
  if (unknownField !== undefined) {
    throw new ProjectionChangeDecodeError(
      "unknown_field",
      `${unknownField.messageType} contains unknown field ${String(unknownField.fieldNumber)}`,
    );
  }
  const validation = validator.validate(ProjectionChangeSchema, message);
  if (validation.kind !== "valid") {
    throw new ProjectionChangeDecodeError(
      "invalid_message",
      "projection change violates its Protobuf contract",
      { cause: validation.error },
    );
  }
  assertNoNestedBatches(validation.message);
  return validation.message;
}

function assertNoNestedBatches(message: ProjectionChange): void {
  if (message.change.case !== "batch") {
    return;
  }
  for (const member of message.change.value.changes) {
    if (member.change.case === "batch") {
      throw new ProjectionChangeDecodeError(
        "invalid_message",
        "projection change batch cannot contain nested batches",
      );
    }
  }
}

export function findUnknownField<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): UnknownFieldLocation | undefined {
  return findReflectedUnknownField(reflect(schema, message));
}

function findReflectedUnknownField(message: ReflectMessage): UnknownFieldLocation | undefined {
  const unknownField = message.getUnknown()?.[0];
  if (unknownField !== undefined) {
    return {
      fieldNumber: unknownField.no,
      messageType: message.desc.typeName,
    };
  }

  for (const field of message.fields) {
    if (!message.isSet(field)) {
      continue;
    }
    if (field.fieldKind === "message") {
      const nestedUnknownField = findReflectedUnknownField(message.get(field));
      if (nestedUnknownField !== undefined) {
        return nestedUnknownField;
      }
      continue;
    }
    if (field.fieldKind === "list" && field.listKind === "message") {
      for (const nestedMessage of message.get(field)) {
        const nestedUnknownField = findReflectedUnknownField(assertReflectMessage(nestedMessage));
        if (nestedUnknownField !== undefined) {
          return nestedUnknownField;
        }
      }
      continue;
    }
    if (field.fieldKind === "map" && field.mapKind === "message") {
      for (const nestedMessage of message.get(field).values()) {
        const nestedUnknownField = findReflectedUnknownField(assertReflectMessage(nestedMessage));
        if (nestedUnknownField !== undefined) {
          return nestedUnknownField;
        }
      }
    }
  }
  return undefined;
}

function assertReflectMessage(value: unknown): ReflectMessage {
  if (!isReflectMessage(value)) {
    throw new ProjectionChangeDecodeError(
      "invalid_message",
      "reflected message collection contains a non-message value",
    );
  }
  return value;
}

function isReflectMessage(value: unknown): value is ReflectMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "getUnknown" in value &&
    typeof value.getUnknown === "function"
  );
}
