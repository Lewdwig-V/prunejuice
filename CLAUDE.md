# Prunejuice

Multi-agent coordinator harness built on the Claude Code SDK.

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

Requires `behaviour.yaml` in the working directory.

## Key Files

- `src/types.ts` — Shared types, `*Input` types enforce information boundaries
- `src/pipeline.ts` — `queryAgent()` helper, coordinator LLM, stage sequencing
- `src/agents/*.ts` — Agent definitions (system prompts + tool restrictions)
- `src/index.ts` — CLI entry, pipeline loop
- `behaviour.yaml` — Example behavioural contract (reference only; Archaeologist generates contracts at runtime)
