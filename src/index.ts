#!/usr/bin/env node

import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { runArchitect } from "./agents/architect.js";
import { runArchaeologist } from "./agents/archaeologist.js";
import { runMason } from "./agents/mason.js";
import { runBuilder } from "./agents/builder.js";
import { runSaboteur } from "./agents/saboteur.js";
import {
  evaluateConvergence,
  validateSaboteurReport,
  STAGE_ORDER,
  nextStage,
  runStagesFrom,
  MAX_CONVERGENCE_ITERATIONS,
} from "./pipeline.js";
import {
  ensureStore,
  savePipelineState,
  loadPipelineState,
  writeImplementationFiles,
  writeTestFiles,
} from "./store.js";
import type { PipelineState, PipelineStage, DiscoveredItem, DiscoveryResolution } from "./types.js";

function log(stage: string, msg: string) {
  const timestamp = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${timestamp}] [${stage}] ${msg}\n`);
}

/** Deterministic timestamp for the current pipeline run. Injected into all managed file headers. */
function pipelineTimestamp(): string {
  return new Date().toISOString();
}

// -- Pipeline invariant assertions -------------------------------------------

function requireState<T>(value: T | undefined, name: string, requiredBy: string): T {
  if (value === undefined) {
    throw new Error(`Pipeline invariant violated: ${requiredBy} requires ${name}, but it is undefined. Check stage ordering.`);
  }
  return value;
}

// -- Discovery gate: pause and ask the human about discovered items ----------

async function discoveryGate(discovered: DiscoveredItem[]): Promise<void> {
  if (discovered.length === 0) return;

  log("discovery-gate", `Archaeologist discovered ${discovered.length} item(s) requiring human review:`);
  for (const item of discovered) {
    process.stderr.write(`\n  ★ ${item.title}\n`);
    process.stderr.write(`    Observation: ${item.observation}\n`);
    process.stderr.write(`    Question: ${item.question}\n`);
  }
  process.stderr.write("\n");

  const rl = createInterface({ input: process.stdin, output: process.stderr });

  for (const item of discovered) {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`  [${item.title}] Promote to spec, dismiss, or defer? (p/d/f): `, (ans) => {
        resolve(ans.trim().toLowerCase());
      });
    });

    const resolutionMap: Record<string, DiscoveryResolution> = {
      p: "promoted", promote: "promoted",
      d: "dismissed", dismiss: "dismissed",
      f: "deferred", defer: "deferred",
    };
    item.resolution = resolutionMap[answer] ?? "deferred";
    log("discovery-gate", `${item.title}: ${item.resolution}`);
  }

  rl.close();
}

// -- Stage execution ---------------------------------------------------------

async function runStage(stage: PipelineStage, state: PipelineState): Promise<void> {
  const ts = pipelineTimestamp();

  switch (stage) {
    case "architect": {
      log("architect", "Eliciting specification from user intent...");
      state.spec = await runArchitect(state.userIntent, state.cwd);
      log("architect", `Produced spec with ${state.spec.requirements.length} requirements.`);
      break;
    }
    case "archaeologist": {
      const spec = requireState(state.spec, "spec", "Archaeologist");
      log("archaeologist", "Analyzing codebase and refining spec...");
      state.concreteSpec = await runArchaeologist(spec, state.cwd);
      state.behaviourContract = state.concreteSpec.behaviourContract;
      log("archaeologist", `Strategy targets ${state.concreteSpec.fileTargets.length} files. Derived behaviour contract: ${state.behaviourContract.name}`);
      if (state.concreteSpec.discovered.length > 0) {
        log("archaeologist", `Discovered ${state.concreteSpec.discovered.length} item(s) for human review.`);
      }
      break;
    }
    case "discovery-gate": {
      const concreteSpec = requireState(state.concreteSpec, "concreteSpec", "Discovery gate");
      await discoveryGate(concreteSpec.discovered);
      break;
    }
    case "mason": {
      const behaviourContract = requireState(state.behaviourContract, "behaviourContract", "Mason");
      log("mason", "Generating tests from behavioural contract...");
      state.tests = await runMason(behaviourContract);
      log("mason", `Generated ${state.tests.testFilePaths.length} test file(s).`);
      await writeTestFiles(state.cwd, state.tests, ts);
      log("mason", "Wrote managed test files with hash chain headers.");
      break;
    }
    case "builder": {
      const concreteSpec = requireState(state.concreteSpec, "concreteSpec", "Builder");
      const tests = requireState(state.tests, "tests", "Builder");
      log("builder", "Implementing from spec + tests...");
      state.implementation = await runBuilder(
        concreteSpec.refinedSpec,
        concreteSpec,
        tests,
        state.cwd
      );
      log("builder", `Wrote ${state.implementation.files.length} file(s): ${state.implementation.summary}`);
      await writeImplementationFiles(state.cwd, state.implementation, ts);
      log("builder", "Wrote managed implementation files with hash chain headers.");
      break;
    }
    case "saboteur": {
      const concreteSpec = requireState(state.concreteSpec, "concreteSpec", "Saboteur");
      const tests = requireState(state.tests, "tests", "Saboteur");
      const implementation = requireState(state.implementation, "implementation", "Saboteur");
      log("saboteur", "Running mutation testing and compliance checks...");
      const rawReport = await runSaboteur(concreteSpec.refinedSpec, tests, implementation, state.cwd);
      state.saboteurReport = validateSaboteurReport(rawReport);
      state.killRateHistory.push(state.saboteurReport.killRate);
      const killed = state.saboteurReport.mutationResults.filter((m) => m.killed).length;
      const total = state.saboteurReport.mutationResults.length;
      log("saboteur", `Verdict: ${state.saboteurReport.verdict} | Kill rate: ${(state.saboteurReport.killRate * 100).toFixed(1)}% (${killed}/${total} mutations killed)`);
      break;
    }
  }

  // Persist after each stage
  await savePipelineState(state.cwd, state);
}

// -- Main pipeline loop ------------------------------------------------------

async function main() {
  const userIntent = process.argv.slice(2).join(" ");
  if (!userIntent) {
    console.error("Usage: prunejuice <intent>");
    console.error('  e.g.: prunejuice "Add a rate limiter middleware with sliding window"');
    process.exit(1);
  }

  const cwd = resolve(process.cwd());
  await ensureStore(cwd);

  // Check for existing state (incremental runs)
  const existing = await loadPipelineState(cwd);
  const hasExistingState = Object.keys(existing).length > 0;
  if (hasExistingState) {
    log("coordinator", "Found existing pipeline state from a previous run.");
  }

  // Existing state first, then explicit overrides — explicit values always win
  const state: PipelineState = {
    ...existing,
    userIntent,
    cwd,
    convergenceIteration: existing.convergenceIteration ?? 0,
    killRateHistory: existing.killRateHistory ?? [],
    radicalHardeningAttempted: existing.radicalHardeningAttempted ?? false,
  };

  let currentStage: PipelineStage = STAGE_ORDER[0]!;

  log("coordinator", `Pipeline starting. Intent: "${userIntent}"`);
  log("coordinator", `Working directory: ${cwd}`);

  // -- Forward pass: Architect → Archaeologist → Discovery Gate → Mason → Builder → Saboteur
  while (true) {
    await runStage(currentStage, state);

    const next = nextStage(currentStage);
    if (!next) break; // Saboteur completed, enter convergence evaluation
    currentStage = next;
  }

  // -- Convergence loop (Section 6 of the paper)
  while (true) {
    const convergence = evaluateConvergence(state);
    log("coordinator", `Convergence: ${convergence.action} — ${convergence.reason}`);

    if (convergence.converged) {
      log("coordinator", "Pipeline converged successfully.");
      break;
    }

    if (convergence.action === "abort") {
      log("coordinator", "Pipeline aborted — convergence not achievable.");
      process.stdout.write(JSON.stringify({
        status: "aborted",
        reason: convergence.reason,
        killRateHistory: state.killRateHistory,
        saboteurReport: state.saboteurReport,
      }, null, 2));
      process.exit(1);
    }

    state.convergenceIteration++;

    if (convergence.action === "radical-harden") {
      state.radicalHardeningAttempted = true;
      log("coordinator", "Radical spec hardening — re-running from Archaeologist with mutation feedback.");
      const spec = requireState(state.spec, "spec", "Radical hardening");
      if (state.saboteurReport) {
        const survivorSummary = state.saboteurReport.mutationResults
          .filter((m) => !m.killed)
          .map((m) => `- ${m.mutation}: ${m.details} (${!m.killed ? m.classification : "killed"})`)
          .join("\n");
        spec.constraints.push(
          `[MUTATION FEEDBACK] The following mutations survived testing and must be addressed:\n${survivorSummary}`
        );
      }
      await runStagesFrom("archaeologist", state, runStage);
      continue;
    }

    if (convergence.action === "retry-architect") {
      log("coordinator", `Re-running from Archaeologist (iteration ${state.convergenceIteration}/${MAX_CONVERGENCE_ITERATIONS})`);
      if (convergence.routing) {
        const spec = requireState(state.spec, "spec", "Convergence retry-architect");
        const gaps = convergence.routing.architectTargets.join("\n- ");
        spec.constraints.push(
          `[SPEC GAP FEEDBACK] The following behaviours are under-constrained:\n- ${gaps}`
        );
      }
      await runStagesFrom("archaeologist", state, runStage);
      continue;
    }

    if (convergence.action === "retry-mason") {
      log("coordinator", `Re-running from Mason (iteration ${state.convergenceIteration}/${MAX_CONVERGENCE_ITERATIONS})`);
      if (convergence.routing) {
        const behaviourContract = requireState(state.behaviourContract, "behaviourContract", "Convergence retry-mason");
        const weakTests = convergence.routing.masonTargets;
        behaviourContract.invariants.push(
          ...weakTests.map((t) => `[STRENGTHEN] Test gap: ${t}`)
        );
      }
      await runStagesFrom("mason", state, runStage);
      continue;
    }
  }

  // -- Pipeline complete
  log("coordinator", "Pipeline complete.");
  process.stdout.write(JSON.stringify({
    status: "complete",
    convergenceIterations: state.convergenceIteration,
    killRateHistory: state.killRateHistory,
    spec: state.spec,
    concreteSpec: state.concreteSpec,
    tests: { filePaths: state.tests?.testFilePaths, coverageTargets: state.tests?.coverageTargets },
    implementation: { files: state.implementation?.files.map((f) => f.path), summary: state.implementation?.summary },
    saboteurReport: state.saboteurReport,
  }, null, 2));
}

main().catch((err) => {
  log("fatal", `Pipeline crashed: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
