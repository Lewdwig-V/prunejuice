#!/usr/bin/env node

import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { runArchitect } from "./agents/architect.js";
import { runArchaeologist } from "./agents/archaeologist.js";
import { runMason } from "./agents/mason.js";
import { runBuilder } from "./agents/builder.js";
import { runSaboteur } from "./agents/saboteur.js";
import {
  coordinatorDecision,
  evaluateConvergence,
  STAGE_ORDER,
  nextStage,
} from "./pipeline.js";
import {
  ensureStore,
  savePipelineState,
  loadPipelineState,
  writeImplementationFiles,
  writeTestFiles,
} from "./store.js";
import type { PipelineState, PipelineStage, DiscoveredItem } from "./types.js";

function log(stage: string, msg: string) {
  const timestamp = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${timestamp}] [${stage}] ${msg}\n`);
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
  await new Promise<void>((resolve) => {
    rl.question("Press Enter to acknowledge and continue (discoveries will be noted but not auto-resolved)... ", () => {
      rl.close();
      resolve();
    });
  });
}

// -- Stage execution ---------------------------------------------------------

async function runStage(stage: PipelineStage, state: PipelineState): Promise<void> {
  switch (stage) {
    case "architect": {
      log("architect", "Eliciting specification from user intent...");
      state.spec = await runArchitect(state.userIntent, state.cwd);
      log("architect", `Produced spec with ${state.spec.requirements.length} requirements.`);
      break;
    }
    case "archaeologist": {
      log("archaeologist", "Analyzing codebase and refining spec...");
      state.concreteSpec = await runArchaeologist(state.spec!, state.cwd);
      state.behaviourContract = state.concreteSpec.behaviourContract;
      log("archaeologist", `Strategy targets ${state.concreteSpec.fileTargets.length} files. Derived behaviour contract: ${state.behaviourContract.name}`);
      if (state.concreteSpec.discovered.length > 0) {
        log("archaeologist", `Discovered ${state.concreteSpec.discovered.length} item(s) for human review.`);
      }
      break;
    }
    case "discovery-gate": {
      await discoveryGate(state.concreteSpec?.discovered ?? []);
      break;
    }
    case "mason": {
      log("mason", "Generating tests from behavioural contract...");
      state.tests = await runMason(state.behaviourContract!);
      log("mason", `Generated ${state.tests.testFilePaths.length} test file(s).`);
      // Write test files with managed headers (hash chain)
      await writeTestFiles(state.cwd, state.tests);
      log("mason", "Wrote managed test files with hash chain headers.");
      break;
    }
    case "builder": {
      log("builder", "Implementing from spec + tests...");
      state.implementation = await runBuilder(
        state.concreteSpec!.refinedSpec,
        state.concreteSpec!,
        state.tests!,
        state.cwd
      );
      log("builder", `Wrote ${state.implementation.files.length} file(s): ${state.implementation.summary}`);
      // Write implementation files with managed headers (hash chain)
      await writeImplementationFiles(state.cwd, state.implementation);
      log("builder", "Wrote managed implementation files with hash chain headers.");
      break;
    }
    case "saboteur": {
      log("saboteur", "Running mutation testing and compliance checks...");
      state.saboteurReport = await runSaboteur(
        state.concreteSpec!.refinedSpec,
        state.tests!,
        state.implementation!,
        state.cwd
      );
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

  const state: PipelineState = {
    userIntent,
    cwd,
    convergenceIteration: 0,
    killRateHistory: [],
    ...existing,
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
      // Radical spec hardening: re-run full pipeline from Archaeologist
      // with surviving mutant analysis as additional input
      log("coordinator", "Radical spec hardening — re-running from Archaeologist with mutation feedback.");
      // Enrich the spec with mutation survivors for the Archaeologist to absorb
      if (state.spec && state.saboteurReport) {
        const survivorSummary = state.saboteurReport.mutationResults
          .filter((m) => !m.killed)
          .map((m) => `- ${m.mutation}: ${m.details} (${m.classification ?? "unclassified"})`)
          .join("\n");
        state.spec.constraints.push(
          `[MUTATION FEEDBACK] The following mutations survived testing and must be addressed:\n${survivorSummary}`
        );
      }
      // Re-run from Archaeologist through Saboteur
      for (const stage of ["archaeologist", "discovery-gate", "mason", "builder", "saboteur"] as PipelineStage[]) {
        await runStage(stage, state);
      }
      continue;
    }

    if (convergence.action === "retry-architect") {
      // Spec gaps: re-run from Archaeologist to enrich behaviour contract
      log("coordinator", `Re-running from Archaeologist (iteration ${state.convergenceIteration}/${3})`);
      if (convergence.routing && state.spec) {
        const gaps = convergence.routing.architectTargets.join("\n- ");
        state.spec.constraints.push(
          `[SPEC GAP FEEDBACK] The following behaviours are under-constrained:\n- ${gaps}`
        );
      }
      for (const stage of ["archaeologist", "discovery-gate", "mason", "builder", "saboteur"] as PipelineStage[]) {
        await runStage(stage, state);
      }
      continue;
    }

    if (convergence.action === "retry-mason") {
      // Weak tests: re-run Mason and Builder only
      log("coordinator", `Re-running from Mason (iteration ${state.convergenceIteration}/${3})`);
      if (convergence.routing && state.behaviourContract) {
        // Feed weak test descriptions back to Mason via enriched contract invariants
        const weakTests = convergence.routing.masonTargets;
        state.behaviourContract.invariants.push(
          ...weakTests.map((t) => `[STRENGTHEN] Test gap: ${t}`)
        );
      }
      for (const stage of ["mason", "builder", "saboteur"] as PipelineStage[]) {
        await runStage(stage, state);
      }
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
  console.error("Fatal error:", err);
  process.exit(1);
});
