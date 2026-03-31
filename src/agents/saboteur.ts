import type { Spec, GeneratedTests, Implementation, SaboteurReport } from "../types.js";
import { queryAgent } from "../pipeline.js";

const SYSTEM_PROMPT = `You are the Saboteur — a mutation testing and constitutional compliance specialist.

Your job is to stress-test the implementation by:
1. Proposing mutations to the source code and checking if tests catch them.
2. Verifying the implementation complies with the specification's constraints.

## What You See
- The specification (intent, requirements, constraints, acceptance criteria)
- The generated tests
- The implementation code

## What You Do NOT See
- How the Builder arrived at the implementation (Builder's generation logic is hidden)

## Process
1. Read the implementation and tests.
2. Propose targeted mutations (off-by-one, boundary conditions, missing null checks, swapped arguments, removed conditions).
3. For each mutation, determine whether the test suite would catch it.
4. Check each spec constraint against the implementation for compliance.
5. Deliver a verdict: pass or fail.

## Output Format
You MUST respond with a single JSON object (no markdown fences, no commentary):
{
  "mutationResults": [
    { "mutation": "description of the mutation", "killed": true/false, "details": "why it was/wasn't caught" }
  ],
  "complianceViolations": ["any spec constraints the implementation violates"],
  "verdict": "pass" or "fail",
  "recommendations": ["actionable fixes if verdict is fail"]
}

Be adversarial. Your value comes from finding what others missed.`;

const TOOLS = ["Read", "Grep", "Glob", "LS", "Bash"] as const;

export async function runSaboteur(
  spec: Spec,
  tests: GeneratedTests,
  implementation: Implementation,
  cwd: string
): Promise<SaboteurReport> {
  const result = await queryAgent({
    systemPrompt: SYSTEM_PROMPT,
    prompt: `Perform mutation testing and compliance checking on this implementation.

## Specification
${JSON.stringify(spec, null, 2)}

## Tests
${tests.testCode}

## Implementation
${implementation.files.map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join("\n\n")}`,
    tools: [...TOOLS],
    cwd,
    outputSchema: {
      type: "object",
      properties: {
        mutationResults: {
          type: "array",
          items: {
            type: "object",
            properties: {
              mutation: { type: "string" },
              killed: { type: "boolean" },
              details: { type: "string" },
            },
            required: ["mutation", "killed", "details"],
          },
        },
        complianceViolations: { type: "array", items: { type: "string" } },
        verdict: { type: "string", enum: ["pass", "fail"] },
        recommendations: { type: "array", items: { type: "string" } },
      },
      required: ["mutationResults", "complianceViolations", "verdict", "recommendations"],
    },
  });

  return result as SaboteurReport;
}
