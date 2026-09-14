/**
 * Filesystem persistence for projects.
 *
 * Source of truth (spec 19): filesystem + Git.
 *
 *   .project/
 *   ├── project.yaml        project metadata
 *   ├── direction.md        vision / intent / values / concepts
 *   ├── goals.yaml
 *   ├── state.md            initial + current state
 *   ├── intelligence.yaml   questions
 *   ├── risks.yaml
 *   ├── strategy.md
 *   ├── plan.yaml           active plan + plan history + plan changes
 *   ├── plan.md             derived, human-readable active plan
 *   ├── summary.md          derived completion summary
 *   ├── decisions/D1.md     one file per decision (YAML front matter + prose)
 *   ├── history/events.jsonl append-only semantic history
 *   ├── history/history.md  derived narrative history
 *   └── runs/RUN1.yaml      one file per run (+ optional RUN1.log)
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { renderCompletionSummary } from "./history.ts";

import {
  cleanProse,
  isPlaceholder,
  parseBullets,
  parseConcepts,
  parseFrontMatter,
  parseSections,
  renderBullets,
  renderConcepts,
  renderFrontMatter,
  renderSections,
  section,
} from "./markdown.ts";
import { now, slugify } from "./ids.ts";
import type {
  Concept,
  Decision,
  Direction,
  Evidence,
  ExternalRef,
  Goal,
  HistoryEvent,
  Plan,
  PlanChange,
  PlanNode,
  Project,
  ProjectMeta,
  ProjectState,
  Question,
  Risk,
  Run,
  Strategy,
  PlansFile,
} from "./types.ts";
import {
  ANSWER_STATUSES,
  AUTHORITY_LEVELS,
  GATE_OUTCOMES,
  GATE_TYPES,
  HISTORY_KINDS,
  NODE_STATUSES,
  NODE_TYPES,
  RISK_STATUSES,
  RUN_STATUSES,
} from "./types.ts";

const execFileAsync = promisify(execFile);

export const PROJECT_DIR = ".project";

export interface Clock {
  now: () => string;
}

export const systemClock: Clock = { now: () => now() };

/* ------------------------------------------------------------------ */
/* Small YAML coercion helpers (tolerant of hand edits)               */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item)).filter((item) => item !== "");
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * A 0..100 percent, or null when absent/unparseable. Reading is deliberately
 * lenient where writing is strict: a hand-edited file keeps loading, and the
 * mutation path refuses an out-of-range value before anything is saved.
 */
function asPercent(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = asNumber(value, Number.NaN);
  if (!Number.isFinite(parsed)) return null;
  return clampPercent(parsed);
}

/** Shared by parsing and mutations so both agree on what a valid percent is. */
export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** True when a raw value is a usable percent; used to reject bad writes. */
export function isPercentInRange(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= 100;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100;
  }
  return false;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["true", "yes", "on", "1"].includes(value.toLowerCase())) return true;
    if (["false", "no", "off", "0"].includes(value.toLowerCase())) return false;
  }
  return fallback;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const raw = asString(value).trim();
  const normalized = raw.toUpperCase().replace(/[\s-]+/g, "_");
  for (const candidate of allowed) {
    if (candidate.toUpperCase() === raw.toUpperCase()) return candidate;
    if (candidate.toUpperCase().replace(/[.\s-]+/g, "_") === normalized) return candidate;
  }
  return fallback;
}

function asNullable(value: unknown): string | null {
  const text = asString(value);
  return text === "" || text === "null" || text === "~" ? null : text;
}

/* ------------------------------------------------------------------ */
/* Project discovery                                                  */
/* ------------------------------------------------------------------ */

export function projectMarkerPath(root: string): string {
  return join(root, PROJECT_DIR, "project.yaml");
}

/** Walk up from `start` looking for a `.project/project.yaml`. */
export function findProjectRoot(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (existsSync(projectMarkerPath(current))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export interface WorkspaceEntry {
  name: string;
  path: string;
}

export interface Workspace {
  active: string | null;
  projects: WorkspaceEntry[];
}

export function workspaceFile(): string {
  return join(homedir(), ".pi", "agent", "project-manager.json");
}

export async function loadWorkspace(): Promise<Workspace> {
  const file = workspaceFile();
  if (!existsSync(file)) return { active: null, projects: [] };
  try {
    const raw = parseYaml(await readFile(file, "utf8")) as unknown;
    const record = asRecord(raw);
    const projects = (Array.isArray(record.projects) ? record.projects : [])
      .map((entry): WorkspaceEntry => {
        if (typeof entry === "string") return { name: slugify(entry), path: entry };
        const rec = asRecord(entry);
        return { name: asString(rec.name), path: asString(rec.path) };
      })
      .filter((entry) => entry.path !== "");
    return { active: asNullable(record.active), projects };
  } catch {
    return { active: null, projects: [] };
  }
}

export async function saveWorkspace(workspace: Workspace): Promise<void> {
  const file = workspaceFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(
    file,
    stringifyYaml({ active: workspace.active, projects: workspace.projects }, { lineWidth: 100 }),
  );
}

/** Register (or refresh) a project in the local workspace registry. */
export async function registerInWorkspace(root: string, name: string): Promise<void> {
  const workspace = await loadWorkspace();
  const path = resolve(root);
  const existing = workspace.projects.findIndex((entry) => resolve(entry.path) === path);
  const entry: WorkspaceEntry = { name, path };
  if (existing >= 0) workspace.projects[existing] = entry;
  else workspace.projects.push(entry);
  if (!workspace.active) workspace.active = name;
  await saveWorkspace(workspace);
}

/* ------------------------------------------------------------------ */
/* YAML / file helpers                                                */
/* ------------------------------------------------------------------ */

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}

async function readTextIfExists(file: string): Promise<string | null> {
  if (!existsSync(file)) return null;
  return readFile(file, "utf8");
}

async function readYamlIfExists(file: string): Promise<unknown> {
  const text = await readTextIfExists(file);
  if (text === null) return null;
  try {
    return parseYaml(text) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse ${file}: ${(error as Error).message}`);
  }
}

function yamlFile(data: unknown): string {
  return stringifyYaml(data, { lineWidth: 100, aliasDuplicateObjects: false });
}

/* ------------------------------------------------------------------ */
/* Per-file serialization                                             */
/* ------------------------------------------------------------------ */

export function serializeDirection(direction: Direction): string {
  return renderSections("Direction", [
    ["Vision", cleanProse(direction.vision) || "_Not defined yet._"],
    ["Intent", cleanProse(direction.intent) || "_Not defined yet._"],
    ["Values", renderBullets(direction.values)],
    ["Concepts", renderConcepts(direction.concepts)],
    ["Last Updated", direction.updated ?? ""],
  ]);
}

export function parseDirection(markdown: string): Direction {
  const sections = parseSections(markdown);
  const rawVision = section(sections, "vision");
  const rawIntent = section(sections, "intent");
  return {
    vision: cleanProse(isPlaceholder(rawVision) ? "" : rawVision),
    intent: cleanProse(isPlaceholder(rawIntent) ? "" : rawIntent),
    values: parseBullets(section(sections, "values")),
    concepts: parseConcepts(section(sections, "concepts")),
    ...(asString(section(sections, "last updated")).startsWith("_") || asString(section(sections, "last updated")) === ""
      ? {}
      : { updated: asString(section(sections, "last updated")) }),
  };
}

export function serializeState(state: ProjectState): string {
  return renderSections("State", [
    ["Initial State", cleanProse(state.initial) || "_Not recorded yet._"],
    ["Current State", cleanProse(state.current) || "_Not recorded yet._"],
    ["Capabilities", renderBullets(state.capabilities)],
    ["Known Facts", renderBullets(state.facts)],
    ["Active Problems", renderBullets(state.problems)],
    ["Constraints", renderBullets(state.constraints)],
    ["Discoveries", renderBullets(state.discoveries)],
    ["Last Updated", state.updated],
  ]);
}

export function parseState(markdown: string, clock: Clock = systemClock): ProjectState {
  const sections = parseSections(markdown);
  const initial = section(sections, "initial state", "initial");
  const current = section(sections, "current state", "current");
  return {
    initial: cleanProse(isPlaceholder(initial) ? "" : initial),
    current: cleanProse(isPlaceholder(current) ? "" : current),
    capabilities: parseBullets(section(sections, "capabilities")),
    facts: parseBullets(section(sections, "known facts", "facts")),
    problems: parseBullets(section(sections, "active problems", "problems")),
    constraints: parseBullets(section(sections, "constraints")),
    discoveries: parseBullets(section(sections, "discoveries")),
    updated: asString(section(sections, "last updated")) || clock.now(),
  };
}

export function serializeStrategy(strategy: Strategy): string {
  return renderSections("Strategy", [
    ["Current Approach", cleanProse(strategy.approach) || "_Not defined yet._"],
    ["Strategic Hypotheses", renderBullets(strategy.hypotheses)],
    ["Priorities", renderBullets(strategy.priorities)],
    ["Rationale", cleanProse(strategy.rationale) || "_Not recorded yet._"],
    ["Major Alternatives Considered", renderBullets(strategy.alternatives)],
    ["Last Updated", strategy.updated],
  ]);
}

export function parseStrategy(markdown: string): Strategy {
  const sections = parseSections(markdown);
  const approach = section(sections, "current approach", "approach");
  const rationale = section(sections, "rationale");
  return {
    approach: cleanProse(isPlaceholder(approach) ? "" : approach),
    hypotheses: parseBullets(section(sections, "strategic hypotheses", "hypotheses")),
    priorities: parseBullets(section(sections, "priorities")),
    rationale: cleanProse(isPlaceholder(rationale) ? "" : rationale),
    alternatives: parseBullets(
      section(sections, "major alternatives considered", "alternatives considered", "alternatives"),
    ),
    updated: asString(section(sections, "last updated")),
  };
}

function goalToYaml(goal: Goal): Record<string, unknown> {
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description,
    priority: goal.priority,
    success_criteria: goal.successCriteria,
    status: goal.status,
    parent: goal.parent,
    superseded_by: goal.supersededBy ?? null,
    questions: goal.questions,
    risks: goal.risks,
    tasks: goal.tasks,
    percent: goal.percent,
    created: goal.created,
    updated: goal.updated,
  };
}

function goalFromYaml(raw: unknown, clock: Clock): Goal {
  const rec = asRecord(raw);
  const timestamp = clock.now();
  return {
    id: asString(rec.id),
    title: asString(rec.title) || "Untitled goal",
    description: cleanProse(asString(rec.description)),
    priority: Math.min(5, Math.max(1, Math.round(asNumber(rec.priority, 3)))),
    successCriteria: asStringArray(rec.success_criteria ?? rec.successCriteria),
    status: asEnum(rec.status, ["ACTIVE", "COMPLETED", "FAILED", "ABANDONED", "SUPERSEDED"] as const, "ACTIVE"),
    parent: asNullable(rec.parent),
    supersededBy: asNullable(rec.superseded_by ?? rec.supersededBy),
    questions: asStringArray(rec.questions),
    risks: asStringArray(rec.risks),
    tasks: asStringArray(rec.tasks),
    percent: asPercent(rec.percent),
    created: asString(rec.created) || timestamp,
    updated: asString(rec.updated) || timestamp,
  };
}

function questionToYaml(question: Question): Record<string, unknown> {
  return {
    id: question.id,
    question: question.question,
    answer: question.answer,
    status: question.status,
    importance: question.importance,
    uncertainty: question.uncertainty,
    decision_impact: question.decisionImpact,
    confidence: question.confidence,
    evidence: question.evidence,
    goals: question.goals,
    risks: question.risks,
    tasks: question.tasks,
    decisions: question.decisions,
    created: question.created,
    updated: question.updated,
    answered: question.answered ?? null,
  };
}

function evidenceFromYaml(raw: unknown): Evidence {
  const rec = asRecord(raw);
  return {
    description: asString(rec.description),
    ...(rec.kind !== undefined ? { kind: asString(rec.kind) } : {}),
    ...(rec.ref !== undefined ? { ref: asString(rec.ref) } : {}),
    ...(rec.run !== undefined ? { run: asString(rec.run) } : {}),
    ...(rec.at !== undefined ? { at: asString(rec.at) } : {}),
  };
}

function questionFromYaml(raw: unknown, clock: Clock): Question {
  const rec = asRecord(raw);
  const timestamp = clock.now();
  return {
    id: asString(rec.id),
    question: asString(rec.question) || "Unnamed question",
    answer: cleanProse(asString(rec.answer)),
    status: asEnum(rec.status, ANSWER_STATUSES, "UNKNOWN"),
    importance: asNumber(rec.importance, 0.5),
    uncertainty: asNumber(rec.uncertainty, 1),
    decisionImpact: asNumber(rec.decision_impact ?? rec.decisionImpact, 0.5),
    confidence: asNumber(rec.confidence, 0),
    evidence: Array.isArray(rec.evidence) ? rec.evidence.map(evidenceFromYaml) : [],
    goals: asStringArray(rec.goals),
    risks: asStringArray(rec.risks),
    tasks: asStringArray(rec.tasks),
    decisions: asStringArray(rec.decisions),
    created: asString(rec.created) || timestamp,
    updated: asString(rec.updated) || timestamp,
    answered: asNullable(rec.answered),
  };
}

function riskToYaml(risk: Risk): Record<string, unknown> {
  return {
    id: risk.id,
    title: risk.title,
    description: risk.description,
    probability: risk.probability,
    impact: risk.impact,
    status: risk.status,
    mitigation: risk.mitigation,
    contingency: risk.contingency,
    questions: risk.questions,
    goals: risk.goals,
    tasks: risk.tasks,
    owner: risk.owner ?? null,
    created: risk.created,
    updated: risk.updated,
  };
}

function riskFromYaml(raw: unknown, clock: Clock): Risk {
  const rec = asRecord(raw);
  const timestamp = clock.now();
  return {
    id: asString(rec.id),
    title: asString(rec.title) || "Unnamed risk",
    description: cleanProse(asString(rec.description)),
    probability: asNumber(rec.probability, 0.5),
    impact: asNumber(rec.impact, 0.5),
    status: asEnum(rec.status, RISK_STATUSES, "OPEN"),
    mitigation: cleanProse(asString(rec.mitigation)),
    contingency: cleanProse(asString(rec.contingency)),
    questions: asStringArray(rec.questions),
    goals: asStringArray(rec.goals),
    tasks: asStringArray(rec.tasks),
    ...(rec.owner !== undefined ? { owner: asString(rec.owner) } : {}),
    created: asString(rec.created) || timestamp,
    updated: asString(rec.updated) || timestamp,
  };
}

function nodeToYaml(node: PlanNode): Record<string, unknown> {
  return {
    id: node.id,
    title: node.title,
    type: node.type,
    status: node.status,
    description: node.description,
    depends_on: node.dependsOn,
    goal: node.goal,
    risk: node.risk,
    question: node.question,
    outputs: node.outputs,
    failure_reason: node.failureReason,
    assignee: node.assignee,
    gate: node.gate ? { type: node.gate.type, criteria: node.gate.criteria } : null,
    run: node.run,
    percent: node.percent,
    created: node.created,
    updated: node.updated,
    started: node.started,
    finished: node.finished,
  };
}

function nodeFromYaml(raw: unknown, clock: Clock): PlanNode {
  const rec = asRecord(raw);
  const timestamp = clock.now();
  const gateRec = asRecord(rec.gate);
  const hasGate = rec.gate !== null && rec.gate !== undefined && Object.keys(gateRec).length > 0;
  return {
    id: asString(rec.id),
    title: asString(rec.title) || "Untitled node",
    description: cleanProse(asString(rec.description)),
    type: asEnum(rec.type, NODE_TYPES, "TASK"),
    status: asEnum(rec.status, NODE_STATUSES, "PENDING"),
    dependsOn: asStringArray(rec.depends_on ?? rec.dependsOn),
    goal: asNullable(rec.goal),
    risk: asNullable(rec.risk),
    question: asNullable(rec.question),
    outputs: asStringArray(rec.outputs),
    failureReason: Object.prototype.hasOwnProperty.call(rec, "failure_reason")
      ? asNullable(rec.failure_reason)
      : asNullable(rec.failureReason),
    assignee: asEnum(rec.assignee, ["agent", "human"] as const, "agent"),
    gate: hasGate ? { type: asEnum(gateRec.type, GATE_TYPES, "VALIDATION"), criteria: asString(gateRec.criteria) } : null,
    run: asNullable(rec.run),
    percent: asPercent(rec.percent),
    created: asString(rec.created) || timestamp,
    updated: asString(rec.updated) || timestamp,
    started: asNullable(rec.started),
    finished: asNullable(rec.finished),
  };
}

function gateResultFromYaml(raw: unknown, fallbackNode: string): {
  node: string;
  outcome: (typeof GATE_OUTCOMES)[number];
  notes: string;
  evaluator: string;
  at: string;
} {
  const rec = asRecord(raw);
  return {
    node: asString(rec.node) || fallbackNode,
    outcome: asEnum(rec.outcome, GATE_OUTCOMES, "PASS"),
    notes: cleanProse(asString(rec.notes)),
    evaluator: asString(rec.evaluator) || "agent",
    at: asString(rec.at),
  };
}

function planToYaml(plan: Plan): Record<string, unknown> {
  return {
    id: plan.id,
    version: plan.version,
    title: plan.title,
    rationale: plan.rationale,
    created_at: plan.createdAt,
    superseded_by: plan.supersededBy,
    nodes: plan.nodes.map(nodeToYaml),
    gates: plan.gates,
  };
}

function planFromYaml(raw: unknown, clock: Clock): Plan {
  const rec = asRecord(raw);
  const timestamp = clock.now();
  return {
    id: asString(rec.id),
    version: Math.max(1, Math.round(asNumber(rec.version, 1))),
    title: asString(rec.title) || "Plan",
    rationale: cleanProse(asString(rec.rationale)),
    createdAt: asString(rec.created_at ?? rec.createdAt) || timestamp,
    supersededBy: asNullable(rec.superseded_by ?? rec.supersededBy),
    nodes: (Array.isArray(rec.nodes) ? rec.nodes : []).map((node) => nodeFromYaml(node, clock)),
    gates: (Array.isArray(rec.gates) ? rec.gates : []).map((gate) => gateResultFromYaml(gate, "")),
  };
}

function planChangeFromYaml(raw: unknown): PlanChange {
  const rec = asRecord(raw);
  return {
    from: asNullable(rec.from),
    to: asString(rec.to),
    reason: cleanProse(asString(rec.reason)),
    trigger: cleanProse(asString(rec.trigger)),
    at: asString(rec.at),
    by: asString(rec.by) || "agent",
  };
}

function historyEventFromYaml(raw: unknown, fallbackSeq: number): HistoryEvent {
  const rec = asRecord(raw);
  return {
    seq: Math.round(asNumber(rec.seq, fallbackSeq)),
    at: asString(rec.at),
    kind: asEnum(rec.kind, HISTORY_KINDS, "task.updated"),
    summary: asString(rec.summary),
    by: asString(rec.by) || "agent",
    refs: asStringArray(rec.refs),
    ...(rec.details !== undefined ? { details: asRecord(rec.details) } : {}),
  };
}

function decisionToFrontMatter(decision: Decision): Record<string, unknown> {
  return {
    id: decision.id,
    title: decision.title,
    authority: decision.authority,
    approved_by: decision.approvedBy,
    auto_accepted: decision.autoAccepted,
    goals: decision.goals,
    questions: decision.questions,
    risks: decision.risks,
    plan: decision.plan,
    alternatives: decision.alternatives,
    evidence: decision.evidence,
    at: decision.at,
  };
}

function decisionFromFrontMatter(data: Record<string, unknown>, body: string): Decision {
  const sections = parseSections(body);
  return {
    id: asString(data.id),
    title: asString(data.title) || "Decision",
    decision: cleanProse(section(sections, "decision") || body),
    rationale: cleanProse(section(sections, "rationale")),
    alternatives: asStringArray(data.alternatives),
    evidence: Array.isArray(data.evidence) ? data.evidence.map(evidenceFromYaml) : [],
    goals: asStringArray(data.goals),
    questions: asStringArray(data.questions),
    risks: asStringArray(data.risks),
    plan: asNullable(data.plan),
    authority: asEnum(data.authority, AUTHORITY_LEVELS, "SIGNIFICANT"),
    approvedBy: asNullable(data.approved_by ?? data.approvedBy),
    autoAccepted: asBoolean(data.auto_accepted ?? data.autoAccepted, false),
    at: asString(data.at),
  };
}

function serializeDecision(decision: Decision): string {
  const body = renderSections(`Decision ${decision.id}: ${decision.title}`, [
    ["Decision", cleanProse(decision.decision) || "_Not recorded._"],
    ["Rationale", cleanProse(decision.rationale) || "_Not recorded._"],
    ["Alternatives Considered", renderBullets(decision.alternatives)],
    ["Evidence", decision.evidence.length === 0
      ? "_None recorded._"
      : decision.evidence
          .map((item) => `- ${item.description}${item.ref ? ` (${item.ref})` : ""}${item.run ? ` [${item.run}]` : ""}`)
          .join("\n")],
  ]);
  return renderFrontMatter(decisionToFrontMatter(decision), body);
}

function runToYaml(run: Run): Record<string, unknown> {
  return {
    id: run.id,
    title: run.title,
    node: run.node,
    status: run.status,
    environment: run.environment,
    command: run.command,
    cwd: run.cwd,
    pid: run.pid,
    host: run.host,
    session: run.session,
    log: run.log,
    exit_code: run.exitCode,
    started: run.started,
    finished: run.finished,
    updated: run.updated,
    entries: run.entries,
    outputs: run.outputs,
  };
}

function runFromYaml(raw: unknown, fallbackId: string, clock: Clock): Run {
  const rec = asRecord(raw);
  const timestamp = clock.now();
  return {
    id: asString(rec.id) || fallbackId,
    title: asString(rec.title) || "Run",
    node: asNullable(rec.node),
    status: asEnum(rec.status, RUN_STATUSES, "RUNNING"),
    environment: (Array.isArray(rec.environment) ? rec.environment : []).map((entry): ExternalRef => {
      const ref = asRecord(entry);
      return {
        kind: asEnum(ref.kind, ["local", "ssh", "docker", "gpu", "cloud", "api", "other"] as const, "local"),
        target: asString(ref.target),
        ...(ref.note !== undefined ? { note: asString(ref.note) } : {}),
      };
    }),
    command: asNullable(rec.command),
    cwd: asNullable(rec.cwd),
    pid: rec.pid === null || rec.pid === undefined ? null : Math.round(asNumber(rec.pid, 0)) || null,
    host: asNullable(rec.host),
    session: asNullable(rec.session),
    log: asNullable(rec.log),
    exitCode: rec.exit_code === null || rec.exit_code === undefined
      ? null
      : Math.round(asNumber(rec.exit_code, 0)),
    started: asString(rec.started) || timestamp,
    finished: asNullable(rec.finished),
    updated: asString(rec.updated) || timestamp,
    entries: (Array.isArray(rec.entries) ? rec.entries : []).map((entry) => {
      const item = asRecord(entry);
      return {
        at: asString(item.at),
        kind: asEnum(item.kind, ["note", "progress", "output", "error", "checkpoint"] as const, "note"),
        text: asString(item.text),
      };
    }),
    outputs: (Array.isArray(rec.outputs) ? rec.outputs : []).map(evidenceFromYaml),
  };
}

/* ------------------------------------------------------------------ */
/* Section-level serialization (used by the human edit path)          */
/* ------------------------------------------------------------------ */

/** Serialize goals as the exact YAML stored in `.project/goals.yaml`. */
export function serializeGoals(goals: readonly Goal[]): string {
  return yamlFile(goals.map(goalToYaml));
}

export function parseGoals(text: string, clock: Clock = systemClock): Goal[] {
  const raw = parseYaml(text) as unknown;
  if (!Array.isArray(raw)) throw new Error("goals.yaml must contain a YAML list");
  return raw.map((goal) => goalFromYaml(goal, clock));
}

export function serializeQuestions(questions: readonly Question[]): string {
  return yamlFile(questions.map(questionToYaml));
}

export function parseQuestions(text: string, clock: Clock = systemClock): Question[] {
  const raw = parseYaml(text) as unknown;
  if (!Array.isArray(raw)) throw new Error("intelligence.yaml must contain a YAML list");
  return raw.map((question) => questionFromYaml(question, clock));
}

export function serializeRisks(risks: readonly Risk[]): string {
  return yamlFile(risks.map(riskToYaml));
}

export function parseRisks(text: string, clock: Clock = systemClock): Risk[] {
  const raw = parseYaml(text) as unknown;
  if (!Array.isArray(raw)) throw new Error("risks.yaml must contain a YAML list");
  return raw.map((risk) => riskFromYaml(risk, clock));
}

export function serializePlans(plans: PlansFile): string {
  return yamlFile({
    active: plans.active,
    plans: plans.plans.map(planToYaml),
    changes: plans.changes,
  });
}

export function parsePlans(text: string, clock: Clock = systemClock): PlansFile {
  const raw = asRecord(parseYaml(text) as unknown);
  return {
    active: asNullable(raw.active),
    plans: (Array.isArray(raw.plans) ? raw.plans : []).map((plan) => planFromYaml(plan, clock)),
    changes: (Array.isArray(raw.changes) ? raw.changes : []).map(planChangeFromYaml),
  };
}

/* ------------------------------------------------------------------ */
/* Derived human-readable documents                                   */
/* ------------------------------------------------------------------ */

/** Render the active plan as a readable document with an ASCII DAG sketch. */
export function renderPlanDocument(plans: PlansFile): string {
  const plan = plans.plans.find((item) => item.id === plans.active) ?? plans.plans[plans.plans.length - 1];
  if (!plan) return "# Plan\n\n_No plan yet._\n";

  const lines: string[] = [`# Plan ${plan.id} (v${plan.version})`, "", plan.title, ""];
  if (plan.rationale) lines.push(`Rationale: ${plan.rationale}`, "");

  lines.push("## Nodes", "");
  if (plan.nodes.length === 0) lines.push("_No nodes yet._");
  for (const node of plan.nodes) {
    const deps = node.dependsOn.length > 0 ? ` (after ${node.dependsOn.join(", ")})` : "";
    const links = [
      node.goal ? `goal:${node.goal}` : null,
      node.question ? `q:${node.question}` : null,
      node.risk ? `risk:${node.risk}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`- [${node.status}] ${node.id} ${node.type} — ${node.title}${deps}${links ? ` {${links}}` : ""}`);
    if (node.description) lines.push(`    ${node.description}`);
    if (node.gate) lines.push(`    gate: ${node.gate.type} — ${node.gate.criteria}`);
    if (node.failureReason) lines.push(`    failure: ${node.failureReason}`);
    if (node.outputs.length > 0) lines.push(`    outputs: ${node.outputs.join("; ")}`);
  }

  lines.push("", "## Edges", "");
  const edges = plan.nodes.flatMap((node) => node.dependsOn.map((dep) => `${dep} -> ${node.id}`));
  lines.push(edges.length > 0 ? edges.join("\n") : "_No edges._");

  if (plan.gates.length > 0) {
    lines.push("", "## Gate Results", "");
    for (const gate of plan.gates) {
      lines.push(`- ${gate.at} ${gate.node} ${gate.outcome}${gate.notes ? ` — ${gate.notes}` : ""}`);
    }
  }

  if (plans.changes.length > 0) {
    lines.push("", "## Plan Changes", "");
    for (const change of plans.changes) {
      lines.push(`- ${change.at} ${change.from ?? "none"} -> ${change.to}: ${change.reason}`);
    }
  }

  return lines.join("\n") + "\n";
}

/** Render the semantic history as a narrative (spec 20). */
export function renderHistoryDocument(events: readonly HistoryEvent[]): string {
  const lines = ["# Project History", "", "_High-level semantic history. Git holds the low-level history._", ""];
  if (events.length === 0) {
    lines.push("_Nothing recorded yet._", "");
    return lines.join("\n");
  }
  for (const event of events) {
    const refs = event.refs.length > 0 ? ` [${event.refs.join(", ")}]` : "";
    lines.push(`- ${event.at} **${event.kind}** — ${event.summary}${refs} (by ${event.by})`);
  }
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Defaults                                                           */
/* ------------------------------------------------------------------ */

export function defaultMeta(name: string, clock: Clock = systemClock): ProjectMeta {
  const timestamp = clock.now();
  return {
    name,
    id: slugify(name),
    created: timestamp,
    updated: timestamp,
    repositories: [],
    resources: [],
    workspace: null,
    yolo: false,
    autoCommit: true,
    activePlan: null,
    completed: false,
    completedAt: null,
    paused: false,
    pausedAt: null,
    resumeNote: null,
  };
}

export function emptyDirection(): Direction {
  return { vision: "", intent: "", values: [], concepts: [] };
}

export function emptyState(clock: Clock = systemClock): ProjectState {
  return {
    initial: "",
    current: "",
    capabilities: [],
    facts: [],
    problems: [],
    constraints: [],
    discoveries: [],
    updated: clock.now(),
  };
}

export function emptyStrategy(clock: Clock = systemClock): Strategy {
  return { approach: "", hypotheses: [], priorities: [], rationale: "", alternatives: [], updated: clock.now() };
}

export function emptyPlans(): PlansFile {
  return { active: null, plans: [], changes: [] };
}

/* ------------------------------------------------------------------ */
/* Load / save                                                        */
/* ------------------------------------------------------------------ */

export async function loadProject(root: string, clock: Clock = systemClock): Promise<Project> {
  const dir = join(root, PROJECT_DIR);

  const metaRaw = asRecord(await readYamlIfExists(join(dir, "project.yaml")));
  const meta: ProjectMeta = {
    name: asString(metaRaw.name) || "Untitled project",
    id: asString(metaRaw.id) || slugify(asString(metaRaw.name) || "project"),
    created: asString(metaRaw.created) || clock.now(),
    updated: asString(metaRaw.updated) || clock.now(),
    repositories: asStringArray(metaRaw.repositories),
    resources: (Array.isArray(metaRaw.resources) ? metaRaw.resources : []).map((entry): ExternalRef => {
      const rec = asRecord(entry);
      return {
        kind: asEnum(rec.kind, ["local", "ssh", "docker", "gpu", "cloud", "api", "other"] as const, "local"),
        target: asString(rec.target),
      };
    }),
    workspace: asNullable(metaRaw.workspace),
    yolo: asBoolean(metaRaw.yolo, false),
    autoCommit: asBoolean(metaRaw.auto_commit ?? metaRaw.autoCommit, true),
    activePlan: asNullable(metaRaw.active_plan ?? metaRaw.activePlan),
    completed: asBoolean(metaRaw.completed, false),
    completedAt: asNullable(metaRaw.completed_at ?? metaRaw.completedAt),
    paused: asBoolean(metaRaw.paused, false),
    pausedAt: asNullable(metaRaw.paused_at ?? metaRaw.pausedAt),
    resumeNote: asNullable(metaRaw.resume_note ?? metaRaw.resumeNote),
  };

  const directionText = (await readTextIfExists(join(dir, "direction.md"))) ?? "";
  const stateText = (await readTextIfExists(join(dir, "state.md"))) ?? "";
  const strategyText = (await readTextIfExists(join(dir, "strategy.md"))) ?? "";

  const goalsRaw = await readYamlIfExists(join(dir, "goals.yaml"));
  const questionsRaw = await readYamlIfExists(join(dir, "intelligence.yaml"));
  const risksRaw = await readYamlIfExists(join(dir, "risks.yaml"));
  const plansRaw = asRecord(await readYamlIfExists(join(dir, "plan.yaml")));

  const goals = (Array.isArray(goalsRaw) ? goalsRaw : []).map((goal) => goalFromYaml(goal, clock));
  const questions = (Array.isArray(questionsRaw) ? questionsRaw : []).map((question) =>
    questionFromYaml(question, clock),
  );
  const risks = (Array.isArray(risksRaw) ? risksRaw : []).map((risk) => riskFromYaml(risk, clock));
  const plans: PlansFile = {
    active: asNullable(plansRaw.active),
    plans: (Array.isArray(plansRaw.plans) ? plansRaw.plans : []).map((plan) => planFromYaml(plan, clock)),
    changes: (Array.isArray(plansRaw.changes) ? plansRaw.changes : []).map(planChangeFromYaml),
  };

  const decisionsDir = join(dir, "decisions");
  const decisions: Decision[] = [];
  if (existsSync(decisionsDir)) {
    const files = (await readdir(decisionsDir)).filter((file) => file.endsWith(".md")).sort();
    for (const file of files) {
      const text = (await readTextIfExists(join(decisionsDir, file))) ?? "";
      const { data, body } = parseFrontMatter(text);
      const decision = decisionFromFrontMatter(data, body);
      if (!decision.id) decision.id = file.replace(/\.md$/, "");
      decisions.push(decision);
    }
  }

  const historyFile = join(dir, "history", "events.jsonl");
  const history: HistoryEvent[] = [];
  const historyText = await readTextIfExists(historyFile);
  if (historyText) {
    let seq = 0;
    for (const line of historyText.split("\n")) {
      if (line.trim() === "") continue;
      seq += 1;
      try {
        history.push(historyEventFromYaml(JSON.parse(line) as unknown, seq));
      } catch {
        // Skip malformed line rather than losing the whole project.
      }
    }
  }

  const runsDir = join(dir, "runs");
  const runs: Run[] = [];
  if (existsSync(runsDir)) {
    const files = (await readdir(runsDir)).filter((file) => file.endsWith(".yaml")).sort();
    for (const file of files) {
      const raw = await readYamlIfExists(join(runsDir, file));
      const fallback = file.replace(/\.yaml$/, "");
      runs.push(runFromYaml(raw, fallback, clock));
      const logFile = join(runsDir, `${fallback}.log`);
      const run = runs[runs.length - 1]!;
      if (existsSync(logFile) && !run.log) run.log = logFile;
    }
  }

  return {
    root: resolve(root),
    meta,
    direction: directionText ? parseDirection(directionText) : emptyDirection(),
    goals,
    state: stateText ? parseState(stateText, clock) : emptyState(clock),
    questions,
    risks,
    strategy: strategyText ? parseStrategy(strategyText) : emptyStrategy(clock),
    plans,
    decisions,
    runs,
    history,
  };
}

export interface SaveOptions {
  clock?: Clock;
  /** Skip derived documents (plan.md/history.md/summary.md). */
  skipDerived?: boolean;
}

export async function saveProject(project: Project, options: SaveOptions = {}): Promise<void> {
  const clock = options.clock ?? systemClock;
  const dir = join(project.root, PROJECT_DIR);

  project.meta.updated = clock.now();

  await writeFileAtomic(
    join(dir, "project.yaml"),
    yamlFile({
      name: project.meta.name,
      id: project.meta.id,
      created: project.meta.created,
      updated: project.meta.updated,
      repositories: project.meta.repositories,
      resources: project.meta.resources,
      workspace: project.meta.workspace,
      yolo: project.meta.yolo,
      auto_commit: project.meta.autoCommit,
      active_plan: project.meta.activePlan,
      completed: project.meta.completed,
      completed_at: project.meta.completedAt ?? null,
      paused: project.meta.paused,
      paused_at: project.meta.pausedAt ?? null,
      resume_note: project.meta.resumeNote ?? null,
    }),
  );

  await writeFileAtomic(join(dir, "direction.md"), serializeDirection(project.direction));
  await writeFileAtomic(join(dir, "goals.yaml"), yamlFile(project.goals.map(goalToYaml)));
  await writeFileAtomic(join(dir, "state.md"), serializeState(project.state));
  await writeFileAtomic(join(dir, "intelligence.yaml"), yamlFile(project.questions.map(questionToYaml)));
  await writeFileAtomic(join(dir, "risks.yaml"), yamlFile(project.risks.map(riskToYaml)));
  await writeFileAtomic(join(dir, "strategy.md"), serializeStrategy(project.strategy));
  await writeFileAtomic(
    join(dir, "plan.yaml"),
    yamlFile({
      active: project.plans.active,
      plans: project.plans.plans.map(planToYaml),
      changes: project.plans.changes,
    }),
  );

  await mkdir(join(dir, "decisions"), { recursive: true });
  for (const decision of project.decisions) {
    await writeFileAtomic(join(dir, "decisions", `${decision.id}.md`), serializeDecision(decision));
  }

  await mkdir(join(dir, "history"), { recursive: true });
  await writeFileAtomic(
    join(dir, "history", "events.jsonl"),
    project.history.map((event) => JSON.stringify(event)).join("\n") + (project.history.length > 0 ? "\n" : ""),
  );

  await mkdir(join(dir, "runs"), { recursive: true });
  for (const run of project.runs) {
    await writeFileAtomic(join(dir, "runs", `${run.id}.yaml`), yamlFile(runToYaml(run)));
  }

  if (!options.skipDerived) {
    await writeFileAtomic(join(dir, "plan.md"), renderPlanDocument(project.plans));
    await writeFileAtomic(join(dir, "history", "history.md"), renderHistoryDocument(project.history));
    await writeFileAtomic(join(dir, "summary.md"), renderCompletionSummary(project));
  }
}

/* ------------------------------------------------------------------ */
/* Git                                                                */
/* ------------------------------------------------------------------ */

export interface GitResult {
  committed: boolean;
  message?: string;
  error?: string;
}

/**
 * Best-effort auto-commit of `.project` changes (spec 19: Git-friendly,
 * spec 20: Git provides low-level history). Never throws.
 */
export async function commitProjectChanges(root: string, message: string): Promise<GitResult> {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
  } catch {
    return { committed: false };
  }

  try {
    await execFileAsync("git", ["add", "--", PROJECT_DIR], { cwd: root });
    const { stdout } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: root });
    if (stdout.trim() === "") return { committed: false };
    await execFileAsync("git", ["commit", "-m", message, "--", PROJECT_DIR], { cwd: root });
    return { committed: true, message };
  } catch (error) {
    return { committed: false, error: (error as Error).message };
  }
}

/* ------------------------------------------------------------------ */
/* Init                                                               */
/* ------------------------------------------------------------------ */

export async function initProject(root: string, options: {
  name?: string;
  clock?: Clock;
  workspace?: string | null;
  yolo?: boolean;
  repos?: string[];
} = {}): Promise<Project> {
  const clock = options.clock ?? systemClock;
  const name = options.name?.trim() || slugify(resolve(root));
  const project: Project = {
    root: resolve(root),
    meta: {
      ...defaultMeta(name, clock),
      workspace: options.workspace ?? null,
      yolo: options.yolo ?? false,
      repositories: options.repos ?? [],
    },
    direction: emptyDirection(),
    goals: [],
    state: emptyState(clock),
    questions: [],
    risks: [],
    strategy: emptyStrategy(clock),
    plans: emptyPlans(),
    decisions: [],
    runs: [],
    history: [],
  };
  await mkdir(join(project.root, PROJECT_DIR), { recursive: true });
  return project;
}
