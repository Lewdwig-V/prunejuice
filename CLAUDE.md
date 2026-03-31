# Prunejuice

Multi-agent coordinator harness built on the Claude Code SDK. SDK-native implementation of the spec-as-coordinator pattern described in the [unslop paper](https://github.com/Lewdwig-V/unslop/blob/main/docs/paper/spec-as-coordinator.md).

## Architecture

Five-agent pipeline with programmatic information isolation (Option C — hybrid):

| Agent | Role | Tools | Information Boundary |
|-------|------|-------|---------------------|
| Architect | Intent → Spec | Read, Grep, Glob, LS | Sees everything |
| Archaeologist | Code analysis → Concrete spec + behaviour contract | Read, Grep, Glob, LS, Bash | No tests during generate |
| Mason | Behaviour contract → Tests | None (prompt-only) | Only sees behaviour contract (from Archaeologist) |
| Builder | Spec + Tests → Implementation | Read, Grep, Glob, LS, Bash, Write, Edit | No Mason derivation logic |
| Saboteur | Mutation testing + compliance | Read, Grep, Glob, LS, Bash | No Builder generation logic |

Each agent runs as a separate `query()` call. Information boundaries are enforced structurally in TypeScript, not just via prompts. A Coordinator LLM decides retry routing after the Saboteur stage.

### Pipeline Flow

```
User intent
  → Architect (elicits, produces Spec)
  → Archaeologist (reads code + spec → ConcreteSpec + BehaviourContract + Discovered items)
  → Discovery Gate (pauses if Archaeologist found unresolved correctness requirements)
  → Mason (receives BehaviourContract only → GeneratedTests) [Chinese Wall]
  → Builder (Spec + ConcreteSpec + Tests → Implementation)
  → Saboteur (Spec + Tests + Implementation → MutationReport with classifications)
  → Convergence loop (routes survivors: weak_test → Mason, spec_gap → Architect)
```

### Hash Chain

Generated files carry a managed header linking them back to their spec artifacts:

```
// @prunejuice-managed -- Edit .prunejuice/artifacts/concrete-spec.json instead
// spec-hash:a3f8c2e9b7d1 output-hash:4e2f1a8c9b03 generated:2026-03-22T14:32:00Z
```

Eight-state freshness classifier: fresh, stale, modified, conflict, pending, structural, ghost-stale, test-drifted. Three states (modified, conflict, ghost-stale) route through the Coordinator LLM for judgment.

### Convergence Loop

After the Saboteur, surviving mutations are classified and routed:
- `weak_test` → Mason strengthens assertions
- `spec_gap` → Architect enriches behaviour contract
- `equivalent` → skipped

Max 3 iterations + 1 radical hardening pass. Entropy stall detection (< 5% kill rate improvement) triggers early radical hardening.

## Commands

```bash
npm run build    # TypeScript compile
npm run start    # Run with tsx
npm run dev      # Watch mode
```

## Usage

```bash
npx tsx src/index.ts "Add a rate limiter middleware with sliding window"
```

## Key Files

- `src/types.ts` — Shared types, `*Input` types enforce information boundaries
- `src/pipeline.ts` — `queryAgent()` helper, coordinator LLM, convergence loop, survivor routing
- `src/hashchain.ts` — SHA-256 truncated hashes, managed file headers, eight-state freshness classifier
- `src/store.ts` — Artifact persistence to `.prunejuice/`, managed file writing with hash chain headers
- `src/agents/*.ts` — Agent definitions (system prompts + tool restrictions)
- `src/index.ts` — CLI entry, pipeline loop with discovery gate and convergence
- `behaviour.yaml` — Example behavioural contract (reference only; Archaeologist generates contracts at runtime)

## Key Differences from Unslop

| Aspect | Unslop (filesystem) | Prunejuice (SDK) |
|--------|---------------------|------------------|
| Control plane | Filesystem — agents read headers and act | TypeScript — pipeline reads headers and dispatches agents |
| Coordination | Implicit (file existence + hash state) | Explicit (programmatic stage sequencing + convergence loop) |
| Information isolation | Prompt construction (no source in Mason's context) | Structural (`query()` calls with different tool sets + prompts) |
| Freshness ambiguity | Deterministic actions for all 8 states | 3 states route through Coordinator LLM for judgment |
| Fan-out/fan-in | Not supported (paper Section 7.1) | Possible via parallel `query()` calls (not yet implemented) |
| Context handoff | Manual (structured handoff artifacts) | Automatic (each `query()` call is a fresh context) |
