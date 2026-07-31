import { create } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import {
  ApiVersionSchema,
  ErrorDetailSchema,
  GetServerInfoResponseSchema,
  ServerCapability,
  SystemService,
  UnsupportedApiVersionSchema,
} from "@minions/contracts";

const supportedApiVersion = {
  major: 1,
  minor: 0,
  patch: 0,
} as const;
const responseValidator = createValidator();

export function registerSystemService(router: ConnectRouter, serverVersion: string): void {
  const apiVersion = create(ApiVersionSchema, supportedApiVersion);
  const response = create(GetServerInfoResponseSchema, {
    serverVersion,
    apiVersion,
    capabilities: [ServerCapability.SYSTEM_INFO],
  });
  const responseValidation = responseValidator.validate(GetServerInfoResponseSchema, response);
  if (responseValidation.kind !== "valid") {
    throw responseValidation.error;
  }

  router.service(SystemService, {
    getServerInfo(request) {
      const requestedVersion = request.apiVersion;
      if (requestedVersion === undefined) {
        throw new ConnectError("validated request is missing api_version", Code.Internal);
      }
      if (requestedVersion.major !== supportedApiVersion.major) {
        const unsupportedApiVersion = create(UnsupportedApiVersionSchema, {
          requested: requestedVersion,
          supported: apiVersion,
        });
        const detail = create(ErrorDetailSchema, {
          detail: {
            case: "unsupportedApiVersion",
            value: unsupportedApiVersion,
          },
        });
        throw new ConnectError("unsupported API version", Code.FailedPrecondition, undefined, [
          {
            desc: ErrorDetailSchema,
            value: detail,
          },
        ]);
      }

      return responseValidation.message;
    },
  });
}
