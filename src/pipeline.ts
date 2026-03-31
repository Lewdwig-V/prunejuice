import { query } from "@anthropic-ai/claude-agent-sdk";
// SDK expects Record<string, unknown> for schema; we alias for clarity
type JsonSchema = Record<string, unknown>;
import type {
  PipelineState,
  PipelineStage,
  CoordinatorDecision,
  SurvivorClassification,
  SurvivorRouting,
} from "./types.js";

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

// -- Survivor routing (pure function, user-contributed) ----------------------

export function routeSurvivors(
  survivors: Array<{ mutation: string; classification: SurvivorClassification }>
): SurvivorRouting {
  const masonTargets: string[] = [];
  const architectTargets: string[] = [];
  const skipped: string[] = [];

  for (const { mutation, classification } of survivors) {
    if (classification === "weak_test") masonTargets.push(mutation);
    else if (classification === "spec_gap") architectTargets.push(mutation);
    else skipped.push(mutation);
  }

  return { masonTargets, architectTargets, skipped };
}

// -- Convergence loop --------------------------------------------------------

const KILL_RATE_THRESHOLD = 0.8;
const MAX_CONVERGENCE_ITERATIONS = 3;
const ENTROPY_IMPROVEMENT_THRESHOLD = 0.05;

export interface ConvergenceResult {
  converged: boolean;
  action: "proceed" | "retry-mason" | "retry-architect" | "radical-harden" | "abort";
  reason: string;
  routing?: SurvivorRouting;
}

export function evaluateConvergence(state: PipelineState): ConvergenceResult {
  const report = state.saboteurReport;
  if (!report) {
    return { converged: false, action: "abort", reason: "No Saboteur report available" };
  }

  // Pass: kill rate above threshold and no compliance violations
  if (report.killRate >= KILL_RATE_THRESHOLD && report.complianceViolations.length === 0) {
    return { converged: true, action: "proceed", reason: `Kill rate ${(report.killRate * 100).toFixed(1)}% >= ${KILL_RATE_THRESHOLD * 100}%` };
  }

  // Max iterations exceeded
  if (state.convergenceIteration >= MAX_CONVERGENCE_ITERATIONS) {
    // One last shot: radical spec hardening (Section 6 of the paper)
    if (state.convergenceIteration === MAX_CONVERGENCE_ITERATIONS) {
      return {
        converged: false,
        action: "radical-harden",
        reason: `${MAX_CONVERGENCE_ITERATIONS} iterations exhausted, attempting radical spec hardening`,
      };
    }
    return {
      converged: false,
      action: "abort",
      reason: `Radical hardening did not achieve convergence. Final kill rate: ${(report.killRate * 100).toFixed(1)}%`,
    };
  }

  // Entropy stall detection: if kill rate improved by less than 5%, the loop is stalling
  if (state.killRateHistory.length >= 2) {
    const prev = state.killRateHistory[state.killRateHistory.length - 2]!;
    const curr = state.killRateHistory[state.killRateHistory.length - 1]!;
    if (curr - prev < ENTROPY_IMPROVEMENT_THRESHOLD) {
      return {
        converged: false,
        action: "radical-harden",
        reason: `Entropy stall: kill rate improved only ${((curr - prev) * 100).toFixed(1)}% (< ${ENTROPY_IMPROVEMENT_THRESHOLD * 100}% threshold)`,
      };
    }
  }

  // Route survivors to responsible agents
  const survivors = report.mutationResults
    .filter((m) => !m.killed && m.classification)
    .map((m) => ({ mutation: m.mutation, classification: m.classification! }));

  const routing = routeSurvivors(survivors);

  // Decide which agent to retry based on routing
  if (routing.architectTargets.length > 0 && routing.masonTargets.length > 0) {
    // Both need work — start from Architect (spec gaps first, then Mason gets updated contract)
    return {
      converged: false,
      action: "retry-architect",
      reason: `${routing.architectTargets.length} spec gaps + ${routing.masonTargets.length} weak tests`,
      routing,
    };
  }
  if (routing.architectTargets.length > 0) {
    return {
      converged: false,
      action: "retry-architect",
      reason: `${routing.architectTargets.length} spec gaps to resolve`,
      routing,
    };
  }
  if (routing.masonTargets.length > 0) {
    return {
      converged: false,
      action: "retry-mason",
      reason: `${routing.masonTargets.length} weak tests to strengthen`,
      routing,
    };
  }

  // All survivors are equivalent but kill rate still below threshold — something is off
  return {
    converged: false,
    action: "abort",
    reason: `Kill rate ${(report.killRate * 100).toFixed(1)}% below threshold but all survivors classified equivalent — Saboteur classification may be drifting`,
  };
}

// -- Coordinator (hybrid LLM judgment for ambiguous freshness states) --------

const COORDINATOR_PROMPT = `You are the Coordinator — a pipeline supervisor for a multi-agent code generation system.

You are called when the pipeline encounters an ambiguous state that requires judgment:
- A generated file was manually edited ("modified" state)
- Both the spec and code changed independently ("conflict" state)
- An upstream dependency changed ("ghost-stale" state)

Your job is to decide what happens next:
- "proceed": accept the current state and continue
- "retry": re-run from a specific stage
- "abort": stop the pipeline

You MUST respond with a single JSON object:
{
  "action": "proceed" | "retry" | "abort",
  "retryFrom": "architect" | "archaeologist" | "mason" | "builder" | "saboteur" (only if action is "retry"),
  "reason": "brief explanation"
}`;

export async function coordinatorDecision(
  state: PipelineState,
  context: string
): Promise<CoordinatorDecision> {
  const result = await queryAgent({
    systemPrompt: COORDINATOR_PROMPT,
    prompt: context,
    tools: [],
    cwd: state.cwd,
    model: "claude-sonnet-4-6",
    maxTurns: 1,
    outputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["proceed", "retry", "abort"] },
        retryFrom: { type: "string", enum: ["architect", "archaeologist", "discovery-gate", "mason", "builder", "saboteur"] },
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
  "discovery-gate",
  "mason",
  "builder",
  "saboteur",
];

export function nextStage(current: PipelineStage): PipelineStage | null {
  const idx = STAGE_ORDER.indexOf(current);
  return idx < STAGE_ORDER.length - 1 ? STAGE_ORDER[idx + 1]! : null;
}
