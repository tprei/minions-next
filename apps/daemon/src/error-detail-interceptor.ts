import { create } from "@bufbuild/protobuf";
import { ConnectError, type Interceptor } from "@connectrpc/connect";
import { ErrorDetailSchema, type ErrorDetail, ValidationErrorSchema } from "@minions/contracts";
import { type Violation, ViolationsSchema } from "@minions/contracts/gen/buf/validate/validate_pb";

export function createErrorDetailInterceptor(): Interceptor {
  return (next) => async (request) => {
    try {
      return await next(request);
    } catch (error) {
      if (!(error instanceof ConnectError)) {
        throw error;
      }
      if (error.findDetails(ErrorDetailSchema).length > 0) {
        throw error;
      }

      const validationDetails = error.findDetails(ViolationsSchema);
      if (validationDetails.length === 0) {
        throw error;
      }

      const detail = createValidationErrorDetail(
        validationDetails.flatMap((validation) => validation.violations),
      );
      throw new ConnectError(
        error.rawMessage,
        error.code,
        error.metadata,
        [{ desc: ErrorDetailSchema, value: detail }],
        error.cause,
      );
    }
  };
}

export function createValidationErrorDetail(violations: Violation[]): ErrorDetail {
  return create(ErrorDetailSchema, {
    detail: {
      case: "validation",
      value: create(ValidationErrorSchema, { violations }),
    },
  });
}
