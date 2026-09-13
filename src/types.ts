/**
 * Domain types for the Pi project-management extension.
 *
 * Design note: these types are deliberately plain data (no classes, no maps)
 * so they can be serialized to YAML/JSON and hand-edited by humans.
 */

export type Id = string;

/* ------------------------------------------------------------------ */
/* Direction                                                           */
/* ------------------------------------------------------------------ */

export interface Concept {
  /** Free-form concept type, e.g. "strategic", "design", "technical". */
  type: string;
  text: string;
}

export interface Direction {
  vision: string;
  intent: string;
  values: string[];
  concepts: Concept[];
  updated?: string;
}

/* ------------------------------------------------------------------ */
/* Goals                                                              */
/* ------------------------------------------------------------------ */

export const GOAL_STATUSES = ["ACTIVE", "COMPLETED", "FAILED", "ABANDONED", "SUPERSEDED"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface Goal {
  id: Id;
  title: string;
  description: string;
  /** 1 (low) .. 5 (critical). */
  priority: number;
  successCriteria: string[];
  status: GoalStatus;
  parent: Id | null;
  questions: Id[];
  risks: Id[];
  tasks: Id[];
  supersededBy?: Id | null;
  created: string;
  updated: string;
}

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

export interface ProjectState {
  initial: string;
  current: string;
  capabilities: string[];
  facts: string[];
  problems: string[];
  constraints: string[];
  discoveries: string[];
  updated: string;
}

/* ------------------------------------------------------------------ */
/* Intelligence                                                       */
/* ------------------------------------------------------------------ */

export const ANSWER_STATUSES = ["UNKNOWN", "PARTIAL", "ANSWERED", "CONFIRMED", "INVALIDATED"] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];

export interface Evidence {
  /** Short human-readable description of the evidence. */
  description: string;
  /** Optional kind: run, experiment, link, doc, measurement, ... */
  kind?: string;
  /** Optional reference (run id, url, file, commit). */
  ref?: string;
  run?: Id;
  at?: string;
}

export interface Question {
  id: Id;
  question: string;
  answer: string;
  status: AnswerStatus;
  /** 0..1 - how much the answer matters. */
  importance: number;
  /** 0..1 - how uncertain we currently are. */
  uncertainty: number;
  /** 0..1 - how much pending decisions depend on the answer. */
  decisionImpact: number;
  /** 0..1 - confidence in the current answer. */
  confidence: number;
  evidence: Evidence[];
  goals: Id[];
  risks: Id[];
  tasks: Id[];
  decisions: Id[];
  created: string;
  updated: string;
  answered?: string | null;
}

/* ------------------------------------------------------------------ */
/* Risks                                                              */
/* ------------------------------------------------------------------ */

export const RISK_STATUSES = ["OPEN", "MITIGATING", "RESOLVED", "ACCEPTED", "OCCURRED", "CLOSED"] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export interface Risk {
  id: Id;
  title: string;
  description: string;
  /** 0..1 */
  probability: number;
  /** 0..1 */
  impact: number;
  status: RiskStatus;
  mitigation: string;
  contingency: string;
  questions: Id[];
  goals: Id[];
  tasks: Id[];
  owner?: string;
  created: string;
  updated: string;
}

/* ------------------------------------------------------------------ */
/* Strategy                                                           */
/* ------------------------------------------------------------------ */

export interface Strategy {
  approach: string;
  hypotheses: string[];
  priorities: string[];
  rationale: string;
  alternatives: string[];
  updated: string;
}

/* ------------------------------------------------------------------ */
/* Plans and DAG                                                      */
/* ------------------------------------------------------------------ */

export const NODE_TYPES = [
  "TASK",
  "INVESTIGATION",
  "EXPERIMENT",
  "DECISION",
  "REVIEW",
  "GATE",
  "WAIT",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const NODE_STATUSES = [
  "PENDING",
  "RUNNING",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "ABANDONED",
  "SUPERSEDED",
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const GATE_TYPES = [
  "VALIDATION",
  "TEST",
  "EVALUATION",
  "REVIEW",
  "APPROVAL",
  "STRATEGIC_REVIEW",
  "RISK_REVIEW",
] as const;
export type GateType = (typeof GATE_TYPES)[number];

export const GATE_OUTCOMES = ["PASS", "FAIL", "REPLAN", "ESCALATE"] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];

export interface GateSpec {
  type: GateType;
  criteria: string;
}

export interface GateResult {
  node: Id;
  outcome: GateOutcome;
  notes: string;
  evaluator: string;
  at: string;
}

export interface PlanNode {
  id: Id;
  title: string;
  description: string;
  type: NodeType;
  status: NodeStatus;
  dependsOn: Id[];
  goal: Id | null;
  risk: Id | null;
  question: Id | null;
  outputs: string[];
  failureReason: string | null;
  assignee: "agent" | "human";
  gate: GateSpec | null;
  run: Id | null;
  created: string;
  updated: string;
  started: string | null;
  finished: string | null;
}

export interface Plan {
  id: Id;
  version: number;
  title: string;
  rationale: string;
  createdAt: string;
  supersededBy: Id | null;
  nodes: PlanNode[];
  gates: GateResult[];
}

export interface PlanChange {
  from: Id | null;
  to: Id;
  reason: string;
  /** Evidence or trigger that forced the change. */
  trigger: string;
  at: string;
  by: string;
}

/* ------------------------------------------------------------------ */
/* Decisions                                                          */
/* ------------------------------------------------------------------ */

export const AUTHORITY_LEVELS = ["ROUTINE", "SIGNIFICANT", "STRATEGIC"] as const;
export type AuthorityLevel = (typeof AUTHORITY_LEVELS)[number];

export interface Decision {
  id: Id;
  title: string;
  decision: string;
  rationale: string;
  alternatives: string[];
  evidence: Evidence[];
  goals: Id[];
  questions: Id[];
  risks: Id[];
  plan: Id | null;
  authority: AuthorityLevel;
  approvedBy: string | null;
  /** Set when the decision was auto-accepted by YOLO mode. */
  autoAccepted: boolean;
  at: string;
}

/* ------------------------------------------------------------------ */
/* Runs (long-running execution)                                      */
/* ------------------------------------------------------------------ */

export const RUN_STATUSES = [
  "STARTED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "ABANDONED",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface ExternalRef {
  kind: "local" | "ssh" | "docker" | "gpu" | "cloud" | "api" | "other";
  target: string;
  note?: string;
}

export interface RunEntry {
  at: string;
  kind: "note" | "progress" | "output" | "error" | "checkpoint";
  text: string;
}

export interface Run {
  id: Id;
  title: string;
  node: Id | null;
  status: RunStatus;
  environment: ExternalRef[];
  command: string | null;
  cwd: string | null;
  pid: number | null;
  host: string | null;
  /** Pi session that started the run, if any. */
  session: string | null;
  log: string | null;
  exitCode: number | null;
  started: string;
  finished: string | null;
  updated: string;
  entries: RunEntry[];
  outputs: Evidence[];
}

/* ------------------------------------------------------------------ */
/* History                                                            */
/* ------------------------------------------------------------------ */

export const HISTORY_KINDS = [
  "project.init",
  "project.renamed",
  "project.paused",
  "project.resumed",
  "project.completed",
  "direction.changed",
  "state.changed",
  "goal.created",
  "goal.updated",
  "goal.completed",
  "goal.failed",
  "goal.abandoned",
  "goal.superseded",
  "question.created",
  "question.updated",
  "question.answered",
  "risk.created",
  "risk.updated",
  "risk.resolved",
  "strategy.changed",
  "plan.created",
  "plan.changed",
  "pivot",
  "decision.made",
  "gate.passed",
  "gate.failed",
  "run.started",
  "run.finished",
  "task.updated",
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export interface HistoryEvent {
  /** Durable monotonically increasing sequence number. */
  seq: number;
  at: string;
  kind: HistoryKind;
  summary: string;
  by: string;
  refs: Id[];
  details?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Project                                                            */
/* ------------------------------------------------------------------ */

export interface ProjectMeta {
  name: string;
  /** Stable slug / id. */
  id: string;
  created: string;
  updated: string;
  repositories: string[];
  resources: ExternalRef[];
  workspace: string | null;
  /** YOLO mode: auto-accept decisions that would otherwise need approval. */
  yolo: boolean;
  /** Auto-commit .project changes to git when the project lives in a repo. */
  autoCommit: boolean;
  activePlan: Id | null;
  completed: boolean;
  completedAt?: string | null;
  /** Parked deliberately: reversible, unlike `completed`. */
  paused: boolean;
  pausedAt?: string | null;
  /** What to do first when work resumes; shown while paused. */
  resumeNote?: string | null;
}

export interface PlansFile {
  active: Id | null;
  plans: Plan[];
  changes: PlanChange[];
}

export interface Project {
  root: string;
  meta: ProjectMeta;
  direction: Direction;
  goals: Goal[];
  state: ProjectState;
  questions: Question[];
  risks: Risk[];
  strategy: Strategy;
  plans: PlansFile;
  decisions: Decision[];
  runs: Run[];
  history: HistoryEvent[];
}

/** Everything needed to construct a brand-new project. */
export interface InitOptions {
  name?: string;
  vision?: string;
  intent?: string;
  values?: string[];
  concepts?: Concept[];
  workspace?: string | null;
  yolo?: boolean;
  repos?: string[];
  /** Override directory. Defaults to <cwd>/.project */
  dir?: string;
}
