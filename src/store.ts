import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { truncatedHash, formatHeader, parseHeader, getBodyBelowHeader } from "./hashchain.js";
import type {
  Spec,
  ConcreteSpec,
  BehaviourContract,
  GeneratedTests,
  Implementation,
  SaboteurReport,
  PipelineState,
} from "./types.js";

const STORE_DIR = ".prunejuice";

// -- Directory layout --------------------------------------------------------

function storePath(cwd: string, ...segments: string[]): string {
  return resolve(cwd, STORE_DIR, ...segments);
}

export async function ensureStore(cwd: string): Promise<void> {
  const dirs = [
    storePath(cwd),
    storePath(cwd, "artifacts"),
    storePath(cwd, "verification"),
  ];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

// -- Artifact I/O ------------------------------------------------------------

async function writeArtifact(cwd: string, name: string, data: unknown): Promise<string> {
  const content = JSON.stringify(data, null, 2);
  const path = storePath(cwd, "artifacts", `${name}.json`);
  await writeFile(path, content, "utf-8");
  return truncatedHash(content);
}

async function readArtifact<T>(cwd: string, name: string): Promise<T | null> {
  try {
    const path = storePath(cwd, "artifacts", `${name}.json`);
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

// -- Typed artifact accessors ------------------------------------------------

export async function saveSpec(cwd: string, spec: Spec): Promise<string> {
  return writeArtifact(cwd, "spec", spec);
}

export async function loadSpec(cwd: string): Promise<Spec | null> {
  return readArtifact<Spec>(cwd, "spec");
}

export async function saveConcreteSpec(cwd: string, concreteSpec: ConcreteSpec): Promise<string> {
  return writeArtifact(cwd, "concrete-spec", concreteSpec);
}

export async function loadConcreteSpec(cwd: string): Promise<ConcreteSpec | null> {
  return readArtifact<ConcreteSpec>(cwd, "concrete-spec");
}

export async function saveBehaviourContract(cwd: string, contract: BehaviourContract): Promise<string> {
  return writeArtifact(cwd, "behaviour-contract", contract);
}

export async function loadBehaviourContract(cwd: string): Promise<BehaviourContract | null> {
  return readArtifact<BehaviourContract>(cwd, "behaviour-contract");
}

export async function saveTests(cwd: string, tests: GeneratedTests): Promise<string> {
  return writeArtifact(cwd, "tests", tests);
}

export async function loadTests(cwd: string): Promise<GeneratedTests | null> {
  return readArtifact<GeneratedTests>(cwd, "tests");
}

export async function saveImplementation(cwd: string, impl: Implementation): Promise<string> {
  return writeArtifact(cwd, "implementation", impl);
}

export async function loadImplementation(cwd: string): Promise<Implementation | null> {
  return readArtifact<Implementation>(cwd, "implementation");
}

export async function saveSaboteurReport(cwd: string, report: SaboteurReport): Promise<string> {
  return writeArtifact(cwd, "saboteur-report", report);
}

export async function loadSaboteurReport(cwd: string): Promise<SaboteurReport | null> {
  return readArtifact<SaboteurReport>(cwd, "saboteur-report");
}

// -- Hash lookups (for freshness classification) -----------------------------

export async function artifactHash(cwd: string, name: string): Promise<string | null> {
  try {
    const path = storePath(cwd, "artifacts", `${name}.json`);
    const content = await readFile(path, "utf-8");
    return truncatedHash(content);
  } catch {
    return null;
  }
}

// -- Verification results (Saboteur output, matches Appendix A format) -------

export interface VerificationResult {
  managedPath: string;
  specPath: string;
  timestamp: string;
  status: "pass" | "fail";
  mutantsTotal: number;
  mutantsKilled: number;
  mutantsSurvived: number;
  mutantsEquivalent: number;
  sourceHash: string;
  specHash: string;
  survivingMutants: SaboteurReport["mutationResults"];
  complianceViolations: string[];
}

export async function saveVerificationResult(
  cwd: string,
  result: VerificationResult
): Promise<void> {
  const hash = truncatedHash(JSON.stringify(result));
  const path = storePath(cwd, "verification", `${hash}.json`);
  await writeFile(path, JSON.stringify(result, null, 2), "utf-8");
}

// -- Full pipeline state persistence -----------------------------------------

export async function savePipelineState(cwd: string, state: PipelineState): Promise<void> {
  const saves: Promise<string>[] = [];
  if (state.spec) saves.push(saveSpec(cwd, state.spec));
  if (state.concreteSpec) saves.push(saveConcreteSpec(cwd, state.concreteSpec));
  if (state.behaviourContract) saves.push(saveBehaviourContract(cwd, state.behaviourContract));
  if (state.tests) saves.push(saveTests(cwd, state.tests));
  if (state.implementation) saves.push(saveImplementation(cwd, state.implementation));
  if (state.saboteurReport) saves.push(saveSaboteurReport(cwd, state.saboteurReport));
  await Promise.all(saves);
}

// -- Managed file writing (adds hash chain headers) -------------------------

export async function writeManagedFile(
  cwd: string,
  filePath: string,
  content: string,
  specArtifactName: string,
  commentStyle: "#" | "//" = "//"
): Promise<void> {
  const specHash = await artifactHash(cwd, specArtifactName);
  if (!specHash) {
    throw new Error(`Cannot write managed file: spec artifact "${specArtifactName}" not found`);
  }

  const outputHash = truncatedHash(content);
  const header = formatHeader(
    `.prunejuice/artifacts/${specArtifactName}.json`,
    {
      specHash,
      outputHash,
      generated: new Date().toISOString(),
    },
    commentStyle
  );

  const fullContent = `${header}\n\n${content}`;
  const absPath = resolve(cwd, filePath);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, fullContent, "utf-8");
}

export async function writeImplementationFiles(
  cwd: string,
  implementation: Implementation
): Promise<void> {
  for (const file of implementation.files) {
    const commentStyle = file.path.endsWith(".py") ? "#" as const : "//" as const;
    await writeManagedFile(cwd, file.path, file.content, "concrete-spec", commentStyle);
  }
}

export async function writeTestFiles(
  cwd: string,
  tests: GeneratedTests
): Promise<void> {
  for (let i = 0; i < tests.testFilePaths.length; i++) {
    const filePath = tests.testFilePaths[i]!;
    const commentStyle = filePath.endsWith(".py") ? "#" as const : "//" as const;
    // Mason produces a single testCode blob; write it to the first test file path
    if (i === 0) {
      await writeManagedFile(cwd, filePath, tests.testCode, "behaviour-contract", commentStyle);
    }
  }
}

// -- Full pipeline state persistence -----------------------------------------

export async function loadPipelineState(cwd: string): Promise<Partial<PipelineState>> {
  const [spec, concreteSpec, tests, implementation, saboteurReport] = await Promise.all([
    loadSpec(cwd),
    loadConcreteSpec(cwd),
    loadTests(cwd),
    loadImplementation(cwd),
    loadSaboteurReport(cwd),
  ]);

  const state: Partial<PipelineState> = {};
  if (spec) state.spec = spec;
  if (concreteSpec) {
    state.concreteSpec = concreteSpec;
    state.behaviourContract = concreteSpec.behaviourContract;
  }
  if (tests) state.tests = tests;
  if (implementation) state.implementation = implementation;
  if (saboteurReport) state.saboteurReport = saboteurReport;
  return state;
}
