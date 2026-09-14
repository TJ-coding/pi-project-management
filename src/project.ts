/**
 * ProjectManager: the single mutation surface for a project.
 *
 * Every write goes through `mutate`, which:
 *   1. serializes concurrent mutations per project root,
 *   2. re-reads the project from disk (so parallel Pi sessions and hand edits
 *      are respected),
 *   3. records semantic history,
 *   4. persists all files,
 *   5. optionally commits the `.project` directory to git.
 *
 * Read paths go through `read`, which also re-reads from disk so the in-memory
 * project never drifts from what a human sees in their editor.
 */

import { cleanProse } from "./markdown.ts";
import { appendHistory } from "./history.ts";
import { nextId, slugify } from "./ids.ts";
import { analyzeReplan, applyReplan as applyReplanProposal, activePlan, type ReplanInputs, type ReplanProposal } from "./replan.ts";
import { clamp01, clampInt } from "./scoring.ts";
import { readyNodes } from "./dag.ts";
import {
  commitProjectChanges,
  findProjectRoot,
  initProject,
  loadProject,
  projectMarkerPath,
  registerInWorkspace,
  saveProject,
  systemClock,
  type Clock,
  type GitResult,
} from "./storage.ts";
import { validateProject, validateProjectDetailed } from "./validate.ts";
import { assertBudgets, collectTextFields } from "./limits.ts";
import type {
  AnswerStatus,
  AuthorityLevel,
  Concept,
  Decision,
  Direction,
  Evidence,
  ExternalRef,
  GateOutcome,
  GateSpec,
  Goal,
  GoalStatus,
  HistoryKind,
  NodeStatus,
  NodeType,
  Plan,
  PlanNode,
  PlansFile,
  Project,
  ProjectState,
  Question,
  Risk,
  RiskStatus,
  Run,
  RunStatus,
  Strategy,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* Locking                                                            */
/* ------------------------------------------------------------------ */

const locks = new Map<string, Promise<unknown>>();

export function withProjectLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(root) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  locks.set(
    root,
    next.catch(() => undefined),
  );
  return next;
}

/* ------------------------------------------------------------------ */
/* Authorization (spec 14, 15)                                        */
/* ------------------------------------------------------------------ */

export interface AuthorizationResult {
  level: AuthorityLevel;
  allowed: boolean;
  autoAccepted: boolean;
  requiresApproval: boolean;
  message: string;
}

export function checkAuthorization(
  project: { meta: { yolo: boolean } },
  level: AuthorityLevel,
  action: string,
  reason: string,
): AuthorizationResult {
  if (level === "STRATEGIC") {
    if (project.meta.yolo) {
      return {
        level,
        allowed: true,
        autoAccepted: true,
        requiresApproval: false,
        message: `Pi automatically accepted: ${action}\nReason: ${reason}`,
      };
    }
    return {
      level,
      allowed: false,
      autoAccepted: false,
      requiresApproval: true,
      message: `This is a STRATEGIC change (${action}). It requires human approval. Ask the user, then re-run with approved=true.`,
    };
  }
  return { level, allowed: true, autoAccepted: false, requiresApproval: false, message: "" };
}

export type StrategicOutcome<T> =
  | { status: "applied"; value: T; autoAccepted: boolean; note: string }
  | { status: "requires-approval"; message: string; level: AuthorityLevel };

/* ------------------------------------------------------------------ */
/* Inputs                                                             */
/* ------------------------------------------------------------------ */

export interface MutateOptions {
  by?: string;
  /** Skip the git commit for this mutation. */
  commit?: boolean;
}

export interface GoalInput {
  title: string;
  description?: string;
  priority?: number;
  successCriteria?: string[];
  parent?: string | null;
  questions?: string[];
  risks?: string[];
  tasks?: string[];
  status?: GoalStatus;
  percent?: number | null;
}

/**
 * Percent as given by a caller: absent means "no estimate", which is null.
 * Anything present but outside 0..100 throws, so a bad value never reaches
 * disk — G11 asks for a number the human can trust, not a silently clamped one.
 */
function newPercent(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`percent must be a number between 0 and 100, got ${JSON.stringify(value)}`);
  }
  if (value < 0 || value > 100) {
    throw new Error(`percent must be between 0 and 100, got ${value}`);
  }
  return clampInt(value, 0, 100, 0);
}

/** Everything that can be taken out of the way without being deleted. */
export const ARCHIVABLE_KINDS = ["goal", "question", "risk", "node"] as const;
export type ArchivableKind = (typeof ARCHIVABLE_KINDS)[number];

const ARCHIVABLE_LABEL: Record<ArchivableKind, string> = {
  goal: "Goal",
  question: "Question",
  risk: "Risk",
  node: "Node",
};

/** The one-line human name of an archived thing, for the history entry. */
const ARCHIVABLE_TITLE: Record<ArchivableKind, (entity: ArchivableEntity) => string> = {
  goal: (entity) => (entity as Goal).title,
  question: (entity) => (entity as Question).question,
  risk: (entity) => (entity as Risk).title,
  node: (entity) => (entity as PlanNode).title,
};

type ArchivableEntity = Goal | Question | Risk | PlanNode;

export interface ArchiveOutcome {
  id: string;
  kind: ArchivableKind;
  archived: boolean;
  /** False when it was already in the requested state, so nothing changed. */
  changed: boolean;
}

export interface QuestionInput {
  question: string;
  answer?: string;
  status?: AnswerStatus;
  importance?: number;
  uncertainty?: number;
  decisionImpact?: number;
  confidence?: number;
  evidence?: Evidence[];
  goals?: string[];
  risks?: string[];
  tasks?: string[];
}

export interface RiskInput {
  title: string;
  description?: string;
  probability?: number;
  impact?: number;
  status?: RiskStatus;
  mitigation?: string;
  contingency?: string;
  questions?: string[];
  goals?: string[];
  tasks?: string[];
  owner?: string;
}

export interface NodeInput {
  title: string;
  type?: NodeType;
  description?: string;
  dependsOn?: string[];
  goal?: string | null;
  risk?: string | null;
  question?: string | null;
  gate?: GateSpec | null;
  assignee?: "agent" | "human";
  id?: string;
  status?: NodeStatus;
  percent?: number | null;
}

export interface DecisionInput {
  title: string;
  decision: string;
  rationale?: string;
  alternatives?: string[];
  evidence?: Evidence[];
  goals?: string[];
  questions?: string[];
  risks?: string[];
  plan?: string | null;
  authority?: AuthorityLevel;
}

export interface RunInput {
  title: string;
  node?: string | null;
  environment?: ExternalRef[];
  command?: string | null;
  cwd?: string | null;
  pid?: number | null;
  host?: string | null;
  session?: string | null;
  log?: string | null;
  status?: RunStatus;
}

export interface ManagerOptions {
  clock?: Clock;
  by?: string;
}

/* ------------------------------------------------------------------ */
/* ProjectManager                                                     */
/* ------------------------------------------------------------------ */

export class ProjectManager {
  project: Project;
  readonly clock: Clock;
  by: string;

  constructor(project: Project, options: ManagerOptions = {}) {
    this.project = project;
    this.clock = options.clock ?? systemClock;
    this.by = options.by ?? "agent";
  }

  get root(): string {
    return this.project.root;
  }

  static async init(root: string, options: {
    name?: string;
    vision?: string;
    intent?: string;
    values?: string[];
    concepts?: Concept[];
    workspace?: string | null;
    yolo?: boolean;
    repos?: string[];
    clock?: Clock;
    by?: string;
  } = {}): Promise<ProjectManager> {
    const clock = options.clock ?? systemClock;
    const project = await initProject(root, {
      name: options.name,
      clock,
      workspace: options.workspace,
      yolo: options.yolo,
      repos: options.repos,
    });
    project.direction.vision = cleanProse(options.vision);
    project.direction.intent = cleanProse(options.intent);
    project.direction.values = options.values ?? [];
    project.direction.concepts = options.concepts ?? [];
    project.state.initial = "Project initialized.";

    const manager = new ProjectManager(project, { clock, by: options.by ?? "agent" });
    appendHistory(
      project,
      { kind: "project.init", summary: `Project initialized at ${project.root}`, by: manager.by, refs: [] },
      clock.now(),
    );
    await saveProject(project, { clock });
    if (project.meta.autoCommit) await commitProjectChanges(project.root, `project: initialize ${project.meta.name}`);
    if (project.meta.workspace) await registerInWorkspace(project.root, project.meta.name);
    return manager;
  }

  static async open(root: string, options: ManagerOptions = {}): Promise<ProjectManager> {
    const clock = options.clock ?? systemClock;
    const project = await loadProject(root, clock);
    return new ProjectManager(project, { clock, by: options.by });
  }

  /** Discover the project containing `cwd`, if any. */
  static async discover(cwd: string, options: ManagerOptions = {}): Promise<ProjectManager | null> {
    const root = findRoot(cwd);
    if (!root) return null;
    return ProjectManager.open(root, options);
  }

  /* ---------------- read / mutate ---------------- */

  async refresh<T>(fn?: (project: Project) => T): Promise<T | Project> {
    return withProjectLock(this.root, async () => {
      this.project = await loadProject(this.root, this.clock);
      return fn ? fn(this.project) : this.project;
    });
  }

  async read<T>(fn: (project: Project) => T): Promise<T> {
    return withProjectLock(this.root, async () => {
      this.project = await loadProject(this.root, this.clock);
      return fn(this.project);
    });
  }

  async mutate<T>(
    message: string | null,
    fn: (project: Project) => T | Promise<T>,
    options: MutateOptions = {},
  ): Promise<{ value: T; git: GitResult | null }> {
    return withProjectLock(this.root, async () => {
      const project = await loadProject(this.root, this.clock);
      this.project = project;
      // Budgets are checked before anything is written: an over-long edit is
      // rejected (limits.ts) instead of being saved and only noticed later.
      const before = collectTextFields(project);
      const value = await fn(project);
      assertBudgets(before, collectTextFields(project));
      await saveProject(project, { clock: this.clock });
      let git: GitResult | null = null;
      if (message && options.commit !== false && project.meta.autoCommit) {
        git = await commitProjectChanges(project.root, message);
      }
      return { value, git };
    });
  }

  private record(kind: HistoryKind, summary: string, refs: string[], details?: Record<string, unknown>, by?: string): void {
    appendHistory(
      this.project,
      { kind, summary, by: by ?? this.by, refs, ...(details ? { details } : {}) },
      this.clock.now(),
    );
  }

  /* ---------------- direction ---------------- */

  async updateDirection(
    patch: Partial<Direction>,
    options: MutateOptions & { approved?: boolean; approvedBy?: string; reason?: string } = {},
  ): Promise<StrategicOutcome<Direction>> {
    const touching = patch.vision !== undefined || patch.intent !== undefined || patch.values !== undefined;
    const reason = options.reason ?? "direction change requested";
    const gate = touching
      ? await this.authorize("STRATEGIC", "change direction", reason)
      : { level: "ROUTINE" as AuthorityLevel, allowed: true, autoAccepted: false, requiresApproval: false, message: "" };
    if (!gate.allowed && !options.approved) {
      return { status: "requires-approval", message: gate.message, level: gate.level };
    }
    const autoAccepted = options.approved ? false : gate.autoAccepted;

    const { value } = await this.mutate(`project: update direction (${reason})`, (project) => {
      const before = JSON.stringify(project.direction);
      if (patch.vision !== undefined) project.direction.vision = cleanProse(patch.vision);
      if (patch.intent !== undefined) project.direction.intent = cleanProse(patch.intent);
      if (patch.values !== undefined) project.direction.values = patch.values.map((value) => cleanProse(value));
      if (patch.concepts !== undefined) {
        project.direction.concepts = patch.concepts.map((concept) => ({
          type: cleanProse(concept.type) || "concept",
          text: cleanProse(concept.text),
        }));
      }
      project.direction.updated = this.clock.now();
      this.record("direction.changed", `Direction changed: ${reason}`, [], {
        autoAccepted,
        approvedBy: options.approvedBy ?? (options.approved ? "human" : null),
      });
      if (autoAccepted) {
        this.record("decision.made", `Pi automatically accepted: direction change (${reason})`, [], { autoAccepted: true });
      }
      void before;
      return project.direction;
    }, options);

    return {
      status: "applied",
      value,
      autoAccepted,
      note: autoAccepted
        ? `Pi automatically accepted: direction change. Reason: ${reason}`
        : options.approved
          ? `Direction change approved by ${options.approvedBy ?? "human"}.`
          : "",
    };
  }

  /* ---------------- goals ---------------- */

  async createGoal(input: GoalInput, options: MutateOptions = {}): Promise<Goal> {
    const status = input.status ?? "ACTIVE";
    return (
      await this.mutate(`project: add goal "${input.title}"`, (project) => {
        const id = nextId("goal", project.goals.map((goal) => goal.id));
        const timestamp = this.clock.now();
        const goal: Goal = {
          id,
          title: cleanProse(input.title),
          description: cleanProse(input.description),
          priority: clampInt(input.priority, 1, 5, 3),
          successCriteria: (input.successCriteria ?? []).map(cleanProse).filter(Boolean),
          status,
          parent: input.parent ?? null,
          questions: input.questions ?? [],
          risks: input.risks ?? [],
          tasks: input.tasks ?? [],
          percent: newPercent(input.percent),
          created: timestamp,
          updated: timestamp,
        };
        project.goals.push(goal);
        this.record("goal.created", `Goal ${id} created: ${goal.title}`, [id], { status, priority: goal.priority });
        return goal;
      }, options)
    ).value;
  }

  async updateGoal(
    id: string,
    patch: Partial<GoalInput> & { supersededBy?: string | null },
    options: MutateOptions = {},
  ): Promise<Goal> {
    if (patch.status !== undefined) {
      throw new Error(
        "Goal status is not changed by updateGoal: use setGoalStatus (it is gated for ABANDONED/SUPERSEDED).",
      );
    }
    return (
      await this.mutate(`project: update goal ${id}`, (project) => {
        const goal = mustFind(project.goals, id, "goal");
        if (patch.title !== undefined) goal.title = cleanProse(patch.title);
        if (patch.description !== undefined) goal.description = cleanProse(patch.description);
        if (patch.priority !== undefined) goal.priority = clampInt(patch.priority, 1, 5, goal.priority);
        if (patch.successCriteria !== undefined) goal.successCriteria = patch.successCriteria.map(cleanProse).filter(Boolean);
        if (patch.parent !== undefined) goal.parent = patch.parent;
        if (patch.questions !== undefined) goal.questions = patch.questions;
        if (patch.risks !== undefined) goal.risks = patch.risks;
        if (patch.tasks !== undefined) goal.tasks = patch.tasks;
        if (patch.percent !== undefined) goal.percent = newPercent(patch.percent);
        if (patch.supersededBy !== undefined) goal.supersededBy = patch.supersededBy;
        goal.updated = this.clock.now();
        this.record("goal.updated", `Goal ${id} updated: ${goal.title}`, [id]);
        return goal;
      }, options)
    ).value;
  }

  async setGoalStatus(
    id: string,
    status: GoalStatus,
    options: MutateOptions & { approved?: boolean; approvedBy?: string; reason?: string } = {},
  ): Promise<StrategicOutcome<Goal>> {
    const strategic = status === "ABANDONED" || status === "SUPERSEDED";
    const reason = options.reason ?? `goal ${id} -> ${status}`;
    let autoAccepted = false;
    if (strategic) {
      const gate = await this.authorize("STRATEGIC", `mark goal ${id} ${status}`, reason);
      if (!gate.allowed && !options.approved) {
        return { status: "requires-approval", message: gate.message, level: gate.level };
      }
      autoAccepted = !options.approved && gate.autoAccepted;
    }

    const { value } = await this.mutate(`project: goal ${id} -> ${status}`, (project) => {
      const goal = mustFind(project.goals, id, "goal");
      goal.status = status;
      goal.updated = this.clock.now();
      const kind: HistoryKind =
        status === "COMPLETED"
          ? "goal.completed"
          : status === "FAILED"
            ? "goal.failed"
            : status === "ABANDONED"
              ? "goal.abandoned"
              : status === "SUPERSEDED"
                ? "goal.superseded"
                : "goal.updated";
      this.record(kind, `Goal ${id} ${status}: ${goal.title}`, [id], { reason });
      if (autoAccepted) {
        this.record("decision.made", `Pi automatically accepted: goal ${id} ${status}. Reason: ${reason}`, [id], {
          autoAccepted: true,
        });
      }
      return goal;
    }, options);

    return { status: "applied", value, autoAccepted, note: autoAccepted ? `Pi automatically accepted: goal ${id} ${status}` : "" };
  }

  /* ---------------- archiving ---------------- */

  /**
   * Take something out of the way without deleting it. Archiving is deliberately
   * not a status: a goal can be COMPLETED *and* archived, and a resolved risk
   * that is archived must still be readable. Only the counts change.
   */
  async setArchived(
    kind: ArchivableKind,
    id: string,
    archived: boolean,
    options: MutateOptions & { reason?: string } = {},
  ): Promise<ArchiveOutcome> {
    const label = ARCHIVABLE_LABEL[kind];
    return (
      await this.mutate(`project: ${archived ? "archive" : "unarchive"} ${kind} ${id}`, (project) => {
        const target = this.findArchivable(project, kind, id);
        const was = target.archived === true;
        target.archived = archived;
        target.updated = this.clock.now();
        if (was !== archived) {
          const what = ARCHIVABLE_TITLE[kind](target);
          this.record(
            archived ? `${kind}.archived` : `${kind}.unarchived`,
            `${label} ${id} ${archived ? "archived" : "restored"}: ${what}${options.reason ? ` (${options.reason})` : ""}`,
            [id],
            { reason: options.reason },
          );
        }
        return { id, kind, archived, changed: was !== archived };
      }, options)
    ).value;
  }

  /** One lookup for every archivable kind, so the tool stays a single action. */
  private findArchivable(project: Project, kind: ArchivableKind, id: string): ArchivableEntity {
    switch (kind) {
      case "goal":
        return mustFind(project.goals, id, "goal");
      case "question":
        return mustFind(project.questions, id, "question");
      case "risk":
        return mustFind(project.risks, id, "risk");
      case "node": {
        const { node } = locateNode(project, id);
        return node;
      }
    }
  }

  /* ---------------- state ---------------- */

  async updateState(
    patch: Partial<ProjectState> & { append?: Partial<Pick<ProjectState, "capabilities" | "facts" | "problems" | "constraints" | "discoveries">> },
    options: MutateOptions & { summary?: string } = {},
  ): Promise<ProjectState> {
    const summary = options.summary ?? "state updated";
    return (
      await this.mutate(`project: update state (${summary})`, (project) => {
        if (patch.initial !== undefined) project.state.initial = cleanProse(patch.initial);
        if (patch.current !== undefined) project.state.current = cleanProse(patch.current);
        for (const key of ["capabilities", "facts", "problems", "constraints", "discoveries"] as const) {
          if (patch[key] !== undefined) project.state[key] = patch[key]!.map(cleanProse).filter(Boolean);
          if (patch.append?.[key] !== undefined) project.state[key].push(...patch.append[key]!.map(cleanProse).filter(Boolean));
        }
        project.state.updated = this.clock.now();
        this.record("state.changed", `State changed: ${summary}`, []);
        return project.state;
      }, options)
    ).value;
  }

  /* ---------------- intelligence ---------------- */

  async createQuestion(input: QuestionInput, options: MutateOptions = {}): Promise<Question> {
    return (
      await this.mutate(`project: add question "${truncate(input.question, 60)}"`, (project) => {
        const id = nextId("question", project.questions.map((question) => question.id));
        const timestamp = this.clock.now();
        const question: Question = {
          id,
          question: cleanProse(input.question),
          answer: cleanProse(input.answer),
          status: input.status ?? (input.answer ? "PARTIAL" : "UNKNOWN"),
          importance: clamp01(input.importance, 0.5),
          uncertainty: clamp01(input.uncertainty, 1),
          decisionImpact: clamp01(input.decisionImpact, 0.5),
          confidence: clamp01(input.confidence, 0),
          evidence: input.evidence ?? [],
          goals: input.goals ?? [],
          risks: input.risks ?? [],
          tasks: input.tasks ?? [],
          decisions: [],
          created: timestamp,
          updated: timestamp,
          answered: null,
        };
        project.questions.push(question);
        this.record("question.created", `Question ${id} created: ${question.question}`, [id]);
        return question;
      }, options)
    ).value;
  }

  async updateQuestion(id: string, patch: Partial<QuestionInput>, options: MutateOptions = {}): Promise<Question> {
    return (
      await this.mutate(`project: update question ${id}`, (project) => {
        const question = mustFind(project.questions, id, "question");
        if (patch.question !== undefined) question.question = cleanProse(patch.question);
        if (patch.answer !== undefined) question.answer = cleanProse(patch.answer);
        if (patch.status !== undefined) question.status = patch.status;
        if (patch.importance !== undefined) question.importance = clamp01(patch.importance, question.importance);
        if (patch.uncertainty !== undefined) question.uncertainty = clamp01(patch.uncertainty, question.uncertainty);
        if (patch.decisionImpact !== undefined) {
          question.decisionImpact = clamp01(patch.decisionImpact, question.decisionImpact);
        }
        if (patch.confidence !== undefined) question.confidence = clamp01(patch.confidence, question.confidence);
        if (patch.evidence !== undefined) question.evidence = patch.evidence;
        if (patch.goals !== undefined) question.goals = patch.goals;
        if (patch.risks !== undefined) question.risks = patch.risks;
        if (patch.tasks !== undefined) question.tasks = patch.tasks;
        question.updated = this.clock.now();
        this.record("question.updated", `Question ${id} updated`, [id]);
        return question;
      }, options)
    ).value;
  }

  async answerQuestion(
    id: string,
    answer: {
      answer: string;
      status: AnswerStatus;
      confidence?: number;
      evidence?: Evidence[];
      notes?: string;
    },
    options: MutateOptions = {},
  ): Promise<Question> {
    return (
      await this.mutate(`project: answer question ${id} (${answer.status})`, (project) => {
        const question = mustFind(project.questions, id, "question");
        question.answer = cleanProse(answer.answer);
        question.status = answer.status;
        if (answer.confidence !== undefined) question.confidence = clamp01(answer.confidence, question.confidence);
        if (answer.evidence) question.evidence.push(...answer.evidence);
        question.updated = this.clock.now();
        question.answered = question.status === "UNKNOWN" ? null : this.clock.now();
        question.uncertainty = uncertaintyForStatus(question.status, question.uncertainty);
        this.record("question.answered", `Question ${id} ${question.status}: ${question.question}`, [id, ...question.risks], {
          notes: answer.notes,
        });
        return question;
      }, options)
    ).value;
  }

  /** Update linked risk probabilities when a question is answered (spec 8). */
  async propagateQuestionToRisks(questionId: string, options: MutateOptions = {}): Promise<Risk[]> {
    return (
      await this.mutate(`project: propagate ${questionId} to linked risks`, (project) => {
        const question = mustFind(project.questions, questionId, "question");
        const updated: Risk[] = [];
        for (const riskId of question.risks) {
          const risk = project.risks.find((item) => item.id === riskId);
          if (!risk) continue;
          const delta = question.status === "CONFIRMED" ? 0.2 : question.status === "INVALIDATED" ? -0.25 : 0;
          if (delta === 0) continue;
          risk.probability = clamp01(risk.probability + delta, risk.probability);
          risk.updated = this.clock.now();
          updated.push(risk);
        }
        if (updated.length > 0) {
          this.record(
            "risk.updated",
            `Risk estimates updated from ${questionId} (${question.status})`,
            [questionId, ...updated.map((risk) => risk.id)],
          );
        }
        return updated;
      }, options)
    ).value;
  }

  /* ---------------- risks ---------------- */

  async createRisk(input: RiskInput, options: MutateOptions = {}): Promise<Risk> {
    return (
      await this.mutate(`project: add risk "${input.title}"`, (project) => {
        const id = nextId("risk", project.risks.map((risk) => risk.id));
        const timestamp = this.clock.now();
        const risk: Risk = {
          id,
          title: cleanProse(input.title),
          description: cleanProse(input.description),
          probability: clamp01(input.probability, 0.5),
          impact: clamp01(input.impact, 0.5),
          status: input.status ?? "OPEN",
          mitigation: cleanProse(input.mitigation),
          contingency: cleanProse(input.contingency),
          questions: input.questions ?? [],
          goals: input.goals ?? [],
          tasks: input.tasks ?? [],
          ...(input.owner !== undefined ? { owner: cleanProse(input.owner) } : {}),
          created: timestamp,
          updated: timestamp,
        };
        project.risks.push(risk);
        this.record("risk.created", `Risk ${id} created: ${risk.title}`, [id], {
          probability: risk.probability,
          impact: risk.impact,
        });
        return risk;
      }, options)
    ).value;
  }

  async updateRisk(id: string, patch: Partial<RiskInput>, options: MutateOptions = {}): Promise<Risk> {
    return (
      await this.mutate(`project: update risk ${id}`, (project) => {
        const risk = mustFind(project.risks, id, "risk");
        if (patch.title !== undefined) risk.title = cleanProse(patch.title);
        if (patch.description !== undefined) risk.description = cleanProse(patch.description);
        if (patch.probability !== undefined) risk.probability = clamp01(patch.probability, risk.probability);
        if (patch.impact !== undefined) risk.impact = clamp01(patch.impact, risk.impact);
        if (patch.status !== undefined) risk.status = patch.status;
        if (patch.mitigation !== undefined) risk.mitigation = cleanProse(patch.mitigation);
        if (patch.contingency !== undefined) risk.contingency = cleanProse(patch.contingency);
        if (patch.questions !== undefined) risk.questions = patch.questions;
        if (patch.goals !== undefined) risk.goals = patch.goals;
        if (patch.tasks !== undefined) risk.tasks = patch.tasks;
        if (patch.owner !== undefined) risk.owner = cleanProse(patch.owner);
        risk.updated = this.clock.now();
        const resolved = risk.status === "RESOLVED" || risk.status === "CLOSED";
        this.record(resolved ? "risk.resolved" : "risk.updated", `Risk ${id} ${resolved ? "resolved" : "updated"}: ${risk.title}`, [id]);
        return risk;
      }, options)
    ).value;
  }

  /* ---------------- strategy ---------------- */

  async setStrategy(
    patch: Partial<Strategy>,
    options: MutateOptions & { reason?: string } = {},
  ): Promise<Strategy> {
    const reason = options.reason ?? "strategy updated";
    return (
      await this.mutate(`project: update strategy (${reason})`, (project) => {
        if (patch.approach !== undefined) project.strategy.approach = cleanProse(patch.approach);
        if (patch.hypotheses !== undefined) project.strategy.hypotheses = patch.hypotheses.map(cleanProse);
        if (patch.priorities !== undefined) project.strategy.priorities = patch.priorities.map(cleanProse);
        if (patch.rationale !== undefined) project.strategy.rationale = cleanProse(patch.rationale);
        if (patch.alternatives !== undefined) project.strategy.alternatives = patch.alternatives.map(cleanProse);
        project.strategy.updated = this.clock.now();
        this.record("strategy.changed", `Strategy changed: ${reason}`, []);
        return project.strategy;
      }, options)
    ).value;
  }

  /* ---------------- plans ---------------- */

  analyzeReplan(inputs: ReplanInputs): ReplanProposal {
    return analyzeReplan(this.project, inputs);
  }

  async applyReplan(
    proposal: ReplanProposal,
    options: MutateOptions & { pivot?: boolean; approved?: boolean; approvedBy?: string } = {},
  ): Promise<StrategicOutcome<{ plan: Plan; notes: string[] }>> {
    let pivotGate: AuthorizationResult | null = null;
    if (options.pivot) {
      pivotGate = await this.authorize("STRATEGIC", "pivot the project plan", proposal.rationale);
      if (!pivotGate.allowed && !options.approved) {
        return { status: "requires-approval", message: pivotGate.message, level: pivotGate.level };
      }
    }
    const autoAccepted = options.pivot && !options.approved && pivotGate ? pivotGate.autoAccepted : false;
    const { value } = await this.mutate(
      `project: ${proposal.trigger ? "replan" : "plan"} — ${truncate(proposal.rationale, 60)}`,
      (project) => {
        const result = applyReplanProposal(project, proposal, {
          by: options.by ?? this.by,
          at: this.clock.now(),
          pivot: options.pivot ?? false,
        });
        if (autoAccepted) {
          this.record(
            "decision.made",
            `Pi automatically accepted: plan ${result.change.from ?? "none"} -> ${result.plan.id}. Reason: ${proposal.rationale}`,
            [result.plan.id],
            { autoAccepted: true },
          );
        }
        return { plan: result.plan, notes: result.notes };
      },
      options,
    );
    return { status: "applied", value, autoAccepted, note: autoAccepted ? "Pi automatically accepted the replan." : "" };
  }

  async setActivePlan(id: string, options: MutateOptions = {}): Promise<Plan> {
    return (
      await this.mutate(`project: activate plan ${id}`, (project) => {
        const plan = mustFind(project.plans.plans, id, "plan");
        project.plans.active = id;
        project.meta.activePlan = id;
        this.record("plan.changed", `Active plan set to ${id}`, [id]);
        return plan;
      }, options)
    ).value;
  }

  async addNode(input: NodeInput, options: MutateOptions = {}): Promise<PlanNode> {
    return (
      await this.mutate(`project: add node "${truncate(input.title, 50)}"`, (project) => {
        const preexisting = new Set(validateProjectDetailed(project).errors);
        const plan = activePlan(project) ?? this.createDraftPlan(project);
        const node: PlanNode = {
          id: input.id ?? nextId("node", plan.nodes.map((item) => item.id)),
          title: cleanProse(input.title),
          description: cleanProse(input.description),
          type: input.type ?? "TASK",
          status: input.status ?? "PENDING",
          dependsOn: input.dependsOn ?? [],
          goal: input.goal ?? null,
          risk: input.risk ?? null,
          question: input.question ?? null,
          outputs: [],
          failureReason: null,
          assignee: input.assignee ?? "agent",
          gate: input.gate ?? null,
          run: null,
          percent: newPercent(input.percent),
          created: this.clock.now(),
          updated: this.clock.now(),
          started: null,
          finished: null,
        };
        plan.nodes.push(node);
        assertNoNewErrors(project, preexisting, "plan node");
        this.record("task.updated", `Node ${node.id} added to ${plan.id}: ${node.title}`, [node.id]);
        return node;
      }, options)
    ).value;
  }

  /** Create a draft plan when a node is added before any replan happened. */
  private createDraftPlan(project: Project): Plan {
    const id = nextId("plan", project.plans.plans.map((plan) => plan.id));
    const timestamp = this.clock.now();
    const plan: Plan = {
      id,
      version: (project.plans.plans[project.plans.plans.length - 1]?.version ?? 0) + 1,
      title: "Draft plan",
      rationale: "Created implicitly when the first node was added.",
      createdAt: timestamp,
      supersededBy: null,
      nodes: [],
      gates: [],
    };
    project.plans.plans.push(plan);
    project.plans.active = id;
    project.meta.activePlan = id;
    this.record("plan.created", `Draft plan ${id} created`, [id]);
    return plan;
  }

  async updateNode(id: string, patch: Partial<NodeInput>, options: MutateOptions = {}): Promise<PlanNode> {
    return (
      await this.mutate(`project: update node ${id}`, (project) => {
        const preexisting = new Set(validateProjectDetailed(project).errors);
        const { plan, node } = locateNode(project, id);
        if (patch.title !== undefined) node.title = cleanProse(patch.title);
        if (patch.description !== undefined) node.description = cleanProse(patch.description);
        if (patch.type !== undefined) node.type = patch.type;
        if (patch.status !== undefined) node.status = patch.status;
        if (patch.dependsOn !== undefined) node.dependsOn = patch.dependsOn;
        if (patch.goal !== undefined) node.goal = patch.goal;
        if (patch.risk !== undefined) node.risk = patch.risk;
        if (patch.question !== undefined) node.question = patch.question;
        if (patch.gate !== undefined) node.gate = patch.gate;
        if (patch.assignee !== undefined) node.assignee = patch.assignee;
        if (patch.percent !== undefined) node.percent = newPercent(patch.percent);
        node.updated = this.clock.now();
        assertNoNewErrors(project, preexisting, "plan node");
        this.record("task.updated", `Node ${node.id} updated in ${plan.id}`, [node.id]);
        return node;
      }, options)
    ).value;
  }

  async removeNode(id: string, options: MutateOptions = {}): Promise<{ removed: string }> {
    return (
      await this.mutate(`project: remove node ${id}`, (project) => {
        const { plan } = locateNode(project, id);
        const before = plan.nodes.length;
        plan.nodes = plan.nodes.filter((node) => node.id !== id);
        for (const node of plan.nodes) node.dependsOn = node.dependsOn.filter((dep) => dep !== id);
        this.record("task.updated", `Node ${id} removed from ${plan.id}`, [id]);
        return { removed: `removed ${before - plan.nodes.length} node ${id}` };
      }, options)
    ).value;
  }

  async setNodeStatus(
    id: string,
    status: NodeStatus,
    options: MutateOptions & { reason?: string; outputs?: string[]; run?: string | null } = {},
  ): Promise<PlanNode> {
    return (
      await this.mutate(`project: node ${id} -> ${status}`, (project) => {
        const { plan, node } = locateNode(project, id);
        const previous = node.status;
        node.status = status;
        node.updated = this.clock.now();
        if (status === "RUNNING" && !node.started) node.started = this.clock.now();
        if (status === "COMPLETED" || status === "FAILED") node.finished = this.clock.now();
        if (status === "FAILED") node.failureReason = cleanProse(options.reason) || "no reason recorded";
        if (options.reason !== undefined && status !== "FAILED") {
          node.description = node.description || "";
        }
        if (options.outputs) node.outputs.push(...options.outputs.map(cleanProse));
        if (options.run !== undefined) node.run = options.run;
        this.record("task.updated", `Node ${node.id} ${previous} -> ${status}: ${node.title}`, [node.id], {
          reason: options.reason,
        });
        if (status === "FAILED") {
          this.record("gate.failed", `Node ${node.id} failed: ${options.reason ?? "no reason"}`, [node.id]);
        }
        void plan;
        return node;
      }, options)
    ).value;
  }

  async evaluateGate(
    nodeId: string,
    outcome: GateOutcome,
    notes: string,
    evaluator: string,
    options: MutateOptions = {},
  ): Promise<{ node: PlanNode; outcome: GateOutcome }> {
    return (
      await this.mutate(`project: gate ${nodeId} -> ${outcome}`, (project) => {
        const { plan, node } = locateNode(project, nodeId);
        plan.gates.push({
          node: nodeId,
          outcome,
          notes: cleanProse(notes),
          evaluator: cleanProse(evaluator) || this.by,
          at: this.clock.now(),
        });
        node.status = "COMPLETED";
        node.outputs.push(`gate ${outcome}${notes ? `: ${cleanProse(notes)}` : ""}`);
        node.updated = this.clock.now();
        node.finished = this.clock.now();
        this.record(
          outcome === "PASS" ? "gate.passed" : "gate.failed",
          `Gate ${nodeId} (${node.gate?.type ?? "GATE"}) -> ${outcome}${notes ? `: ${cleanProse(notes)}` : ""}`,
          [nodeId],
        );
        return { node, outcome };
      }, options)
    ).value;
  }

  /* ---------------- decisions ---------------- */

  async recordDecision(
    input: DecisionInput,
    options: MutateOptions & { approved?: boolean; approvedBy?: string } = {},
  ): Promise<StrategicOutcome<Decision>> {
    const authority = input.authority ?? "SIGNIFICANT";
    const reason = truncate(input.rationale || input.decision, 160);
    let autoAccepted = false;
    if (authority === "STRATEGIC") {
      const gate = await this.authorize(authority, `record decision "${input.title}"`, reason);
      if (!gate.allowed && !options.approved) {
        return { status: "requires-approval", message: gate.message, level: authority };
      }
      autoAccepted = !options.approved && gate.autoAccepted;
    }

    const { value } = await this.mutate(`project: decision "${truncate(input.title, 50)}"`, (project) => {
      const id = nextId("decision", project.decisions.map((decision) => decision.id));
      const decision: Decision = {
        id,
        title: cleanProse(input.title),
        decision: cleanProse(input.decision),
        rationale: cleanProse(input.rationale),
        alternatives: (input.alternatives ?? []).map(cleanProse),
        evidence: input.evidence ?? [],
        goals: input.goals ?? [],
        questions: input.questions ?? [],
        risks: input.risks ?? [],
        plan: input.plan ?? activePlan(project)?.id ?? null,
        authority,
        approvedBy: options.approvedBy ?? (options.approved ? "human" : null),
        autoAccepted,
        at: this.clock.now(),
      };
      project.decisions.push(decision);
      for (const questionId of decision.questions) {
        const question = project.questions.find((item) => item.id === questionId);
        if (question && !question.decisions.includes(id)) question.decisions.push(id);
      }
      this.record(
        "decision.made",
        `${autoAccepted ? "Auto-accepted (YOLO) " : ""}Decision ${id} (${authority}): ${decision.title}`,
        [id, ...decision.goals, ...decision.questions, ...decision.risks],
        { autoAccepted },
      );
      return decision;
    }, options);

    return { status: "applied", value, autoAccepted, note: autoAccepted ? `Pi automatically accepted decision ${value.id}` : "" };
  }

  /* ---------------- runs ---------------- */

  async startRun(input: RunInput, options: MutateOptions = {}): Promise<Run> {
    return (
      await this.mutate(`project: start run "${truncate(input.title, 50)}"`, (project) => {
        const id = nextId("run", project.runs.map((run) => run.id));
        const timestamp = this.clock.now();
        const run: Run = {
          id,
          title: cleanProse(input.title),
          node: input.node ?? null,
          status: input.status ?? "STARTED",
          environment: input.environment ?? [],
          command: input.command ?? null,
          cwd: input.cwd ?? null,
          pid: input.pid ?? null,
          host: input.host ?? null,
          session: input.session ?? null,
          log: input.log ?? null,
          exitCode: null,
          started: timestamp,
          finished: null,
          updated: timestamp,
          entries: [],
          outputs: [],
        };
        project.runs.push(run);
        if (run.node) {
          const found = findNodeAnywhere(project, run.node);
          if (found) {
            found.node.status = "RUNNING";
            found.node.run = id;
            if (!found.node.started) found.node.started = timestamp;
            found.node.updated = timestamp;
          }
        }
        this.record("run.started", `Run ${id} started: ${run.title}${run.node ? ` (node ${run.node})` : ""}`, [id], {
          environment: run.environment,
        });
        return run;
      }, options)
    ).value;
  }

  async logRun(
    id: string,
    entries: Array<{ kind: "note" | "progress" | "output" | "error" | "checkpoint"; text: string }>,
    options: MutateOptions = {},
  ): Promise<Run> {
    return (
      await this.mutate(`project: log run ${id}`, (project) => {
        const run = mustFind(project.runs, id, "run");
        for (const entry of entries) {
          run.entries.push({ at: this.clock.now(), kind: entry.kind, text: cleanProse(entry.text) });
        }
        run.updated = this.clock.now();
        if (run.status === "STARTED") run.status = "RUNNING";
        return run;
      }, options)
    ).value;
  }

  async finishRun(
    id: string,
    result: {
      status: RunStatus;
      exitCode?: number | null;
      outputs?: Evidence[];
      notes?: string;
      nodeStatus?: NodeStatus;
    },
    options: MutateOptions = {},
  ): Promise<{ run: Run; node: PlanNode | null }> {
    return (
      await this.mutate(`project: run ${id} -> ${result.status}`, (project) => {
        const run = mustFind(project.runs, id, "run");
        run.status = result.status;
        run.exitCode = result.exitCode ?? run.exitCode;
        run.finished = this.clock.now();
        run.updated = this.clock.now();
        if (result.notes) run.entries.push({ at: this.clock.now(), kind: "note", text: cleanProse(result.notes) });
        if (result.outputs) run.outputs.push(...result.outputs);

        let node: PlanNode | null = null;
        if (run.node) {
          const found = findNodeAnywhere(project, run.node);
          if (found) {
            node = found.node;
            const target =
              result.nodeStatus ??
              (result.status === "COMPLETED"
                ? "COMPLETED"
                : result.status === "FAILED"
                  ? "FAILED"
                  : result.status === "INTERRUPTED"
                    ? "INTERRUPTED"
                    : "ABANDONED");
            node.status = target;
            node.updated = this.clock.now();
            if (target === "COMPLETED" || target === "FAILED") node.finished = this.clock.now();
            if (target === "FAILED") node.failureReason = cleanProse(result.notes) || `run ${id} failed`;
            if (result.outputs && result.outputs.length > 0) {
              node.outputs.push(...result.outputs.map((output) => output.description));
            }
          }
        }
        this.record("run.finished", `Run ${id} ${result.status}: ${run.title}`, [id, ...(run.node ? [run.node] : [])], {
          exitCode: run.exitCode,
        });
        return { run, node };
      }, options)
    ).value;
  }

  /** Update a run record without finishing it (pid, log path, environment, status). */
  async updateRun(id: string, patch: Partial<RunInput> & { exitCode?: number | null; outputs?: Evidence[] }, options: MutateOptions = {}): Promise<Run> {
    return (
      await this.mutate(`project: update run ${id}`, (project) => {
        const run = mustFind(project.runs, id, "run");
        if (patch.title !== undefined) run.title = cleanProse(patch.title);
        if (patch.node !== undefined) run.node = patch.node;
        if (patch.status !== undefined) run.status = patch.status;
        if (patch.environment !== undefined) run.environment = patch.environment;
        if (patch.command !== undefined) run.command = patch.command;
        if (patch.cwd !== undefined) run.cwd = patch.cwd;
        if (patch.pid !== undefined) run.pid = patch.pid;
        if (patch.host !== undefined) run.host = patch.host;
        if (patch.session !== undefined) run.session = patch.session;
        if (patch.log !== undefined) run.log = patch.log;
        if (patch.exitCode !== undefined) run.exitCode = patch.exitCode;
        if (patch.outputs) run.outputs.push(...patch.outputs);
        run.updated = this.clock.now();
        return run;
      }, options)
    ).value;
  }

  /** Mark runs that claim to be running but whose process is gone. */
  async reconcileRuns(options: MutateOptions = {}): Promise<Run[]> {
    const { value } = await this.mutate(
      "project: reconcile runs",
      (project) => {
        const changed: Run[] = [];
        for (const run of project.runs) {
          if (run.status !== "STARTED" && run.status !== "RUNNING") continue;
          if (run.pid && isProcessAlive(run.pid)) continue;
          run.status = "INTERRUPTED";
          run.updated = this.clock.now();
          run.entries.push({
            at: this.clock.now(),
            kind: "note",
            text: "Marked INTERRUPTED: no live process found for this run.",
          });
          const found = run.node ? findNodeAnywhere(project, run.node) : null;
          if (found && found.node.status === "RUNNING") {
            found.node.status = "INTERRUPTED";
            found.node.updated = this.clock.now();
          }
          changed.push(run);
        }
        if (changed.length > 0) {
          this.record("run.finished", `Interrupted runs reconciled: ${changed.map((run) => run.id).join(", ")}`, changed.map((run) => run.id), { status: "INTERRUPTED" });
        }
        return changed;
      },
      options,
    );
    return value;
  }

  /* ---------------- deletions (human editing) ---------------- */

  async deleteGoal(id: string, options: MutateOptions = {}): Promise<void> {
    await this.mutate(`project: delete goal ${id}`, (project) => {
      mustFind(project.goals, id, "goal");
      project.goals = project.goals.filter((goal) => goal.id !== id);
      this.unlink(project, id);
      this.record("goal.updated", `Goal ${id} deleted (and links removed)`, [id]);
    }, options);
  }

  async deleteQuestion(id: string, options: MutateOptions = {}): Promise<void> {
    await this.mutate(`project: delete question ${id}`, (project) => {
      mustFind(project.questions, id, "question");
      project.questions = project.questions.filter((question) => question.id !== id);
      this.unlink(project, id);
      this.record("question.updated", `Question ${id} deleted (and links removed)`, [id]);
    }, options);
  }

  async deleteRisk(id: string, options: MutateOptions = {}): Promise<void> {
    await this.mutate(`project: delete risk ${id}`, (project) => {
      mustFind(project.risks, id, "risk");
      project.risks = project.risks.filter((risk) => risk.id !== id);
      this.unlink(project, id);
      this.record("risk.updated", `Risk ${id} deleted (and links removed)`, [id]);
    }, options);
  }

  /** Remove every reference to a deleted entity so validation stays clean. */
  private unlink(project: Project, id: string): void {
    const strip = (values: string[]): string[] => values.filter((value) => value !== id);
    for (const goal of project.goals) {
      if (goal.parent === id) goal.parent = null;
      if (goal.supersededBy === id) goal.supersededBy = null;
      goal.questions = strip(goal.questions);
      goal.risks = strip(goal.risks);
      goal.tasks = strip(goal.tasks);
    }
    for (const question of project.questions) {
      question.goals = strip(question.goals);
      question.risks = strip(question.risks);
      question.tasks = strip(question.tasks);
      question.decisions = strip(question.decisions);
    }
    for (const risk of project.risks) {
      risk.goals = strip(risk.goals);
      risk.questions = strip(risk.questions);
      risk.tasks = strip(risk.tasks);
    }
    for (const plan of project.plans.plans) {
      if (plan.supersededBy === id) plan.supersededBy = null;
      for (const node of plan.nodes) {
        if (node.goal === id) node.goal = null;
        if (node.question === id) node.question = null;
        if (node.risk === id) node.risk = null;
      }
    }
  }

  /* ---------------- bulk section edits (human editing) ---------------- */

  /**
   * Replace the whole goal list. Used by the human edit path (`e` in the TUI or
   * `/project edit`); it goes through the same validation, history and Git path
   * as agent-driven changes.
   */
  async replaceGoals(goals: Goal[], options: MutateOptions = {}): Promise<Goal[]> {
    return (
      await this.mutate(`project: edit goals (${goals.length})`, (project) => {
        const preexisting = new Set(validateProjectDetailed(project).errors);
        const before = new Set(project.goals.map((goal) => goal.id));
        const after = new Set(goals.map((goal) => goal.id));
        project.goals = goals.map((goal) => ({ ...goal, updated: goal.updated || this.clock.now() }));
        assertNoNewErrors(project, preexisting, "goals");
        const added = goals.filter((goal) => !before.has(goal.id)).length;
        const removed = [...before].filter((id) => !after.has(id)).length;
        this.record("goal.updated", `Goals edited by hand: ${goals.length} total (+${added}/-${removed})`, [
          ...after,
        ]);
        return project.goals;
      }, options)
    ).value;
  }

  async replaceQuestions(questions: Question[], options: MutateOptions = {}): Promise<Question[]> {
    return (
      await this.mutate(`project: edit intelligence (${questions.length})`, (project) => {
        const preexisting = new Set(validateProjectDetailed(project).errors);
        const before = new Set(project.questions.map((question) => question.id));
        project.questions = questions.map((question) => ({ ...question, updated: question.updated || this.clock.now() }));
        assertNoNewErrors(project, preexisting, "intelligence");
        const added = questions.filter((question) => !before.has(question.id)).length;
        this.record(
          "question.updated",
          `Intelligence edited by hand: ${questions.length} question(s) (+${added})`,
          questions.map((question) => question.id),
        );
        return project.questions;
      }, options)
    ).value;
  }

  async replaceRisks(risks: Risk[], options: MutateOptions = {}): Promise<Risk[]> {
    return (
      await this.mutate(`project: edit risks (${risks.length})`, (project) => {
        const preexisting = new Set(validateProjectDetailed(project).errors);
        const before = new Set(project.risks.map((risk) => risk.id));
        project.risks = risks.map((risk) => ({ ...risk, updated: risk.updated || this.clock.now() }));
        assertNoNewErrors(project, preexisting, "risks");
        const added = risks.filter((risk) => !before.has(risk.id)).length;
        this.record(
          "risk.updated",
          `Risks edited by hand: ${risks.length} total (+${added})`,
          risks.map((risk) => risk.id),
        );
        return project.risks;
      }, options)
    ).value;
  }

  async replacePlans(plans: PlansFile, options: MutateOptions = {}): Promise<PlansFile> {
    return (
      await this.mutate("project: edit plan", (project) => {
        const preexisting = new Set(validateProjectDetailed(project).errors);
        project.plans = plans;
        const active = plans.active && plans.plans.some((plan) => plan.id === plans.active)
          ? plans.active
          : plans.plans[plans.plans.length - 1]?.id ?? null;
        project.plans.active = active;
        project.meta.activePlan = active;
        assertNoNewErrors(project, preexisting, "plan");
        this.record("plan.changed", `Plan edited by hand (${plans.plans.length} version(s), active ${active ?? "none"})`, active ? [active] : []);
        return project.plans;
      }, options)
    ).value;
  }

  /* ---------------- completion ---------------- */

  async completeProject(options: MutateOptions & { approved?: boolean; approvedBy?: string } = {}): Promise<StrategicOutcome<Project>> {
    const gate = await this.authorize("STRATEGIC", "mark the project complete", "project completion");
    if (!gate.allowed && !options.approved) {
      return { status: "requires-approval", message: gate.message, level: gate.level };
    }
    const autoAccepted = !options.approved && gate.autoAccepted;
    const { value } = await this.mutate("project: mark complete", (project) => {
      project.meta.completed = true;
      project.meta.completedAt = this.clock.now();
      this.record("project.completed", `Project completed: ${project.meta.name}`, []);
      return project;
    }, options);
    return { status: "applied", value, autoAccepted, note: autoAccepted ? "Pi automatically accepted completion." : "" };
  }

  /**
   * Park the project deliberately. Reversible, unlike completion: the plan, the
   * goals and every open question stay exactly as they are, so resuming is one
   * call. `note` records what to do first, which is what makes resuming cheap.
   */
  async pauseProject(note?: string, options: MutateOptions = {}): Promise<Project> {
    return (
      await this.mutate("project: pause", (project) => {
        const wasPaused = project.meta.paused;
        project.meta.paused = true;
        project.meta.pausedAt = this.clock.now();
        if (note !== undefined && cleanProse(note) !== "") project.meta.resumeNote = cleanProse(note);
        if (!wasPaused) {
          // Default the note from the DAG so resuming is one step even when the
          // human only typed /project pause. An explicit note always wins.
          if (!project.meta.resumeNote) {
            const plan = activePlan(project);
            const next = plan ? readyNodes(plan.nodes)[0] : undefined;
            project.meta.resumeNote = next ? `${next.id} ${next.title}` : null;
          }
          const hint = project.meta.resumeNote ?? "no ready work";
          this.record("project.paused", `Project paused — resume with: ${hint}`, []);
        }
        return project;
      }, options)
    ).value;
  }

  /** Resume work. Clears the pause but keeps the resume note for the record. */
  async resumeProject(options: MutateOptions = {}): Promise<Project> {
    return (
      await this.mutate("project: resume", (project) => {
        const wasPaused = project.meta.paused;
        project.meta.paused = false;
        project.meta.pausedAt = null;
        if (wasPaused) this.record("project.resumed", `Project resumed: ${project.meta.name}`, []);
        return project;
      }, options)
    ).value;
  }

  /**
   * Set or clear the project's current objective.
   *
   * An objective is not a goal and not a plan: goals are the durable end states
   * and the plan is how we get there, while the objective is the single sentence
   * this stretch of work is pursuing. It is recorded like a decision, because
   * changing what the project is for should be visible in the history.
   */
  async setObjective(objective: string | null, options: MutateOptions & { reason?: string } = {}): Promise<Project> {
    const cleaned = objective === null ? "" : cleanProse(objective);
    return (
      await this.mutate(cleaned === "" ? "project: clear objective" : "project: set objective", (project) => {
        const previous = project.meta.objective ?? null;
        const next = cleaned === "" ? null : cleaned;
        if (previous === next && !options.reason) return project;
        project.meta.objective = next;
        project.meta.objectiveSetAt = next === null ? null : this.clock.now();
        const summary =
          next === null
            ? `Objective cleared${previous ? ` (was: ${previous})` : ""}`
            : previous
              ? `Objective changed to: ${next} (was: ${previous})`
              : `Objective set: ${next}`;
        this.record("objective.changed", options.reason ? `${summary} — ${cleanProse(options.reason)}` : summary, [], { reason: options.reason });
        return project;
      }, options)
    ).value;
  }

  async setYolo(enabled: boolean, options: MutateOptions = {}): Promise<Project> {
    return (
      await this.mutate(`project: yolo ${enabled ? "on" : "off"}`, (project) => {
        project.meta.yolo = enabled;
        this.record(
          "decision.made",
          `YOLO mode ${enabled ? "enabled" : "disabled"}`,
          [],
          { autoAccepted: false },
        );
        return project;
      }, options)
    ).value;
  }

  /**
   * Rename the project. Only `meta.name` (the human label) and the derived slug
   * change: entity ids (G1, N3) are separate counters and filesystem paths stay
   * put, so nothing that references the project breaks (Q2).
   */
  async renameProject(name: string, options: MutateOptions = {}): Promise<Project> {
    const trimmed = name.trim();
    if (trimmed === "") throw new Error("A project name cannot be empty.");
    return (
      await this.mutate(`project: rename to "${trimmed}"`, (project) => {
        const previous = project.meta.name;
        if (previous === trimmed) return project;
        project.meta.name = cleanProse(trimmed);
        project.meta.id = slugify(trimmed) || project.meta.id;
        this.record("project.renamed", `Renamed "${previous}" to "${project.meta.name}"`, []);
        return project;
      }, options)
    ).value;
  }

  async setWorkspace(workspace: string | null, options: MutateOptions = {}): Promise<Project> {
    return (
      await this.mutate("project: set workspace", (project) => {
        project.meta.workspace = workspace;
        return project;
      }, options)
    ).value;
  }

  async setResources(resources: ExternalRef[], options: MutateOptions = {}): Promise<Project> {
    return (
      await this.mutate("project: set resources", (project) => {
        project.meta.resources = resources;
        this.record("state.changed", `Project resources updated (${resources.length})`, []);
        return project;
      }, options)
    ).value;
  }

  async setRepositories(repositories: string[], options: MutateOptions = {}): Promise<Project> {
    return (
      await this.mutate("project: set repositories", (project) => {
        project.meta.repositories = repositories.map((repository) => repository.trim()).filter(Boolean);
        this.record("state.changed", `Project repositories updated (${project.meta.repositories.length})`, []);
        return project;
      }, options)
    ).value;
  }

  issues(): string[] {
    return validateProject(this.project);
  }

  /** Path to the project directory; used by the widgets and tools. */
  projectDir(): string {
    return projectMarkerPath(this.root).replace(/\/project\.yaml$/, "");
  }

  /** Read the current yolo flag through the lock and evaluate authorization. */
  private async authorize(level: AuthorityLevel, action: string, reason: string): Promise<AuthorizationResult> {
    const yolo = await this.read((project) => project.meta.yolo);
    return checkAuthorization({ meta: { yolo } }, level, action, reason);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function findRoot(cwd: string): string | null {
  return findProjectRoot(cwd);
}

function mustFind<T extends { id: string }>(items: T[], id: string, kind: string): T {
  const found = items.find((item) => item.id === id);
  if (!found) throw new Error(`${kind} ${id} not found`);
  return found;
}

function locateNode(project: Project, id: string): { plan: Plan; node: PlanNode } {
  // Prefer the active plan: ids are only unique *within* a plan version, and
  // `applyReplan` reuses gap ids, so historical plans routinely share ids with
  // the current one. Searching oldest-first silently edited a superseded plan.
  const ordered = [
    ...project.plans.plans.filter((plan) => plan.id === project.plans.active),
    ...project.plans.plans.filter((plan) => plan.id !== project.plans.active),
  ];
  for (const plan of ordered) {
    const node = plan.nodes.find((item) => item.id === id);
    if (node) return { plan, node };
  }
  throw new Error(`node ${id} not found`);
}

function findNodeAnywhere(project: Project, id: string): { plan: Plan; node: PlanNode } | null {
  for (const plan of project.plans.plans) {
    const node = plan.nodes.find((item) => item.id === id);
    if (node) return { plan, node };
  }
  return null;
}

function uncertaintyForStatus(status: AnswerStatus, current: number): number {
  switch (status) {
    case "UNKNOWN":
      return Math.max(current, 0.8);
    case "PARTIAL":
      return Math.min(Math.max(current, 0.4), 0.7);
    case "ANSWERED":
      return Math.min(current, 0.3);
    case "CONFIRMED":
    case "INVALIDATED":
      return 0;
    default:
      return current;
  }
}

/** Reject an edit that introduces new structural errors (pre-existing ones are kept as-is). */
function assertNoNewErrors(project: Project, preexisting: ReadonlySet<string>, what: string): void {
  const introduced = validateProjectDetailed(project).errors.filter((issue) => !preexisting.has(issue));
  if (introduced.length > 0) {
    throw new Error(`Edit rejected (${what}):\n- ${introduced.join("\n- ")}`);
  }
}

function truncate(text: string, max: number): string {
  const flat = cleanProse(text).replace(/\s+/g, " ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export { slugify };
