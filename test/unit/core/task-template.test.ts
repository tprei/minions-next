import {
  DomainError,
  resolveTaskTemplate,
  TASK_TEMPLATES,
  validateTemplateDefinition,
  type TaskTemplateDefinition,
  type TaskTemplateKey,
} from "@minions/core";
import { describe, expect, it } from "vitest";

describe("task-template catalog", () => {
  it("defines all three v1 templates (explain, fix, feature)", () => {
    const keys = Object.keys(TASK_TEMPLATES) as TaskTemplateKey[];
    expect(keys.sort()).toEqual(["explain", "feature", "fix"]);
  });

  describe("resolveTaskTemplate: explain", () => {
    it("resolves to a single research node with auto-approve enabled", () => {
      const resolved = resolveTaskTemplate("explain", "explain the event loop");

      expect(resolved.key).toBe("explain");
      expect(resolved.autoApprove).toBe(true);
      expect(resolved.budget).toEqual({
        maxDepth: 2,
        maxFanOut: 1,
        maxNodes: 2,
        maxConcurrency: 1,
        maxAttemptsPerNode: 1,
      });

      expect(resolved.nodes).toHaveLength(1);
      const [node] = resolved.nodes;
      expect(node).toBeDefined();
      expect(node?.mode).toBe("research");
      expect(node?.outputKind).toBe("artifact");
      expect(node?.parentIndex).toBeUndefined();
      expect(node?.allowedRepositoryPaths).toEqual(["."]);
      expect(node?.objective).toBe("Explain: explain the event loop");
      expect(node?.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
      expect(node?.acceptanceCriteria[0]).toContain("explain the event loop");
    });
  });

  describe("resolveTaskTemplate: fix", () => {
    it("resolves to a sequential chain: research (diagnose) -> implementation (fix)", () => {
      const resolved = resolveTaskTemplate("fix", "fix sqlite constraint violation on tree create");

      expect(resolved.key).toBe("fix");
      expect(resolved.autoApprove).toBe(false);
      expect(resolved.budget).toEqual({
        maxDepth: 3,
        maxFanOut: 1,
        maxNodes: 3,
        maxConcurrency: 1,
        maxAttemptsPerNode: 1,
      });

      expect(resolved.nodes).toHaveLength(2);

      const first = resolved.nodes[0];
      expect(first).toBeDefined();
      expect(first?.mode).toBe("research");
      expect(first?.outputKind).toBe("artifact");
      expect(first?.parentIndex).toBeUndefined(); // direct child of root
      expect(first?.objective).toBe(
        "Diagnose issue: fix sqlite constraint violation on tree create",
      );
      expect(first?.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
      expect(first?.acceptanceCriteria[0]).toContain(
        "fix sqlite constraint violation on tree create",
      );

      const second = resolved.nodes[1];
      expect(second).toBeDefined();
      expect(second?.mode).toBe("implementation");
      expect(second?.outputKind).toBe("implementation");
      expect(second?.parentIndex).toBe(0); // child of first node -> forms a sequential chain
      expect(second?.objective).toBe(
        "Implement fix: fix sqlite constraint violation on tree create",
      );
      expect(second?.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
      expect(second?.acceptanceCriteria[0]).toContain(
        "fix sqlite constraint violation on tree create",
      );
    });
  });

  describe("resolveTaskTemplate: feature", () => {
    it("resolves to a sequential chain: explore (map) -> implementation (build)", () => {
      const resolved = resolveTaskTemplate("feature", "add dark mode theme support");

      expect(resolved.key).toBe("feature");
      expect(resolved.autoApprove).toBe(false);
      expect(resolved.budget).toEqual({
        maxDepth: 3,
        maxFanOut: 1,
        maxNodes: 3,
        maxConcurrency: 1,
        maxAttemptsPerNode: 1,
      });

      expect(resolved.nodes).toHaveLength(2);

      const first = resolved.nodes[0];
      expect(first).toBeDefined();
      expect(first?.mode).toBe("explore");
      expect(first?.outputKind).toBe("artifact");
      expect(first?.parentIndex).toBeUndefined(); // direct child of root
      expect(first?.objective).toBe("Explore codebase for feature: add dark mode theme support");
      expect(first?.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
      expect(first?.acceptanceCriteria[0]).toContain("add dark mode theme support");

      const second = resolved.nodes[1];
      expect(second).toBeDefined();
      expect(second?.mode).toBe("implementation");
      expect(second?.outputKind).toBe("implementation");
      expect(second?.parentIndex).toBe(0); // child of first node -> forms a sequential chain
      expect(second?.objective).toBe("Implement feature: add dark mode theme support");
      expect(second?.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
      expect(second?.acceptanceCriteria[0]).toContain("add dark mode theme support");
    });
  });
  describe("prompt interpolation and validation", () => {
    it("rejects empty or whitespace-only prompt", () => {
      expect(() => resolveTaskTemplate("explain", "")).toThrow(DomainError);
      expect(() => resolveTaskTemplate("fix", "   ")).toThrow(DomainError);
      expect(() => resolveTaskTemplate("feature", "\t\n")).toThrow(DomainError);
    });

    it("rejects unknown template key", () => {
      expect(() => resolveTaskTemplate("nonexistent", "do something")).toThrow(DomainError);
    });
    it("trims prompt whitespace when interpolating into objectives", () => {
      const resolved = resolveTaskTemplate("explain", "  query plan optimization  ");
      expect(resolved.nodes[0]?.objective).toBe("Explain: query plan optimization");
    });
  });

  describe("domain rule assertions", () => {
    it("prohibits any template with an implementation node from having autoApprove = true", () => {
      const invalidTemplate: TaskTemplateDefinition = {
        key: "fix",
        autoApprove: true,
        budget: {
          maxDepth: 3,
          maxFanOut: 1,
          maxNodes: 3,
          maxConcurrency: 1,
          maxAttemptsPerNode: 1,
        },
        nodes: [
          {
            mode: "implementation",
            objective: (p) => `Implement: ${p}`,
            acceptanceCriteria: [(p) => `Done: ${p}`],
            allowedRepositoryPaths: ["."],
            outputKind: "implementation",
          },
        ],
      };

      expect(() => {
        validateTemplateDefinition(invalidTemplate);
      }).toThrow(DomainError);
      expect(() => {
        validateTemplateDefinition(invalidTemplate);
      }).toThrow(/contains an implementation node and cannot be autoApprove/);
    });

    it("rejects template definitions where budget maxDepth is insufficient for the chain", () => {
      const invalidDepthTemplate: TaskTemplateDefinition = {
        key: "fix",
        autoApprove: false,
        budget: {
          maxDepth: 2, // needs 3 for chain of 2 nodes
          maxFanOut: 1,
          maxNodes: 3,
          maxConcurrency: 1,
          maxAttemptsPerNode: 1,
        },
        nodes: [
          {
            mode: "research",
            objective: (p) => `Research: ${p}`,
            acceptanceCriteria: [(p) => `Done: ${p}`],
            allowedRepositoryPaths: ["."],
            outputKind: "artifact",
          },
          {
            mode: "implementation",
            objective: (p) => `Implement: ${p}`,
            acceptanceCriteria: [(p) => `Done: ${p}`],
            allowedRepositoryPaths: ["."],
            outputKind: "implementation",
            parentIndex: 0,
          },
        ],
      };

      expect(() => {
        validateTemplateDefinition(invalidDepthTemplate);
      }).toThrow(DomainError);
      expect(() => {
        validateTemplateDefinition(invalidDepthTemplate);
      }).toThrow(/less than required depth/);
    });

    it("rejects template definitions where budget maxNodes is insufficient for node count", () => {
      const invalidNodesTemplate: TaskTemplateDefinition = {
        key: "explain",
        autoApprove: true,
        budget: {
          maxDepth: 2,
          maxFanOut: 1,
          maxNodes: 1, // needs 2 (root + 1 child)
          maxConcurrency: 1,
          maxAttemptsPerNode: 1,
        },
        nodes: [
          {
            mode: "research",
            objective: (p) => `Research: ${p}`,
            acceptanceCriteria: [(p) => `Done: ${p}`],
            allowedRepositoryPaths: ["."],
            outputKind: "artifact",
          },
        ],
      };

      expect(() => {
        validateTemplateDefinition(invalidNodesTemplate);
      }).toThrow(DomainError);
      expect(() => {
        validateTemplateDefinition(invalidNodesTemplate);
      }).toThrow(/less than required node count/);
    });

    it("validates all registered templates in the catalog satisfy domain constraints", () => {
      for (const [key, template] of Object.entries(TASK_TEMPLATES)) {
        expect(() => {
          validateTemplateDefinition(template);
        }).not.toThrow();

        const resolved = resolveTaskTemplate(key, "sample prompt");
        expect(resolved.nodes.length).toBeGreaterThanOrEqual(1);

        for (const node of resolved.nodes) {
          expect(node.objective.length).toBeGreaterThan(0);
          expect(node.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);
          for (const ac of node.acceptanceCriteria) {
            expect(ac.length).toBeGreaterThan(0);
          }
          expect(node.allowedRepositoryPaths.length).toBeGreaterThanOrEqual(1);
        }

        if (resolved.nodes.some((n) => n.mode === "implementation")) {
          expect(resolved.autoApprove).toBe(false);
        }
      }
    });
  });
});
