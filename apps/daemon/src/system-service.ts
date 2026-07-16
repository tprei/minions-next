import { create } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import {
  ApiVersionSchema,
  ErrorDetailSchema,
  GetHealthResponseSchema,
  GetServerInfoResponseSchema,
  RunDoctorResponseSchema,
  SystemService,
  UnsupportedApiVersionSchema,
  type GetHealthResponse,
  type RunDoctorResponse,
  type ServerCapability,
} from "@minions/contracts";

const supportedApiVersion = {
  major: 1,
  minor: 0,
  patch: 0,
} as const;
const responseValidator = createValidator();

export type SystemServiceOptions = Readonly<{
  serverVersion: string;
  capabilities: readonly ServerCapability[];
  health: GetHealthResponse;
  runDoctor: () => Promise<RunDoctorResponse>;
}>;

export function registerSystemService(router: ConnectRouter, options: SystemServiceOptions): void {
  const apiVersion = create(ApiVersionSchema, supportedApiVersion);
  const serverInfo = validateResponse(
    GetServerInfoResponseSchema,
    create(GetServerInfoResponseSchema, {
      serverVersion: options.serverVersion,
      apiVersion,
      capabilities: [...options.capabilities],
    }),
  );
  const health = validateResponse(GetHealthResponseSchema, options.health);

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

      return serverInfo;
    },
    getHealth() {
      return health;
    },
    async runDoctor() {
      return validateResponse(RunDoctorResponseSchema, await options.runDoctor());
    },
  });
}

function validateResponse<Schema extends Parameters<typeof responseValidator.validate>[0]>(
  schema: Schema,
  message: Parameters<typeof responseValidator.validate<Schema>>[1],
) {
  const validation = responseValidator.validate(schema, message);
  if (validation.kind !== "valid") {
    throw new ConnectError(
      `system service produced an invalid response: ${validation.error.message}`,
      Code.Internal,
      undefined,
      undefined,
      validation.error,
    );
  }
  return validation.message;
}
