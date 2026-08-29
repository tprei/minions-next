import { DomainError } from "./domain-error.js";
import type { TaskNodeMode } from "./task-node.js";
import { nonEmptyText } from "./value-objects.js";

export type TaskTemplateKey = "explain" | "fix" | "feature";

export type TaskTemplateBudget = Readonly<{
  maxDepth: number;
  maxFanOut: number;
  maxNodes: number;
  maxConcurrency: number;
  maxAttemptsPerNode: number;
}>;

export type TemplateNodeShape = Readonly<{
  mode: TaskNodeMode;
  objective: (prompt: string) => string;
  acceptanceCriteria: readonly ((prompt: string) => string)[];
  allowedRepositoryPaths: readonly string[];
  outputKind: "artifact" | "implementation";
  parentIndex?: number | undefined;
}>;

export type TaskTemplateDefinition = Readonly<{
  key: TaskTemplateKey;
  nodes: readonly TemplateNodeShape[];
  budget: TaskTemplateBudget;
  autoApprove: boolean;
}>;

export type ResolvedTemplateNode = Readonly<{
  mode: TaskNodeMode;
  objective: string;
  acceptanceCriteria: readonly string[];
  allowedRepositoryPaths: readonly string[];
  outputKind: "artifact" | "implementation";
  parentIndex?: number | undefined;
}>;

export type ResolvedTaskTemplate = Readonly<{
  key: TaskTemplateKey;
  nodes: readonly ResolvedTemplateNode[];
  budget: TaskTemplateBudget;
  autoApprove: boolean;
}>;

export function validateTemplateDefinition(definition: TaskTemplateDefinition): void {
  const depths: number[] = [];
  for (let i = 0; i < definition.nodes.length; i++) {
    const node = definition.nodes[i];
    if (node === undefined) continue;

    if (node.mode === "implementation" && node.outputKind !== "implementation") {
      throw new DomainError(
        "invalid_value",
        `node ${i.toString()} in template "${definition.key}" is implementation mode but has outputKind "${node.outputKind}"`,
      );
    }
    if (node.mode !== "implementation" && node.outputKind === "implementation") {
      throw new DomainError(
        "invalid_value",
        `node ${i.toString()} in template "${definition.key}" is ${node.mode} mode but has implementation outputKind`,
      );
    }

    if (node.parentIndex === undefined) {
      depths[i] = 2;
    } else {
      if (node.parentIndex < 0 || node.parentIndex >= i) {
        throw new DomainError(
          "invalid_value",
          `node ${i.toString()} in template "${definition.key}" has invalid parentIndex ${node.parentIndex.toString()}`,
        );
      }
      const parentDepth = depths[node.parentIndex];
      if (parentDepth === undefined) {
        throw new DomainError(
          "invalid_value",
          `node ${i.toString()} parent ${node.parentIndex.toString()} has no computed depth`,
        );
      }
      depths[i] = parentDepth + 1;
    }
  }

  const maxComputedDepth = Math.max(2, ...depths);
  const requiredNodes = Math.max(2, definition.nodes.length + 1);

  if (definition.budget.maxDepth < maxComputedDepth) {
    throw new DomainError(
      "invalid_value",
      `template "${definition.key}" budget maxDepth (${definition.budget.maxDepth.toString()}) is less than required depth (${maxComputedDepth.toString()})`,
    );
  }
  if (definition.budget.maxNodes < requiredNodes) {
    throw new DomainError(
      "invalid_value",
      `template "${definition.key}" budget maxNodes (${definition.budget.maxNodes.toString()}) is less than required node count (${requiredNodes.toString()})`,
    );
  }
  if (definition.budget.maxDepth < 2) {
    throw new DomainError("invalid_value", "maxDepth must be at least 2");
  }
  if (definition.budget.maxNodes < 2) {
    throw new DomainError("invalid_value", "maxNodes must be at least 2");
  }
}

export const TASK_TEMPLATES: Readonly<Record<TaskTemplateKey, TaskTemplateDefinition>> =
  Object.freeze({
    explain: Object.freeze({
      key: "explain",
      autoApprove: true,
      budget: Object.freeze({
        maxDepth: 2,
        maxFanOut: 1,
        maxNodes: 2,
        maxConcurrency: 1,
        maxAttemptsPerNode: 1,
      }),
      nodes: Object.freeze([
        Object.freeze({
          mode: "research",
          objective: (prompt: string) => `Explain: ${prompt}`,
          acceptanceCriteria: Object.freeze([
            (prompt: string) => `Provide detailed analysis and explanation for: ${prompt}`,
            () => "Document findings and architectural analysis in the research report",
          ]),
          allowedRepositoryPaths: Object.freeze(["."]),
          outputKind: "artifact",
        }),
      ]),
    }),
    fix: Object.freeze({
      key: "fix",
      autoApprove: true,
      budget: Object.freeze({
        maxDepth: 3,
        maxFanOut: 1,
        maxNodes: 3,
        maxConcurrency: 1,
        maxAttemptsPerNode: 1,
      }),
      nodes: Object.freeze([
        Object.freeze({
          mode: "research",
          objective: (prompt: string) => `Diagnose issue: ${prompt}`,
          acceptanceCriteria: Object.freeze([
            (prompt: string) => `Identify root cause and reproduction steps for: ${prompt}`,
            () => "Document findings and proposed fix strategy in the diagnostic report",
          ]),
          allowedRepositoryPaths: Object.freeze(["."]),
          outputKind: "artifact",
        }),
        Object.freeze({
          mode: "implementation",
          objective: (prompt: string) => `Implement fix: ${prompt}`,
          acceptanceCriteria: Object.freeze([
            (prompt: string) => `Implement fix addressing root cause for: ${prompt}`,
            () => "Verify all existing and regression tests pass",
          ]),
          allowedRepositoryPaths: Object.freeze(["."]),
          outputKind: "implementation",
          parentIndex: 0,
        }),
      ]),
    }),
    feature: Object.freeze({
      key: "feature",
      autoApprove: true,
      budget: Object.freeze({
        maxDepth: 3,
        maxFanOut: 1,
        maxNodes: 3,
        maxConcurrency: 1,
        maxAttemptsPerNode: 1,
      }),
      nodes: Object.freeze([
        Object.freeze({
          mode: "explore",
          objective: (prompt: string) => `Explore codebase for feature: ${prompt}`,
          acceptanceCriteria: Object.freeze([
            (prompt: string) =>
              `Map affected components, interfaces, and dependencies for: ${prompt}`,
            () => "Document architectural scope and implementation plan in the exploration report",
          ]),
          allowedRepositoryPaths: Object.freeze(["."]),
          outputKind: "artifact",
        }),
        Object.freeze({
          mode: "implementation",
          objective: (prompt: string) => `Implement feature: ${prompt}`,
          acceptanceCriteria: Object.freeze([
            (prompt: string) => `Implement feature requirements for: ${prompt}`,
            () => "Add test coverage and verify all tests pass",
          ]),
          allowedRepositoryPaths: Object.freeze(["."]),
          outputKind: "implementation",
          parentIndex: 0,
        }),
      ]),
    }),
  });

for (const template of Object.values(TASK_TEMPLATES)) {
  validateTemplateDefinition(template);
}

export function resolveTaskTemplate(key: string, prompt: string): ResolvedTaskTemplate {
  const cleanPrompt = nonEmptyText(prompt, "template prompt").trim();
  const template = Object.values(TASK_TEMPLATES).find((candidate) => candidate.key === key);
  if (template === undefined) {
    throw new DomainError("invalid_value", `unknown task template "${key}"`);
  }

  const nodes: ResolvedTemplateNode[] = template.nodes.map((node) => {
    const objective = node.objective(cleanPrompt).trim();
    if (objective.length === 0) {
      throw new DomainError("invalid_value", "node objective must not be empty");
    }
    const acceptanceCriteria = node.acceptanceCriteria
      .map((fn) => fn(cleanPrompt).trim())
      .filter((criterion) => criterion.length > 0);
    if (acceptanceCriteria.length === 0) {
      throw new DomainError(
        "invalid_value",
        "node must have at least one non-empty acceptance criterion",
      );
    }
    return Object.freeze({
      mode: node.mode,
      objective,
      acceptanceCriteria: Object.freeze(acceptanceCriteria),
      allowedRepositoryPaths: Object.freeze([...node.allowedRepositoryPaths]),
      outputKind: node.outputKind,
      ...(node.parentIndex !== undefined ? { parentIndex: node.parentIndex } : {}),
    });
  });

  return Object.freeze({
    key: template.key,
    nodes: Object.freeze(nodes),
    budget: Object.freeze({ ...template.budget }),
    autoApprove: template.autoApprove,
  });
}
