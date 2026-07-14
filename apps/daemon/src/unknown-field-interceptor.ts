import { create, type DescMessage, type Message } from "@bufbuild/protobuf";
import { reflect, type ReflectMessage } from "@bufbuild/protobuf/reflect";
import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { ErrorDetailSchema } from "@minions/contracts";
import { ViolationSchema } from "@minions/contracts/gen/buf/validate/validate_pb";

import { createValidationErrorDetail } from "./error-detail-interceptor.js";

type UnknownFieldLocation = Readonly<{
  fieldNumber: number;
  messageType: string;
}>;

export function createUnknownFieldInterceptor(): Interceptor {
  return (next) => async (request) => {
    if (request.stream) {
      return next({
        ...request,
        message: validateMessageStream(request.method.input, request.message),
      });
    }
    assertKnownFields(request.method.input, request.message);
    return next(request);
  };
}

async function* validateMessageStream(
  schema: DescMessage,
  messages: AsyncIterable<Message>,
): AsyncIterable<Message> {
  for await (const message of messages) {
    assertKnownFields(schema, message);
    yield message;
  }
}

function assertKnownFields(schema: DescMessage, message: Message): void {
  const unknownField = findUnknownField(reflect(schema, message));
  if (unknownField === undefined) {
    return;
  }

  const violation = create(ViolationSchema, {
    ruleId: "minions.request.known_fields",
    message: `${unknownField.messageType} contains unknown field ${String(unknownField.fieldNumber)}`,
  });
  const detail = createValidationErrorDetail([violation]);
  throw new ConnectError(
    "request contains an unknown Protobuf field",
    Code.InvalidArgument,
    undefined,
    [{ desc: ErrorDetailSchema, value: detail }],
  );
}

function isReflectMessage(value: unknown): value is ReflectMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "getUnknown" in value &&
    typeof value.getUnknown === "function"
  );
}

function findUnknownField(message: ReflectMessage): UnknownFieldLocation | undefined {
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
      const nestedUnknownField = findUnknownField(message.get(field));
      if (nestedUnknownField !== undefined) {
        return nestedUnknownField;
      }
      continue;
    }
    if (field.fieldKind === "list" && field.listKind === "message") {
      for (const nestedMessage of message.get(field)) {
        if (!isReflectMessage(nestedMessage)) {
          throw new Error("reflected message list contained a non-message value");
        }
        const nestedUnknownField = findUnknownField(nestedMessage);
        if (nestedUnknownField !== undefined) {
          return nestedUnknownField;
        }
      }
      continue;
    }
    if (field.fieldKind === "map" && field.mapKind === "message") {
      for (const nestedMessage of message.get(field).values()) {
        if (!isReflectMessage(nestedMessage)) {
          throw new Error("reflected message map contained a non-message value");
        }
        const nestedUnknownField = findUnknownField(nestedMessage);
        if (nestedUnknownField !== undefined) {
          return nestedUnknownField;
        }
      }
    }
  }
  return undefined;
}
