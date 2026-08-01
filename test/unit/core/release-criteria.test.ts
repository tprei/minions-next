import { describe, it, expect } from "vitest";
import {
  RELEASE_CRITERIA_DEFINITIONS,
  RELEASE_CRITERIA_COUNT,
  checkReleaseReadiness,
  type ReleaseCriterion,
} from "@minions/core";

describe("release criteria definitions", () => {
  it("has exactly RELEASE_CRITERIA_COUNT entries", () => {
    expect(RELEASE_CRITERIA_DEFINITIONS).toHaveLength(RELEASE_CRITERIA_COUNT);
  });

  it("has contiguous ids from 1 to 18", () => {
    const ids = RELEASE_CRITERIA_DEFINITIONS.map((c) => c.id).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
  });

  it("every criterion has a non-empty name", () => {
    for (const c of RELEASE_CRITERIA_DEFINITIONS) {
      expect(c.name.length).toBeGreaterThan(0);
    }
  });

  it("starts with all criteria undemonstrated", () => {
    for (const c of RELEASE_CRITERIA_DEFINITIONS) {
      expect(c.demonstrated).toBe(false);
      expect(c.evidenceSha).toBeUndefined();
    }
  });
});

describe("checkReleaseReadiness", () => {
  it("is not ready with default definitions", () => {
    const r = checkReleaseReadiness(RELEASE_CRITERIA_DEFINITIONS);
    expect(r.ready).toBe(false);
    expect(r.pending).toHaveLength(18);
  });

  it("is ready when all criteria are demonstrated with evidence", () => {
    const all: ReleaseCriterion[] = RELEASE_CRITERIA_DEFINITIONS.map((c) => ({
      ...c,
      demonstrated: true,
      evidenceSha: "abc123",
    }));
    expect(checkReleaseReadiness(all).ready).toBe(true);
  });

  it("is not ready when demonstrated but no evidence", () => {
    const partial: ReleaseCriterion[] = RELEASE_CRITERIA_DEFINITIONS.map((c) => ({
      ...c,
      demonstrated: true,
      evidenceSha: undefined,
    }));
    expect(checkReleaseReadiness(partial).ready).toBe(false);
  });

  it("is not ready when evidence exists but not demonstrated", () => {
    const partial: ReleaseCriterion[] = RELEASE_CRITERIA_DEFINITIONS.map((c) => ({
      ...c,
      demonstrated: false,
      evidenceSha: "abc123",
    }));
    expect(checkReleaseReadiness(partial).ready).toBe(false);
  });

  it("does not treat empty input as ready (fail closed)", () => {
    expect(checkReleaseReadiness([]).ready).toBe(false);
    expect(checkReleaseReadiness([]).pending).toHaveLength(18);
  });

  it("does not treat partial input as ready — missing criteria count as pending", () => {
    const partial: ReleaseCriterion[] = RELEASE_CRITERIA_DEFINITIONS.slice(0, 5).map((c) => ({
      ...c,
      demonstrated: true,
      evidenceSha: "abc123",
    }));
    const r = checkReleaseReadiness(partial);
    expect(r.ready).toBe(false);
    expect(r.pending).toHaveLength(13);
  });

  it("does not accept an empty-string evidenceSha as evidence", () => {
    const withEmptySha: ReleaseCriterion[] = RELEASE_CRITERIA_DEFINITIONS.map((c) => ({
      ...c,
      demonstrated: true,
      evidenceSha: "",
    }));
    const r = checkReleaseReadiness(withEmptySha);
    expect(r.ready).toBe(false);
    expect(r.pending).toHaveLength(18);
  });

  it("sorts pending by id", () => {
    const reversed = [...RELEASE_CRITERIA_DEFINITIONS].reverse();
    const r = checkReleaseReadiness(reversed);
    const ids = r.pending.map((c) => c.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});
