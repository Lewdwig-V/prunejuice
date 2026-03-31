#!/usr/bin/env node

import { resolve } from "node:path";
import { runArchitect } from "./agents/architect.js";
import { runArchaeologist } from "./agents/archaeologist.js";
import { runMason } from "./agents/mason.js";
import { runBuilder } from "./agents/builder.js";
import { runSaboteur } from "./agents/saboteur.js";
import {
  coordinatorDecision,
  STAGE_ORDER,
  nextStage,
} from "./pipeline.js";
import type { PipelineState, PipelineStage } from "./types.js";

function log(stage: string, msg: string) {
  const timestamp = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${timestamp}] [${stage}] ${msg}\n`);
}

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
      break;
    }
    case "mason": {
      log("mason", "Generating tests from behavioural contract...");
      state.tests = await runMason(state.behaviourContract!);
      log("mason", `Generated ${state.tests.testFilePaths.length} test file(s).`);
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
      const killed = state.saboteurReport.mutationResults.filter((m) => m.killed).length;
      const total = state.saboteurReport.mutationResults.length;
      log("saboteur", `Verdict: ${state.saboteurReport.verdict} (${killed}/${total} mutations killed)`);
      break;
    }
  }
}

async function main() {
  const userIntent = process.argv.slice(2).join(" ");
  if (!userIntent) {
    console.error("Usage: prunejuice <intent>");
    console.error('  e.g.: prunejuice "Add a rate limiter middleware with sliding window"');
    process.exit(1);
  }

  const cwd = resolve(process.cwd());
  const state: PipelineState = { userIntent, cwd };

  let currentStage: PipelineStage = STAGE_ORDER[0]!;
  let retryCount = 0;

  log("coordinator", `Pipeline starting. Intent: "${userIntent}"`);
  log("coordinator", `Working directory: ${cwd}`);

  while (true) {
    await runStage(currentStage, state);

    const decision = await coordinatorDecision(state, currentStage, retryCount);
    log("coordinator", `Decision after ${currentStage}: ${decision.action} — ${decision.reason}`);

    if (decision.action === "abort") {
      log("coordinator", "Pipeline aborted.");
      process.stdout.write(JSON.stringify({ status: "aborted", state }, null, 2));
      process.exit(1);
    }

    if (decision.action === "retry" && decision.retryFrom) {
      retryCount++;
      currentStage = decision.retryFrom;
      log("coordinator", `Retrying from ${decision.retryFrom} (attempt ${retryCount}/2)`);
      continue;
    }

    const next = nextStage(currentStage);
    if (!next) {
      // Pipeline complete
      log("coordinator", "Pipeline complete.");
      process.stdout.write(JSON.stringify({
        status: "complete",
        spec: state.spec,
        concreteSpec: state.concreteSpec,
        tests: { filePaths: state.tests?.testFilePaths, coverageTargets: state.tests?.coverageTargets },
        implementation: { files: state.implementation?.files.map((f) => f.path), summary: state.implementation?.summary },
        saboteurReport: state.saboteurReport,
      }, null, 2));
      break;
    }

    currentStage = next;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
