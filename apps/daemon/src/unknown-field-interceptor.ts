import { create, type DescMessage, type Message } from "@bufbuild/protobuf";
import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { ErrorDetailSchema, findUnknownField } from "@minions/contracts";
import { ViolationSchema } from "@minions/contracts/gen/buf/validate/validate_pb";

import { createValidationErrorDetail } from "./error-detail-interceptor.js";

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
  const unknownField = findUnknownField(schema, message);
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
