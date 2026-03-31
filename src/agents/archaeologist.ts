import type { Spec, ConcreteSpec } from "../types.js";
import { queryAgent } from "../pipeline.js";

const SYSTEM_PROMPT = `You are the Archaeologist — a codebase analyst and strategy projector.

Your job is to examine existing code, infer patterns, refine an abstract spec into a concrete implementation strategy, and derive a behavioural contract.

## Process
1. Read the codebase to understand existing patterns, conventions, and architecture.
2. Identify integration points where the new spec touches existing code.
3. Project a strategy: which files to modify/create, which patterns to follow.
4. Refine the original spec with concrete details grounded in the codebase.
5. Derive a behavioural contract that captures the expected behaviour as testable preconditions, postconditions, invariants, and scenarios. Ground these in what the code should do, informed by what it currently does and what the spec requires.
6. Surface any correctness requirements implied by the strategy that the spec doesn't explicitly state. These are "discovered" items — transient findings that must be resolved (promoted to the spec or dismissed) before generation proceeds.

## Output Format
You MUST respond with a single JSON object (no markdown fences, no commentary):
{
  "existingPatterns": ["patterns found in the codebase"],
  "integrationPoints": ["where new code connects to existing code"],
  "fileTargets": ["files to create or modify"],
  "strategyProjection": "narrative of the implementation approach",
  "refinedSpec": { ...original spec with refinements... },
  "behaviourContract": {
    "name": "PascalCase name for the component",
    "preconditions": ["conditions that must hold before the component is used"],
    "postconditions": ["conditions guaranteed after successful operation"],
    "invariants": ["properties that always hold"],
    "scenarios": [
      { "given": "initial state", "when": "action", "then": "expected outcome" }
    ]
  },
  "discovered": [
    { "title": "short name", "observation": "what you found", "question": "what the human should decide" }
  ]
}

Ground every recommendation in what you actually observe in the code. Do not speculate about code you haven't read.
The behavioural contract is consumed by a separate test-generation agent that has NO access to the codebase — make the contract self-contained and precise enough to generate tests without seeing source code.
The "discovered" array should be empty if all correctness requirements are covered by the spec. Only surface genuine ambiguities — not things the spec already addresses.`;

const TOOLS = ["Read", "Grep", "Glob", "LS", "Bash"] as const;

export async function runArchaeologist(spec: Spec, cwd: string): Promise<ConcreteSpec> {
  const result = await queryAgent({
    systemPrompt: SYSTEM_PROMPT,
    prompt: `Given this specification, analyze the codebase and produce a concrete implementation strategy.\n\nSpecification:\n${JSON.stringify(spec, null, 2)}`,
    tools: [...TOOLS],
    cwd,
    outputSchema: {
      type: "object",
      properties: {
        existingPatterns: { type: "array", items: { type: "string" } },
        integrationPoints: { type: "array", items: { type: "string" } },
        fileTargets: { type: "array", items: { type: "string" } },
        strategyProjection: { type: "string" },
        refinedSpec: {
          type: "object",
          properties: {
            intent: { type: "string" },
            requirements: { type: "array", items: { type: "string" } },
            constraints: { type: "array", items: { type: "string" } },
            acceptanceCriteria: { type: "array", items: { type: "string" } },
          },
          required: ["intent", "requirements", "constraints", "acceptanceCriteria"],
        },
        behaviourContract: {
          type: "object",
          properties: {
            name: { type: "string" },
            preconditions: { type: "array", items: { type: "string" } },
            postconditions: { type: "array", items: { type: "string" } },
            invariants: { type: "array", items: { type: "string" } },
            scenarios: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  given: { type: "string" },
                  when: { type: "string" },
                  then: { type: "string" },
                },
                required: ["given", "when", "then"],
              },
            },
          },
          required: ["name", "preconditions", "postconditions", "invariants", "scenarios"],
        },
        discovered: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              observation: { type: "string" },
              question: { type: "string" },
            },
            required: ["title", "observation", "question"],
          },
        },
      },
      required: ["existingPatterns", "integrationPoints", "fileTargets", "strategyProjection", "refinedSpec", "behaviourContract", "discovered"],
    },
  });

  return result as ConcreteSpec;
}
