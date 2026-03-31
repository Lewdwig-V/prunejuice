#!/usr/bin/env node

import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  distill,
  elicit,
  generate,
  cover,
  weed,
  takeover,
  change,
  sync,
  type DiscoveryHandler,
  type DiscoveredItem,
  type DiscoveryResolution,
} from "./api.js";

function log(stage: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${ts}] [${stage}] ${msg}\n`);
}

// -- Interactive discovery handler (CLI-specific) ----------------------------

const interactiveDiscoveryHandler: DiscoveryHandler = async (discovered) => {
  if (discovered.length === 0) return;

  log("discovery-gate", `${discovered.length} item(s) requiring human review:`);
  for (const item of discovered) {
    process.stderr.write(`\n  ★ ${item.title}\n`);
    process.stderr.write(`    Observation: ${item.observation}\n`);
    process.stderr.write(`    Question: ${item.question}\n`);
  }
  process.stderr.write("\n");

  const rl = createInterface({ input: process.stdin, output: process.stderr });

  for (const item of discovered) {
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `  [${item.title}] Promote to spec, dismiss, or defer? (p/d/f): `,
        (ans) => resolve(ans.trim().toLowerCase()),
      );
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
};

// -- CLI entry ---------------------------------------------------------------

const USAGE = `Usage: prunejuice <command> [args]

Phases:
  distill                    Infer spec from existing code
  elicit <intent>            Create/amend spec from intent
  generate                   Tests + implementation from spec
  cover                      Find and fill test coverage gaps
  weed                       Detect intent drift between spec and code

Orchestrators:
  takeover [intent]          distill → elicit → generate
  change <intent>            elicit (amend) → generate
  sync                       Regenerate stale files`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1).join(" ");
  const cwd = resolve(process.cwd());
  const opts = { log, onDiscovery: interactiveDiscoveryHandler };

  if (!command) {
    console.error(USAGE);
    process.exit(1);
  }

  let result: unknown;

  switch (command) {
    case "distill":
      result = await distill(cwd, opts);
      break;

    case "elicit":
      if (!rest) { console.error("Usage: prunejuice elicit <intent>"); process.exit(1); }
      result = await elicit(rest, cwd, opts);
      break;

    case "generate":
      result = await generate(
        await requireStoredSpec(cwd),
        cwd,
        opts,
      );
      break;

    case "cover":
      result = await cover(cwd, opts);
      break;

    case "weed":
      result = await weed(cwd, opts);
      break;

    case "takeover":
      result = await takeover(cwd, { ...opts, intent: rest || undefined });
      break;

    case "change":
      if (!rest) { console.error("Usage: prunejuice change <intent>"); process.exit(1); }
      result = await change(rest, cwd, opts);
      break;

    case "sync":
      result = await sync(cwd, opts);
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      process.exit(1);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

async function requireStoredSpec(cwd: string) {
  const { loadSpec } = await import("./store.js");
  const spec = await loadSpec(cwd);
  if (!spec) {
    console.error("No spec found in store. Run 'prunejuice distill' or 'prunejuice elicit <intent>' first.");
    process.exit(1);
  }
  return spec;
}

main().catch((err) => {
  log("fatal", `Pipeline crashed: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
