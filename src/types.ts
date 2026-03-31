/**
 * Artifacts produced and consumed by pipeline stages.
 * Each agent sees only the artifacts listed in its StageInput type.
 */

export interface Spec {
  intent: string;
  requirements: string[];
  constraints: string[];
  acceptanceCriteria: string[];
}

export interface ConcreteSpec {
  existingPatterns: string[];
  integrationPoints: string[];
  fileTargets: string[];
  strategyProjection: string;
  refinedSpec: Spec;
  behaviourContract: BehaviourContract;
}

export interface BehaviourContract {
  name: string;
  preconditions: string[];
  postconditions: string[];
  invariants: string[];
  scenarios: Array<{
    given: string;
    when: string;
    then: string;
  }>;
}

export interface GeneratedTests {
  testCode: string;
  testFilePaths: string[];
  coverageTargets: string[];
}

export interface Implementation {
  files: Array<{
    path: string;
    content: string;
  }>;
  summary: string;
}

export interface SaboteurReport {
  mutationResults: Array<{
    mutation: string;
    killed: boolean;
    details: string;
  }>;
  complianceViolations: string[];
  verdict: "pass" | "fail";
  recommendations: string[];
}

// What each agent receives — enforces information boundaries at the type level
export interface ArchitectInput {
  userIntent: string;
}

export interface ArchaeologistInput {
  spec: Spec;
  cwd: string; // gets Read/Grep access to code
}

export interface MasonInput {
  behaviourContract: BehaviourContract; // only this, no code access
}

export interface BuilderInput {
  spec: Spec;
  concreteSpec: ConcreteSpec;
  tests: GeneratedTests;
  cwd: string;
}

export interface SaboteurInput {
  spec: Spec;
  tests: GeneratedTests;
  implementation: Implementation;
  cwd: string;
}

// Pipeline state accumulator
export interface PipelineState {
  userIntent: string;
  cwd: string;
  spec?: Spec;
  concreteSpec?: ConcreteSpec;
  behaviourContract?: BehaviourContract;
  tests?: GeneratedTests;
  implementation?: Implementation;
  saboteurReport?: SaboteurReport;
}

export type PipelineStage =
  | "architect"
  | "archaeologist"
  | "mason"
  | "builder"
  | "saboteur";

export interface CoordinatorDecision {
  action: "proceed" | "retry" | "abort";
  retryFrom?: PipelineStage;
  reason: string;
}
