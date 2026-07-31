import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
  decodeProjectionChange,
  ProjectionBatchSchema,
  ProjectionChangeSchema,
  RepositorySummarySchema,
  type ProjectionChangeDecodeError,
} from "@minions/contracts";

const projection = create(ProjectionChangeSchema, {
  change: {
    case: "repositoryUpserted",
    value: create(RepositorySummarySchema, {
      id: "01900000-0000-7000-8000-000000000001",
      hostId: "01900000-0000-7000-8000-000000000002",
      version: 1n,
    }),
  },
});
const projectionBatch = create(ProjectionChangeSchema, {
  change: {
    case: "batch",
    value: create(ProjectionBatchSchema, { changes: [projection] }),
  },
});
const emptyProjectionBatch = create(ProjectionChangeSchema, {
  change: {
    case: "batch",
    value: create(ProjectionBatchSchema, { changes: [] }),
  },
});
const nestedProjectionBatch = create(ProjectionChangeSchema, {
  change: {
    case: "batch",
    value: create(ProjectionBatchSchema, { changes: [projectionBatch] }),
  },
});
const encodedProjection = toBinary(ProjectionChangeSchema, projection);
const unknownVarintField = Uint8Array.of(0x98, 0x06, 0x01);

describe("projection change decoding", () => {
  it("accepts a canonical generated projection", () => {
    expect(decodeProjectionChange(encodedProjection)).toEqual(projection);
  });

  it("accepts a non-empty batch of leaves", () => {
    const encoded = toBinary(ProjectionChangeSchema, projectionBatch);
    expect(decodeProjectionChange(encoded)).toEqual(projectionBatch);
  });

  it("rejects empty batches", () => {
    const encoded = toBinary(ProjectionChangeSchema, emptyProjectionBatch);
    expect(() => decodeProjectionChange(encoded)).toThrow(
      expect.objectContaining<Partial<ProjectionChangeDecodeError>>({
        code: "invalid_message",
      }),
    );
  });

  it("rejects nested batches", () => {
    const encoded = toBinary(ProjectionChangeSchema, nestedProjectionBatch);
    expect(() => decodeProjectionChange(encoded)).toThrow(
      expect.objectContaining<Partial<ProjectionChangeDecodeError>>({
        code: "invalid_message",
        message: "projection change batch cannot contain nested batches",
      }),
    );
  });

  it("rejects unknown top-level fields", () => {
    const encoded = concatenate(encodedProjection, unknownVarintField);
    expect(() => decodeProjectionChange(encoded)).toThrow(
      expect.objectContaining<Partial<ProjectionChangeDecodeError>>({
        code: "unknown_field",
      }),
    );
  });

  it("rejects unknown nested fields", () => {
    const fieldTag = encodedProjection[0];
    const nestedLength = encodedProjection[1];
    if (fieldTag !== 0x12 || nestedLength === undefined || nestedLength >= 0x80) {
      throw new Error("projection fixture does not use the expected length-delimited wire shape");
    }
    const encoded = Uint8Array.of(
      fieldTag,
      nestedLength + unknownVarintField.byteLength,
      ...encodedProjection.subarray(2),
      ...unknownVarintField,
    );
    expect(() => decodeProjectionChange(encoded)).toThrow(
      expect.objectContaining<Partial<ProjectionChangeDecodeError>>({
        code: "unknown_field",
      }),
    );
  });
});

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}
