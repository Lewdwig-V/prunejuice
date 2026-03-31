import { query } from "@anthropic-ai/claude-agent-sdk";
// SDK expects Record<string, unknown> for schema; we alias for clarity
type JsonSchema = Record<string, unknown>;
import type { PipelineState, PipelineStage, CoordinatorDecision } from "./types.js";

// -- Agent execution helper --------------------------------------------------

interface AgentQuery {
  systemPrompt: string;
  prompt: string;
  tools: string[];
  cwd: string;
  outputSchema: JsonSchema;
  model?: string;
  maxTurns?: number;
}

export async function queryAgent(params: AgentQuery): Promise<unknown> {
  let result: unknown = undefined;

  for await (const message of query({
    prompt: params.prompt,
    options: {
      systemPrompt: params.systemPrompt,
      allowedTools: params.tools,
      disallowedTools: ["Task", "Agent"],
      cwd: params.cwd,
      model: params.model ?? "claude-sonnet-4-6",
      maxTurns: params.maxTurns ?? 20,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      outputFormat: {
        type: "json_schema",
        schema: params.outputSchema,
      },
      settingSources: [],
      persistSession: false,
    },
  })) {
    if (message.type === "result") {
      if (message.subtype !== "success") {
        const errors = "errors" in message ? (message as { errors: string[] }).errors : [];
        throw new Error(`Agent failed (${message.subtype}): ${errors.join(", ")}`);
      }
      // When outputFormat is set, structured_output contains the parsed result
      const success = message as { result: string; structured_output?: unknown };
      result = success.structured_output ?? JSON.parse(success.result);
    }
  }

  if (result === undefined) {
    throw new Error("Agent produced no result");
  }
  return result;
}

// -- Coordinator (the "hybrid" LLM judgment layer) ---------------------------

const COORDINATOR_PROMPT = `You are the Coordinator — a pipeline supervisor for a multi-agent code generation system.

You are called after each pipeline stage completes, or when the Saboteur delivers its verdict.

Your job is to decide what happens next:
- "proceed": move to the next stage in the pipeline
- "retry": re-run from a specific stage (e.g., if the Saboteur found failures)
- "abort": stop the pipeline (e.g., unrecoverable specification error)

You MUST respond with a single JSON object:
{
  "action": "proceed" | "retry" | "abort",
  "retryFrom": "architect" | "archaeologist" | "mason" | "builder" | "saboteur" (only if action is "retry"),
  "reason": "brief explanation"
}

Decision guidelines:
- If the Saboteur verdict is "pass", proceed (pipeline is done).
- If the Saboteur verdict is "fail" with surviving mutations, retry from "builder" (first attempt) or "mason" (if builder already retried).
- If there are compliance violations, retry from "architect" to refine the spec.
- Never retry more than 2 times total. Abort if still failing.`;

export async function coordinatorDecision(
  state: PipelineState,
  completedStage: PipelineStage,
  retryCount: number
): Promise<CoordinatorDecision> {
  if (retryCount >= 2) {
    return { action: "abort", reason: "Maximum retry count (2) exceeded." };
  }

  // For stages before saboteur, always proceed — no judgment needed
  if (completedStage !== "saboteur") {
    return { action: "proceed", reason: `${completedStage} completed successfully.` };
  }

  // Saboteur completed — LLM decides whether to accept, retry, or abort
  const result = await queryAgent({
    systemPrompt: COORDINATOR_PROMPT,
    prompt: `The Saboteur has completed its analysis. Here is the current pipeline state:

## Saboteur Report
${JSON.stringify(state.saboteurReport, null, 2)}

## Retry Count So Far: ${retryCount}

Decide: proceed, retry (and from which stage), or abort?`,
    tools: [],
    cwd: state.cwd,
    model: "claude-sonnet-4-6",
    maxTurns: 1,
    outputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["proceed", "retry", "abort"] },
        retryFrom: { type: "string", enum: ["architect", "archaeologist", "mason", "builder", "saboteur"] },
        reason: { type: "string" },
      },
      required: ["action", "reason"],
    },
  });

  return result as CoordinatorDecision;
}

// -- Pipeline stages (ordered) -----------------------------------------------

export const STAGE_ORDER: PipelineStage[] = [
  "architect",
  "archaeologist",
  "mason",
  "builder",
  "saboteur",
];

export function nextStage(current: PipelineStage): PipelineStage | null {
  const idx = STAGE_ORDER.indexOf(current);
  return idx < STAGE_ORDER.length - 1 ? STAGE_ORDER[idx + 1]! : null;
}
