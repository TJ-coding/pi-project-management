/**
 * LLM-facing tools.
 *
 * Every project-management operation available to a human is also available to
 * an agent (spec 2.4, 14). Tools are thin: they resolve the project, call the
 * ProjectManager, and render compact text for the model. Strategic operations
 * (vision/intent/values changes, abandoning major goals, pivoting, project
 * completion) go through the authority model and are recorded either way.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { buildDigest, buildResumeReport, buildTargetedContext } from "./context.ts";
import { formatAwaySummary, planEvolution, renderCompletionSummary, summarizeSince } from "./history.ts";
import { nextId } from "./ids.ts";
import { renderReplanAnalysis, renderReviewReport } from "./reports.ts";
import {
  renderAwayText,
  renderDirectionText,
  renderGoalsText,
  renderHistoryText,
  renderIntelligenceText,
  renderPlanEvolutionText,
  renderPlanText,
  renderRisksText,
  renderRunsText,
  renderStateText,
  renderStatusText,
  renderStrategyText,
} from "./format.ts";
import { ProjectManager, type StrategicOutcome } from "./project.ts";
import { isRunning, spawnDetached, stopProcess, tailLog } from "./runs.ts";
import { PROJECT_DIR } from "./storage.ts";
import { validateProject } from "./validate.ts";
import type {
  AnswerStatus,
  AuthorityLevel,
  GateOutcome,
  GateType,
  GoalStatus,
  NodeStatus,
  NodeType,
  Project,
  RiskStatus,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const NODE_TYPE_VALUES = ["TASK", "INVESTIGATION", "EXPERIMENT", "DECISION", "REVIEW", "GATE", "WAIT"] as const;
const NODE_STATUS_VALUES = [
  "PENDING",
  "RUNNING",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "ABANDONED",
  "SUPERSEDED",
] as const;
const QUESTION_STATUS_VALUES = ["UNKNOWN", "PARTIAL", "ANSWERED", "CONFIRMED", "INVALIDATED"] as const;
const RISK_STATUS_VALUES = ["OPEN", "MITIGATING", "RESOLVED", "ACCEPTED", "OCCURRED", "CLOSED"] as const;
const GOAL_STATUS_VALUES = ["ACTIVE", "COMPLETED", "FAILED", "ABANDONED", "SUPERSEDED"] as const;
const GATE_TYPE_VALUES = [
  "VALIDATION",
  "TEST",
  "EVALUATION",
  "REVIEW",
  "APPROVAL",
  "STRATEGIC_REVIEW",
  "RISK_REVIEW",
] as const;
const GATE_OUTCOME_VALUES = ["PASS", "FAIL", "REPLAN", "ESCALATE"] as const;
const AUTHORITY_VALUES = ["ROUTINE", "SIGNIFICANT", "STRATEGIC"] as const;
const ENVIRONMENT_VALUES = ["local", "ssh", "docker", "gpu", "cloud", "api", "other"] as const;

const EvidenceSchema = Type.Array(
  Type.Object({
    description: Type.String({ description: "What the evidence is" }),
    kind: Type.Optional(Type.String({ description: "run, experiment, link, measurement, doc, ..." })),
    ref: Type.Optional(Type.String({ description: "URL, file path, commit, identifier" })),
    run: Type.Optional(Type.String({ description: "Run id (RUN1) this evidence came from" })),
  }),
);

const EnvironmentSchema = Type.Array(
  Type.Object({
    kind: StringEnum(ENVIRONMENT_VALUES),
    target: Type.String({ description: "host, container, service or API name" }),
    note: Type.Optional(Type.String()),
  }),
);

export function ok(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

async function managerFor(ctx: ExtensionContext): Promise<ProjectManager | null> {
  return ProjectManager.discover(ctx.cwd, { by: "agent" });
}

const NO_PROJECT =
  `No project found. There is no ${PROJECT_DIR}/ directory in this directory or any parent.\n` +
  `Use the project_init tool (or /project init) to create one.`;

async function requireManager(ctx: ExtensionContext): Promise<ProjectManager> {
  const manager = await managerFor(ctx);
  if (!manager) throw new Error(NO_PROJECT);
  return manager;
}

/** Run a strategic action, asking the human for approval when a UI exists. */
async function withApproval<T>(
  ctx: ExtensionContext,
  run: (approved: boolean, approvedBy: string | undefined) => Promise<StrategicOutcome<T>>,
  prompt: string,
): Promise<StrategicOutcome<T>> {
  let outcome = await run(false, undefined);
  if (outcome.status === "requires-approval" && ctx.hasUI) {
    const confirmed = await ctx.ui.confirm("Strategic change requires approval", prompt);
    if (confirmed) outcome = await run(true, "human");
  }
  return outcome;
}

function outcomeText<T>(
  outcome: StrategicOutcome<T>,
  render: (value: T) => string,
): string {
  if (outcome.status === "requires-approval") {
    return outcome.message;
  }
  const lines: string[] = [];
  if (outcome.autoAccepted || outcome.note) lines.push(outcome.note || "Pi automatically accepted the change.");
  lines.push(render(outcome.value));
  return lines.join("\n");
}

function renderGoals(project: Project): string {
  return renderGoalsText(project);
}

/* ------------------------------------------------------------------ */
/* Registration                                                       */
/* ------------------------------------------------------------------ */

export function registerProjectTools(pi: ExtensionAPI): void {
  /* ---------------- init ---------------- */

  pi.registerTool({
    name: "project_init",
    label: "Project: initialize",
    description:
      `Initialize a ${PROJECT_DIR}/ project in the current directory. Fails if a project already exists. ` +
      "Creates direction, state, goals, intelligence, risks, strategy, plan, history and runs storage.",
    promptSnippet: "Initialize a persistent project in the current directory",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Project name (defaults to the directory name)" })),
      vision: Type.Optional(Type.String()),
      intent: Type.Optional(Type.String()),
      values: Type.Optional(Type.Array(Type.String())),
      concepts: Type.Optional(Type.Array(Type.Object({ type: Type.String(), text: Type.String() }))),
      workspace: Type.Optional(Type.String({ description: "Optional workspace grouping name" })),
      yolo: Type.Optional(Type.Boolean({ description: "Start in YOLO (auto-accept) mode" })),
      repositories: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const existing = await ProjectManager.discover(ctx.cwd, { by: "agent" });
      if (existing) {
        return ok(`A project already exists at ${existing.root}. Use project_status to inspect it.`);
      }
      const manager = await ProjectManager.init(ctx.cwd, {
        name: params.name,
        vision: params.vision,
        intent: params.intent,
        values: params.values,
        concepts: params.concepts,
        workspace: params.workspace,
        yolo: params.yolo,
        repos: params.repositories,
        by: "agent",
      });
      return ok(
        `Initialized project "${manager.project.meta.name}" at ${manager.root}/${PROJECT_DIR}.\n` +
          "Next: set direction (project_direction), record state (project_state), create goals (project_goal), then replan (project_replan).",
        { root: manager.root, name: manager.project.meta.name },
      );
    },
  });

  /* ---------------- status / reads ---------------- */

  pi.registerTool({
    name: "project_status",
    label: "Project: status",
    description:
      "Read the persistent project. Answers the four core questions (where are we / where are we going / what do we believe / " +
      "what are we doing) and renders any section: overview, direction, goals, state, intelligence, risks, strategy, plan, " +
      "history, runs, evolution, summary, validation, digest.",
    promptSnippet: "Read project direction, goals, state, intelligence, risks, strategy, plan, history or runs",
    promptGuidelines: [
      "Use project_status before starting work to orient yourself, instead of reading .project files directly.",
    ],
    parameters: Type.Object({
      section: Type.Optional(
        StringEnum([
          "overview",
          "direction",
          "goals",
          "state",
          "intelligence",
          "risks",
          "strategy",
          "plan",
          "history",
          "runs",
          "evolution",
          "summary",
          "validation",
          "digest",
        ] as const),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      status: Type.Optional(StringEnum(GOAL_STATUS_VALUES)),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      return ok(
        await manager.read((project) => {
          const section = params.section ?? "overview";
          switch (section) {
            case "direction":
              return renderDirectionText(project);
            case "goals":
              return renderGoalsText(project, params.status ? [params.status] : undefined);
            case "state":
              return renderStateText(project);
            case "intelligence":
              return renderIntelligenceText(project, params.limit ?? 50);
            case "risks":
              return renderRisksText(project, params.limit ?? 50);
            case "strategy":
              return renderStrategyText(project);
            case "plan":
              return renderPlanText(project);
            case "history":
              return renderHistoryText(project, params.limit ?? 100);
            case "runs":
              return renderRunsText(project, params.limit ?? 30);
            case "evolution":
              return renderPlanEvolutionText(project);
            case "summary":
              return renderCompletionSummary(project);
            case "validation": {
              const issues = validateProject(project);
              return issues.length === 0 ? "Validation: no issues." : `Validation issues:\n${issues.map((i) => `- ${i}`).join("\n")}`;
            }
            case "digest":
              return buildDigest(project);
            default:
              return renderStatusText(project);
          }
        }),
        { section: params.section ?? "overview" },
      );
    },
  });

  pi.registerTool({
    name: "project_context",
    label: "Project: context",
    description:
      "Get targeted project context for a specific piece of work: relevant direction, goals, state, risks, intelligence, " +
      "strategy and plan/DAG context. Prefer this over dumping the whole project (spec 24).",
    promptSnippet: "Get targeted project context for a node, goal, question, risk or search query",
    promptGuidelines: [
      "Use project_context to load the relevant project context before executing a DAG node, rather than reading every project file.",
    ],
    parameters: Type.Object({
      node: Type.Optional(Type.String({ description: "Plan node id, e.g. N3" })),
      goal: Type.Optional(Type.String({ description: "Goal id, e.g. G1" })),
      question: Type.Optional(Type.String({ description: "Question id, e.g. Q2" })),
      risk: Type.Optional(Type.String({ description: "Risk id, e.g. R1" })),
      query: Type.Optional(Type.String({ description: "Free-text topic to match against goals/questions/risks/nodes" })),
      history: Type.Optional(Type.Boolean({ description: "Include recent history entries" })),
      maxChars: Type.Optional(Type.Integer({ minimum: 500, maximum: 40000 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      return ok(
        await manager.read((project) =>
          buildTargetedContext(project, {
            node: params.node,
            goal: params.goal,
            question: params.question,
            risk: params.risk,
            query: params.query,
            history: params.history,
            maxChars: params.maxChars,
          }),
        ),
      );
    },
  });

  /* ---------------- direction ---------------- */

  pi.registerTool({
    name: "project_direction",
    label: "Project: direction",
    description:
      "Get or update project direction: vision, intent, values and concepts. Changing vision/intent/values is STRATEGIC and " +
      "requires human approval unless the project is in YOLO mode; concepts are routine.",
    promptSnippet: "Read or update project vision, intent, values and concepts",
    parameters: Type.Object({
      action: StringEnum(["get", "set"] as const),
      vision: Type.Optional(Type.String()),
      intent: Type.Optional(Type.String()),
      values: Type.Optional(Type.Array(Type.String())),
      concepts: Type.Optional(Type.Array(Type.Object({ type: Type.String(), text: Type.String() }))),
      reason: Type.Optional(Type.String({ description: "Why direction is changing (recorded in history)" })),
      approved: Type.Optional(Type.Boolean({ description: "Set true only after the human approved a strategic change" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      if (params.action === "get") {
        return ok(await manager.read((project) => renderDirectionText(project)));
      }
      const patch = {
        ...(params.vision !== undefined ? { vision: params.vision } : {}),
        ...(params.intent !== undefined ? { intent: params.intent } : {}),
        ...(params.values !== undefined ? { values: params.values } : {}),
        ...(params.concepts !== undefined ? { concepts: params.concepts } : {}),
      };
      const prompt = `Change project direction (${params.reason ?? "no reason given"}).`;
      const outcome = await withApproval(
        ctx,
        (approved, approvedBy) =>
          manager.updateDirection(patch, {
            approved: approved || params.approved === true,
            approvedBy,
            reason: params.reason,
          }),
        prompt,
      );
      return ok(outcomeText(outcome, (direction) => renderDirectionText({ ...manager.project, direction })));
    },
  });

  /* ---------------- goals ---------------- */

  pi.registerTool({
    name: "project_goal",
    label: "Project: goals",
    description:
      "Create, update, list and close goals. Goals have description, priority (1-5), success criteria, status, parent goal and " +
      "links to questions/risks/tasks. ABANDONED and SUPERSEDED are strategic and need approval outside YOLO.",
    promptSnippet: "Create, list, update or close project goals",
    parameters: Type.Object({
      action: StringEnum(["list", "create", "update", "status"] as const),
      id: Type.Optional(Type.String({ description: "Goal id, e.g. G2" })),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      priority: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
      percent: Type.Optional(
        Type.Number({
          description:
            "How far along this goal is, 0-100. Set only when you can genuinely estimate it; omitting it means no estimate. Out-of-range values are refused.",
          minimum: 0,
          maximum: 100,
        }),
      ),
      successCriteria: Type.Optional(Type.Array(Type.String())),
      status: Type.Optional(StringEnum(GOAL_STATUS_VALUES)),
      parent: Type.Optional(Type.String()),
      questions: Type.Optional(Type.Array(Type.String())),
      risks: Type.Optional(Type.Array(Type.String())),
      tasks: Type.Optional(Type.Array(Type.String())),
      supersededBy: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
      approved: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      switch (params.action) {
        case "list":
          return ok(await manager.read((project) => renderGoalsText(project, params.status ? [params.status] : undefined)));
        case "create": {
          if (!params.title) throw new Error("title is required to create a goal");
          const goal = await manager.createGoal({
            title: params.title,
            description: params.description,
            priority: params.priority,
            successCriteria: params.successCriteria,
            parent: params.parent ?? null,
            questions: params.questions,
            risks: params.risks,
            tasks: params.tasks,
            status: params.status,
            percent: params.percent,
          });
          return ok(`Created goal ${goal.id}: ${goal.title}`, { goal });
        }
        case "update": {
          if (!params.id) throw new Error("id is required to update a goal");
          const goal = await manager.updateGoal(params.id, {
            title: params.title,
            description: params.description,
            priority: params.priority,
            successCriteria: params.successCriteria,
            parent: params.parent,
            questions: params.questions,
            risks: params.risks,
            tasks: params.tasks,
            percent: params.percent,
            supersededBy: params.supersededBy,
          });
          if (params.status && params.status !== goal.status) {
            const outcome = await withApproval(
              ctx,
              (approved, approvedBy) =>
                manager.setGoalStatus(params.id!, params.status as GoalStatus, {
                  approved: approved || params.approved === true,
                  approvedBy,
                  reason: params.reason,
                }),
              `Mark goal ${params.id} as ${params.status}${params.reason ? ` (${params.reason})` : ""}.`,
            );
            return ok(outcomeText(outcome, (updated) => `Goal ${updated.id} is now ${updated.status}: ${updated.title}`));
          }
          return ok(`Updated goal ${goal.id}: ${goal.title}`, { goal });
        }
        case "status": {
          if (!params.id || !params.status) throw new Error("id and status are required");
          const outcome = await withApproval(
            ctx,
            (approved, approvedBy) =>
              manager.setGoalStatus(params.id!, params.status as GoalStatus, {
                approved: approved || params.approved === true,
                approvedBy,
                reason: params.reason,
              }),
            `Mark goal ${params.id} as ${params.status}${params.reason ? ` (${params.reason})` : ""}.`,
          );
          return ok(outcomeText(outcome, (goal) => `Goal ${goal.id} is now ${goal.status}: ${goal.title}`));
        }
      }
    },
  });

  /* ---------------- state ---------------- */

  pi.registerTool({
    name: "project_state",
    label: "Project: state",
    description:
      "Read or update current project state: initial state, current state, capabilities, known facts, active problems, " +
      "constraints and discoveries. Use append to add list items without replacing the list.",
    promptSnippet: "Read or update the lightweight current-state summary",
    parameters: Type.Object({
      action: StringEnum(["get", "set", "append"] as const),
      initial: Type.Optional(Type.String()),
      current: Type.Optional(Type.String()),
      capabilities: Type.Optional(Type.Array(Type.String())),
      facts: Type.Optional(Type.Array(Type.String())),
      problems: Type.Optional(Type.Array(Type.String())),
      constraints: Type.Optional(Type.Array(Type.String())),
      discoveries: Type.Optional(Type.Array(Type.String())),
      summary: Type.Optional(Type.String({ description: "Short description of the change (recorded in history)" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      if (params.action === "get") {
        return ok(await manager.read((project) => renderStateText(project)));
      }
      const patch =
        params.action === "append"
          ? {
              append: {
                capabilities: params.capabilities,
                facts: params.facts,
                problems: params.problems,
                constraints: params.constraints,
                discoveries: params.discoveries,
              },
            }
          : {
              initial: params.initial,
              current: params.current,
              capabilities: params.capabilities,
              facts: params.facts,
              problems: params.problems,
              constraints: params.constraints,
              discoveries: params.discoveries,
            };
      const state = await manager.updateState(patch, { summary: params.summary });
      return ok(renderStateText({ ...manager.project, state }));
    },
  });

  /* ---------------- intelligence ---------------- */

  pi.registerTool({
    name: "project_question",
    label: "Project: intelligence",
    description:
      "Maintain the project's intelligence base. Questions have answer, status (UNKNOWN/PARTIAL/ANSWERED/CONFIRMED/INVALIDATED), " +
      "importance, uncertainty, decision impact, confidence and evidence, and can link to goals/risks/tasks. " +
      "Answering propagates to linked risk estimates by default.",
    promptSnippet: "Ask, answer and prioritize the questions the project depends on",
    promptGuidelines: [
      "Use project_question to record what the project does not know yet, and to answer questions with evidence.",
      "Prefer project_question over ad-hoc notes when investigation produces knowledge that changes decisions.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "add", "update", "answer"] as const),
      id: Type.Optional(Type.String()),
      question: Type.Optional(Type.String()),
      answer: Type.Optional(Type.String()),
      status: Type.Optional(StringEnum(QUESTION_STATUS_VALUES)),
      importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      uncertainty: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      decisionImpact: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      evidence: Type.Optional(EvidenceSchema),
      goals: Type.Optional(Type.Array(Type.String())),
      risks: Type.Optional(Type.Array(Type.String())),
      tasks: Type.Optional(Type.Array(Type.String())),
      propagate: Type.Optional(Type.Boolean({ description: "Update linked risks from the answer (default true)" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      switch (params.action) {
        case "list":
          return ok(await manager.read((project) => renderIntelligenceText(project, 100)));
        case "add": {
          if (!params.question) throw new Error("question is required");
          const created = await manager.createQuestion({
            question: params.question,
            answer: params.answer,
            status: params.status,
            importance: params.importance,
            uncertainty: params.uncertainty,
            decisionImpact: params.decisionImpact,
            confidence: params.confidence,
            evidence: params.evidence,
            goals: params.goals,
            risks: params.risks,
            tasks: params.tasks,
          });
          return ok(`Created ${created.id}: ${created.question}`, { question: created });
        }
        case "update": {
          if (!params.id) throw new Error("id is required");
          const updated = await manager.updateQuestion(params.id, {
            question: params.question,
            answer: params.answer,
            status: params.status,
            importance: params.importance,
            uncertainty: params.uncertainty,
            decisionImpact: params.decisionImpact,
            confidence: params.confidence,
            evidence: params.evidence,
            goals: params.goals,
            risks: params.risks,
            tasks: params.tasks,
          });
          return ok(`Updated ${updated.id}: ${updated.question}`, { question: updated });
        }
        case "answer": {
          if (!params.id || !params.answer || !params.status) {
            throw new Error("id, answer and status are required");
          }
          const answered = await manager.answerQuestion(params.id, {
            answer: params.answer,
            status: params.status as AnswerStatus,
            confidence: params.confidence,
            evidence: params.evidence,
          });
          let propagated = "";
          if (params.propagate !== false && answered.risks.length > 0) {
            const risks = await manager.propagateQuestionToRisks(answered.id);
            if (risks.length > 0) {
              propagated = `\nLinked risks updated: ${risks.map((risk) => `${risk.id} p=${risk.probability.toFixed(2)}`).join(", ")}`;
            }
          }
          return ok(`Answered ${answered.id} (${answered.status}): ${answered.answer}${propagated}`, {
            question: answered,
          });
        }
      }
    },
  });

  /* ---------------- risks ---------------- */

  pi.registerTool({
    name: "project_risk",
    label: "Project: risks",
    description:
      "Maintain the prioritized risk registry. Risks have probability, impact (exposure is computed as p x i), status, " +
      "mitigation, contingency and links to questions/goals/tasks. Update probabilities when new evidence appears.",
    promptSnippet: "Create, update and prioritize project risks",
    parameters: Type.Object({
      action: StringEnum(["list", "add", "update"] as const),
      id: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      probability: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      impact: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      status: Type.Optional(StringEnum(RISK_STATUS_VALUES)),
      mitigation: Type.Optional(Type.String()),
      contingency: Type.Optional(Type.String()),
      owner: Type.Optional(Type.String()),
      questions: Type.Optional(Type.Array(Type.String())),
      goals: Type.Optional(Type.Array(Type.String())),
      tasks: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      switch (params.action) {
        case "list":
          return ok(await manager.read((project) => renderRisksText(project, 100)));
        case "add": {
          if (!params.title) throw new Error("title is required");
          const risk = await manager.createRisk({
            title: params.title,
            description: params.description,
            probability: params.probability,
            impact: params.impact,
            status: params.status as RiskStatus | undefined,
            mitigation: params.mitigation,
            contingency: params.contingency,
            questions: params.questions,
            goals: params.goals,
            tasks: params.tasks,
            owner: params.owner,
          });
          return ok(
            `Created ${risk.id}: ${risk.title} (exposure ${(risk.probability * risk.impact).toFixed(2)})`,
            { risk },
          );
        }
        case "update": {
          if (!params.id) throw new Error("id is required");
          const risk = await manager.updateRisk(params.id, {
            title: params.title,
            description: params.description,
            probability: params.probability,
            impact: params.impact,
            status: params.status as RiskStatus | undefined,
            mitigation: params.mitigation,
            contingency: params.contingency,
            questions: params.questions,
            goals: params.goals,
            tasks: params.tasks,
            owner: params.owner,
          });
          return ok(
            `Updated ${risk.id}: ${risk.title} (exposure ${(risk.probability * risk.impact).toFixed(2)}, status ${risk.status})`,
            { risk },
          );
        }
      }
    },
  });

  /* ---------------- strategy ---------------- */

  pi.registerTool({
    name: "project_strategy",
    label: "Project: strategy",
    description:
      "Read or update strategy: current approach, strategic hypotheses, priorities, rationale and major alternatives considered. " +
      "Strategy is more mutable than direction; significant changes are recorded in history.",
    promptSnippet: "Read or update the current project strategy",
    parameters: Type.Object({
      action: StringEnum(["get", "set"] as const),
      approach: Type.Optional(Type.String()),
      hypotheses: Type.Optional(Type.Array(Type.String())),
      priorities: Type.Optional(Type.Array(Type.String())),
      rationale: Type.Optional(Type.String()),
      alternatives: Type.Optional(Type.Array(Type.String())),
      reason: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      if (params.action === "get") {
        return ok(await manager.read((project) => renderStrategyText(project)));
      }
      const strategy = await manager.setStrategy(
        {
          approach: params.approach,
          hypotheses: params.hypotheses,
          priorities: params.priorities,
          rationale: params.rationale,
          alternatives: params.alternatives,
        },
        { reason: params.reason },
      );
      return ok(renderStrategyText({ ...manager.project, strategy }));
    },
  });

  /* ---------------- plan / DAG ---------------- */

  pi.registerTool({
    name: "project_plan",
    label: "Project: plan / DAG",
    description:
      "Read and modify the executable DAG. Actions: get, add_node, update_node, remove_node, node_status, set_active. " +
      "Nodes have a type (TASK, INVESTIGATION, EXPERIMENT, DECISION, REVIEW, GATE, WAIT), status, dependencies, and links to " +
      "goals/questions/risks. Prefer project_replan for wholesale plan changes so the change is recorded.",
    promptSnippet: "Read and modify the executable plan DAG and node statuses",
    promptGuidelines: [
      "Use project_plan node_status to persist task execution state (RUNNING/BLOCKED/COMPLETED/FAILED/INTERRUPTED) so work survives session loss.",
    ],
    parameters: Type.Object({
      action: StringEnum(["get", "add_node", "update_node", "remove_node", "node_status", "set_active"] as const),
      id: Type.Optional(Type.String({ description: "Node id (N3) or plan id (P2) for set_active" })),
      title: Type.Optional(Type.String()),
      type: Type.Optional(StringEnum(NODE_TYPE_VALUES)),
      description: Type.Optional(Type.String()),
      dependsOn: Type.Optional(Type.Array(Type.String())),
      goal: Type.Optional(Type.String()),
      risk: Type.Optional(Type.String()),
      question: Type.Optional(Type.String()),
      assignee: Type.Optional(StringEnum(["agent", "human"] as const)),
      gateType: Type.Optional(StringEnum(GATE_TYPE_VALUES)),
      gateCriteria: Type.Optional(Type.String()),
      status: Type.Optional(StringEnum(NODE_STATUS_VALUES)),
      percent: Type.Optional(
        Type.Number({
          description:
            "How far along this node is, 0-100. Set only when you can genuinely estimate it; omitting it means no estimate. Out-of-range values are refused.",
          minimum: 0,
          maximum: 100,
        }),
      ),
      reason: Type.Optional(Type.String()),
      outputs: Type.Optional(Type.Array(Type.String())),
      run: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      switch (params.action) {
        case "get":
          return ok(await manager.read((project) => renderPlanText(project)));
        case "add_node": {
          if (!params.title) throw new Error("title is required");
          const node = await manager.addNode({
            title: params.title,
            type: params.type as NodeType | undefined,
            description: params.description,
            dependsOn: params.dependsOn,
            goal: params.goal ?? null,
            risk: params.risk ?? null,
            question: params.question ?? null,
            assignee: params.assignee,
            percent: params.percent,
            gate:
              params.gateType && params.gateCriteria
                ? { type: params.gateType as GateType, criteria: params.gateCriteria }
                : null,
          });
          return ok(`Added node ${node.id} [${node.type}] ${node.title}`, { node });
        }
        case "update_node": {
          if (!params.id) throw new Error("id is required");
          const node = await manager.updateNode(params.id, {
            title: params.title,
            type: params.type as NodeType | undefined,
            description: params.description,
            dependsOn: params.dependsOn,
            goal: params.goal,
            risk: params.risk,
            question: params.question,
            assignee: params.assignee,
            percent: params.percent,
            gate:
              params.gateType && params.gateCriteria
                ? { type: params.gateType as GateType, criteria: params.gateCriteria }
                : undefined,
          });
          return ok(`Updated node ${node.id}: ${node.title}`, { node });
        }
        case "remove_node": {
          if (!params.id) throw new Error("id is required");
          const result = await manager.removeNode(params.id);
          return ok(result.removed);
        }
        case "node_status": {
          if (!params.id || !params.status) throw new Error("id and status are required");
          const node = await manager.setNodeStatus(params.id, params.status as NodeStatus, {
            reason: params.reason,
            outputs: params.outputs,
            run: params.run,
          });
          return ok(`Node ${node.id} is now ${node.status}: ${node.title}`, { node });
        }
        case "set_active": {
          if (!params.id) throw new Error("id is required");
          const plan = await manager.setActivePlan(params.id);
          return ok(`Active plan is now ${plan.id} (v${plan.version})`, { plan: plan.id });
        }
      }
    },
  });

  /* ---------------- gates ---------------- */

  pi.registerTool({
    name: "project_gate",
    label: "Project: gates",
    description:
      "Define or evaluate a gate. Gates evaluate whether execution should continue and produce PASS, FAIL, REPLAN or ESCALATE. " +
      "A gate failure is not project failure; it usually triggers replanning. Strategic reviews check consistency with " +
      "vision/intent/values/concepts/goals.",
    promptSnippet: "Define or evaluate plan gates (PASS/FAIL/REPLAN/ESCALATE)",
    parameters: Type.Object({
      action: StringEnum(["evaluate", "define"] as const),
      node: Type.Optional(Type.String({ description: "Gate node id, e.g. N5" })),
      gateType: Type.Optional(StringEnum(GATE_TYPE_VALUES)),
      criteria: Type.Optional(Type.String()),
      outcome: Type.Optional(StringEnum(GATE_OUTCOME_VALUES)),
      notes: Type.Optional(Type.String()),
      evaluator: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      if (params.action === "define") {
        if (!params.node || !params.gateType || !params.criteria) {
          throw new Error("node, gateType and criteria are required");
        }
        const node = await manager.updateNode(params.node, {
          type: "GATE",
          gate: { type: params.gateType as GateType, criteria: params.criteria },
        });
        return ok(`Gate defined on ${node.id}: ${params.gateType} — ${params.criteria}`, { node });
      }
      if (!params.node || !params.outcome) throw new Error("node and outcome are required");
      const result = await manager.evaluateGate(
        params.node,
        params.outcome as GateOutcome,
        params.notes ?? "",
        params.evaluator ?? "agent",
      );
      const followUp =
        params.outcome === "PASS"
          ? "Execution may continue."
          : params.outcome === "FAIL"
            ? "Marked failed; consider replanning."
            : params.outcome === "REPLAN"
              ? "Run project_replan to produce the next plan."
              : "Escalated; request human input.";
      return ok(`Gate ${result.node.id} -> ${result.outcome}. ${followUp}`, { outcome: result.outcome });
    },
  });

  /* ---------------- decisions ---------------- */

  pi.registerTool({
    name: "project_decision",
    label: "Project: decisions",
    description:
      "Record a project decision with rationale, alternatives and evidence. Authority levels: ROUTINE, SIGNIFICANT (recorded), " +
      "STRATEGIC (normally requires human approval). Decisions are stored in decisions/ and in history.",
    promptSnippet: "Record a project decision with rationale and evidence",
    parameters: Type.Object({
      action: StringEnum(["list", "record"] as const),
      title: Type.Optional(Type.String()),
      decision: Type.Optional(Type.String()),
      rationale: Type.Optional(Type.String()),
      alternatives: Type.Optional(Type.Array(Type.String())),
      authority: Type.Optional(StringEnum(AUTHORITY_VALUES)),
      evidence: Type.Optional(EvidenceSchema),
      goals: Type.Optional(Type.Array(Type.String())),
      questions: Type.Optional(Type.Array(Type.String())),
      risks: Type.Optional(Type.Array(Type.String())),
      approved: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      if (params.action === "list") {
        return ok(
          await manager.read((project) =>
            project.decisions.length === 0
              ? "_No decisions recorded._"
              : project.decisions
                  .map(
                    (decision) =>
                      `- ${decision.id} [${decision.authority}${decision.autoAccepted ? ", auto-accepted" : ""}] ${decision.title}: ${decision.decision}`,
                  )
                  .join("\n"),
          ),
        );
      }
      if (!params.title || !params.decision) throw new Error("title and decision are required");
      const outcome = await withApproval(
        ctx,
        (approved, approvedBy) =>
          manager.recordDecision(
            {
              title: params.title!,
              decision: params.decision!,
              rationale: params.rationale,
              alternatives: params.alternatives,
              authority: (params.authority ?? "SIGNIFICANT") as AuthorityLevel,
              evidence: params.evidence,
              goals: params.goals,
              questions: params.questions,
              risks: params.risks,
            },
            { approved: approved || params.approved === true, approvedBy },
          ),
        `Record STRATEGIC decision "${params.title}": ${params.decision}`,
      );
      return ok(outcomeText(outcome, (decision) => `Recorded decision ${decision.id}: ${decision.title}`), {
        decision: outcome.status === "applied" ? outcome.value.id : null,
      });
    },
  });

  /* ---------------- history ---------------- */

  pi.registerTool({
    name: "project_history",
    label: "Project: history",
    description:
      "Read semantic project history: list recent events, plan evolution (how the plan changed and why), events since a " +
      "timestamp, or a 'what happened while I was away' summary.",
    promptSnippet: "Read semantic history, plan evolution and away summaries",
    parameters: Type.Object({
      action: StringEnum(["list", "evolution", "since", "away"] as const),
      since: Type.Optional(Type.String({ description: "ISO timestamp" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      return ok(
        await manager.read((project) => {
          switch (params.action) {
            case "evolution":
              return renderPlanEvolutionText(project);
            case "since":
              return renderAwayText(project, params.since ?? new Date(Date.now() - 86_400_000).toISOString());
            case "away": {
              const since = params.since ?? new Date(Date.now() - 86_400_000).toISOString();
              return formatAwaySummary(summarizeSince(project, since));
            }
            default:
              return renderHistoryText(project, params.limit ?? 100);
          }
        }),
      );
    },
  });

  /* ---------------- runs ---------------- */

  pi.registerTool({
    name: "project_run",
    label: "Project: runs",
    description:
      "Persist long-running execution. Start a run (optionally launching a detached local command whose output goes to " +
      "runs/<id>.log), log progress, inspect status and process liveness, or finish it. Runs survive Pi session loss. " +
      "This is not an orchestrator: reference external hosts instead of managing them.",
    promptSnippet: "Start, log, inspect and finish long-running runs",
    promptGuidelines: [
      "Use project_run when work outlives a single response or conversation, and project_plan node_status to persist task state.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "start", "log", "finish", "update", "tail", "reconcile", "stop"] as const),
      id: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      node: Type.Optional(Type.String()),
      command: Type.Optional(Type.String({ description: "Shell command to launch detached (start only)" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the command (defaults to project root)" })),
      environment: Type.Optional(EnvironmentSchema),
      host: Type.Optional(Type.String()),
      entries: Type.Optional(
        Type.Array(
          Type.Object({
            kind: StringEnum(["note", "progress", "output", "error", "checkpoint"] as const),
            text: Type.String(),
          }),
        ),
      ),
      status: Type.Optional(StringEnum(["STARTED", "RUNNING", "COMPLETED", "FAILED", "INTERRUPTED", "ABANDONED"] as const)),
      exitCode: Type.Optional(Type.Integer()),
      notes: Type.Optional(Type.String()),
      outputs: Type.Optional(EvidenceSchema),
      lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      switch (params.action) {
        case "list":
          return ok(await manager.read((project) => {
            if (project.runs.length === 0) return "_No runs recorded._";
            return project.runs
              .map(
                (run) =>
                  `- ${run.id} [${run.status}] ${run.title}${run.pid ? ` pid=${run.pid}${isRunning(run.pid) ? " (alive)" : " (dead)"}` : ""}${run.node ? ` node=${run.node}` : ""}`,
              )
              .join("\n");
          }));
        case "start": {
          if (!params.title) throw new Error("title is required");
          const command = params.command;
          let pid: number | null = null;
          let log: string | null = null;
          if (command) {
            const runDir = `${manager.root}/${PROJECT_DIR}/runs`;
            const nextRunId = await manager.read((project) => nextId("run", project.runs.map((run) => run.id)));
            const logFile = `${runDir}/${nextRunId}.log`;
            const spawnResult = spawnDetached(command, params.cwd ?? manager.root, logFile);
            pid = spawnResult.pid;
            log = spawnResult.logFile;
          }
          const run = await manager.startRun({
            title: params.title,
            node: params.node ?? null,
            environment: params.environment,
            command: command ?? null,
            cwd: params.cwd ?? manager.root,
            pid,
            host: params.host ?? null,
            session: ctx.sessionManager.getSessionFile(),
            log,
          });
          return ok(
            `Started run ${run.id}: ${run.title}${pid ? ` (pid ${pid}, log ${log})` : ""}\n` +
              "This run is persisted in .project/runs and survives Pi session loss.",
            { run },
          );
        }
        case "log": {
          if (!params.id) throw new Error("id is required");
          const entries = params.entries ?? (params.notes ? [{ kind: "note" as const, text: params.notes }] : []);
          if (entries.length === 0) throw new Error("entries or notes required");
          const run = await manager.logRun(params.id, entries);
          return ok(`Logged ${entries.length} entr${entries.length === 1 ? "y" : "ies"} on ${run.id} [${run.status}]`);
        }
        case "finish": {
          if (!params.id || !params.status) throw new Error("id and status are required");
          const result = await manager.finishRun(params.id, {
            status: params.status as "COMPLETED" | "FAILED" | "INTERRUPTED" | "ABANDONED",
            exitCode: params.exitCode ?? null,
            notes: params.notes,
            outputs: params.outputs,
          });
          return ok(
            `Run ${result.run.id} -> ${result.run.status}${result.node ? `; node ${result.node.id} -> ${result.node.status}` : ""}`,
            { run: result.run.id },
          );
        }
        case "update": {
          if (!params.id) throw new Error("id is required");
          const run = await manager.updateRun(params.id, {
            title: params.title,
            node: params.node,
            status: params.status,
            environment: params.environment,
            pid: undefined,
            host: params.host,
            exitCode: params.exitCode,
          });
          return ok(`Updated run ${run.id} [${run.status}]`);
        }
        case "tail": {
          if (!params.id) throw new Error("id is required");
          const run = await manager.read((project) => project.runs.find((item) => item.id === params.id));
          if (!run) throw new Error(`run ${params.id} not found`);
          if (!run.log) return ok(`Run ${run.id} has no log file.`);
          return ok(`Tail of ${run.log}:\n${tailLog(run.log, params.lines ?? 40)}`);
        }
        case "reconcile": {
          const changed = await manager.reconcileRuns();
          return ok(
            changed.length === 0
              ? "All runs are consistent with their processes."
              : `Marked interrupted: ${changed.map((run) => `${run.id} ${run.title}`).join(", ")}`,
          );
        }
        case "stop": {
          if (!params.id) throw new Error("id is required");
          const run = await manager.read((project) => project.runs.find((item) => item.id === params.id));
          if (!run) throw new Error(`run ${params.id} not found`);
          if (!run.pid) return ok(`Run ${run.id} has no local process to stop.`);
          const stopped = stopProcess(run.pid);
          if (!stopped) return ok(`Run ${run.id} process ${run.pid} is not running.`);
          await manager.finishRun(run.id, { status: "ABANDONED", notes: "Stopped by agent" });
          return ok(`Stopped run ${run.id} (pid ${run.pid}).`);
        }
      }
    },
  });

  /* ---------------- replan ---------------- */

  pi.registerTool({
    name: "project_replan",
    label: "Project: replan",
    description:
      "Adaptive replanning. `analyze` considers vision, intent, values, concepts, goals, state, top intelligence, top risks, " +
      "previous work, strategy, the current plan and new evidence, then proposes the smallest useful plan. `apply` records it as " +
      "a new plan version with the reason and evidence. Pivoting fundamentally is strategic and needs approval outside YOLO.",
    promptSnippet: "Replan the project: propose or apply the smallest useful plan from current knowledge",
    promptGuidelines: [
      "Use project_replan when evidence invalidates assumptions, a gate fails, or priorities change; never fabricate long-term plans.",
      "Call project_replan with action=analyze first, then action=apply once the proposal matches current knowledge.",
    ],
    parameters: Type.Object({
      action: StringEnum(["analyze", "apply"] as const),
      trigger: Type.Optional(Type.String({ description: "What triggered the replan (evidence, gate failure, goal change)" })),
      evidence: Type.Optional(Type.Array(Type.String())),
      title: Type.Optional(Type.String()),
      rationale: Type.Optional(Type.String({ description: "Override the generated rationale" })),
      strategy: Type.Optional(
        Type.Object({
          approach: Type.Optional(Type.String()),
          hypotheses: Type.Optional(Type.Array(Type.String())),
          priorities: Type.Optional(Type.Array(Type.String())),
          rationale: Type.Optional(Type.String()),
          alternatives: Type.Optional(Type.Array(Type.String())),
        }),
      ),
      pivot: Type.Optional(Type.Boolean({ description: "Mark this as a fundamental pivot (strategic)" })),
      approved: Type.Optional(Type.Boolean()),
      nodes: Type.Optional(
        Type.Array(
          Type.Object({
            ref: Type.Optional(Type.String()),
            title: Type.String(),
            type: StringEnum(NODE_TYPE_VALUES),
            description: Type.Optional(Type.String()),
            dependsOn: Type.Optional(Type.Array(Type.String())),
            goal: Type.Optional(Type.String()),
            risk: Type.Optional(Type.String()),
            question: Type.Optional(Type.String()),
          }),
        ),
      ),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      if (params.action === "analyze") {
        return ok(await manager.read((project) => renderReplanAnalysis(project, manager.analyzeReplan({
          trigger: params.trigger ?? "manual replan",
          evidence: params.evidence,
          title: params.title,
        }))));
      }

      const proposal = await manager.read(() => manager.analyzeReplan({
        trigger: params.trigger ?? "manual replan",
        evidence: params.evidence,
        title: params.title,
      }));
      if (params.rationale) proposal.rationale = params.rationale;
      if (params.strategy) proposal.strategy = params.strategy;
      if (params.nodes && params.nodes.length > 0) {
        proposal.nodes = params.nodes.map((node) => ({
          ref: node.ref,
          title: node.title,
          type: node.type as NodeType,
          description: node.description,
          dependsOn: node.dependsOn,
          goal: node.goal ?? null,
          risk: node.risk ?? null,
          question: node.question ?? null,
        }));
        proposal.notes = [`Agent supplied ${params.nodes.length} node(s) directly.`];
      }

      const outcome = await withApproval(
        ctx,
        (approved, approvedBy) =>
          manager.applyReplan(proposal, {
            approved: approved || params.approved === true,
            approvedBy,
            pivot: params.pivot ?? false,
          }),
        `Pivot the project plan: ${proposal.rationale}`,
      );
      return ok(
        outcomeText(
          outcome,
          (value) =>
            `Applied plan ${value.plan.id} (v${value.plan.version}) with ${value.plan.nodes.length} node(s).\n` +
            `${proposal.notes.map((note) => `- ${note}`).join("\n")}\n\n${renderPlanText({ ...manager.project, plans: { ...manager.project.plans, active: value.plan.id } })}`,
        ),
        { plan: outcome.status === "applied" ? outcome.value.plan.id : null },
      );
    },
  });

  /* ---------------- review ---------------- */

  pi.registerTool({
    name: "project_review",
    label: "Project: review",
    description:
      "Run a strategic review: check whether the current approach is still consistent with vision, intent, values, concepts and " +
      "goals; surface top unknowns and risks; report plan readiness and validation issues. Optionally record the review outcome.",
    promptSnippet: "Run a strategic review of direction, goals, risks and plan readiness",
    parameters: Type.Object({
      record: Type.Optional(Type.Boolean({ description: "Record the review as a gate result / decision" })),
      outcome: Type.Optional(StringEnum(GATE_OUTCOME_VALUES)),
      notes: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      const report = await manager.read((project) => renderReviewReport(project));
      if (params.record && params.outcome) {
        await manager.recordDecision(
          {
            title: `Strategic review ${params.outcome}`,
            decision: `Strategic review outcome: ${params.outcome}`,
            rationale: params.notes ?? report,
            authority: "SIGNIFICANT",
          },
          { commit: true },
        );
      }
      return ok(report);
    },
  });

  /* ---------------- completion ---------------- */

  pi.registerTool({
    name: "project_complete",
    label: "Project: complete",
    description:
      "Mark the project complete and render the final project summary (vision, final state, goal outcomes, major risks, " +
      "questions, decisions, plan evolution, lessons). Completion is determined through goals, not by finishing every task.",
    promptSnippet: "Mark the project complete and render the final summary",
    parameters: Type.Object({
      approved: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      const outcome = await withApproval(
        ctx,
        (approved, approvedBy) => manager.completeProject({ approved: approved || params.approved === true, approvedBy }),
        "Mark the project complete?",
      );
      return ok(
        outcomeText(outcome, (project) => renderCompletionSummary(project)),
        { completed: outcome.status === "applied" },
      );
    },
  });

  /* ---------------- resources ---------------- */

  pi.registerTool({
    name: "project_resource",
    label: "Project: scope and resources",
    description:
      "Read or update the project's scope: Git repositories, local directories, external machines/services/APIs and other " +
      "resources. The project is broader than a Git repository; references are recorded here rather than orchestrated.",
    promptSnippet: "Read or update project repositories and external resources",
    parameters: Type.Object({
      action: StringEnum(["get", "set_repositories", "set_resources"] as const),
      repositories: Type.Optional(
        Type.Array(Type.String({ description: "Repository URL, path or remote name" })),
      ),
      resources: Type.Optional(EnvironmentSchema),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      if (params.action === "set_repositories") {
        if (!params.repositories) throw new Error("repositories is required");
        await manager.setRepositories(params.repositories);
      }
      if (params.action === "set_resources") {
        if (!params.resources) throw new Error("resources is required");
        await manager.setResources(params.resources);
      }
      return ok(
        await manager.read((project) => {
          const lines = [`# Scope — ${project.meta.name}`, "", "## Repositories", ""];
          lines.push(
            ...(project.meta.repositories.length > 0
              ? project.meta.repositories.map((repository) => `- ${repository}`)
              : ["_none recorded_"]),
          );
          lines.push("", "## Resources", "");
          lines.push(
            ...(project.meta.resources.length > 0
              ? project.meta.resources.map(
                  (resource) => `- ${resource.kind}: ${resource.target}${resource.note ? ` (${resource.note})` : ""}`,
                )
              : ["_none recorded_"]),
          );
          lines.push("", `Local project directory: ${project.root}`);
          return lines.join("\n");
        }),
      );
    },
  });

  /* ---------------- rename ---------------- */

  pi.registerTool({
    name: "project_rename",
    label: "Project: rename",
    description:
      "Rename the project's human-facing label. Only meta.name and its slug change: entity ids (G1, N3) and " +
      "filesystem paths stay put, so nothing that references the project breaks.",
    promptSnippet: "Rename the project",
    parameters: Type.Object({
      name: Type.String({ description: "New project name" }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      const project = await manager.renameProject(params.name);
      return ok(`Project renamed to "${project.meta.name}" (id ${project.meta.id}).`);
    },
  });

  /* ---------------- pause / start ---------------- */

  pi.registerTool({
    name: "project_pause",
    label: "Project: pause or start",
    description:
      "Park a project deliberately (PAUSED) or resume it (STARTED). Pausing is reversible, unlike completion: " +
      "the plan, goals and open questions all stay as they are. Record a resume note so picking the thread " +
      "back up is one step.",
    promptSnippet: "Pause or resume the project",
    parameters: Type.Object({
      action: StringEnum(["pause", "start", "status"] as const),
      note: Type.Optional(Type.String({ description: "What to do first when work resumes" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      if (params.action === "pause") {
        const project = await manager.pauseProject(params.note);
        return ok(
          project.meta.resumeNote
            ? `Project paused. Resume with: ${project.meta.resumeNote}`
            : "Project paused. No resume note recorded.",
        );
      }
      if (params.action === "start") {
        const wasPaused = manager.project.meta.paused;
        const project = await manager.resumeProject();
        return ok(
          (wasPaused ? "Project resumed." : "Project was not paused.") +
            (project.meta.resumeNote ? ` First step: ${project.meta.resumeNote}` : ""),
        );
      }
      const project = manager.project;
      const paused = project.meta.paused
        ? `PAUSED since ${project.meta.pausedAt ?? "unknown"}${project.meta.resumeNote ? ` — resume with: ${project.meta.resumeNote}` : ""}`
        : project.meta.completed
          ? "COMPLETED"
          : "ACTIVE";
      return ok(`${project.meta.name}: ${paused}`);
    },
  });

  /* ---------------- resume ---------------- */

  pi.registerTool({
    name: "project_resume",
    label: "Project: resume",
    description:
      "Inspect how to resume a project after Pi or session interruption: unfinished runs, running/interrupted DAG nodes, " +
      "failed work needing replanning and concrete next actions. Use reconcile to mark dead runs interrupted.",
    promptSnippet: "Inspect unfinished work and next actions to resume a project",
    promptGuidelines: [
      "Use project_resume at the start of a new session when the project may have been interrupted mid-execution.",
    ],
    parameters: Type.Object({
      reconcile: Type.Optional(Type.Boolean({ description: "Mark runs without a live process as INTERRUPTED first" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const manager = await requireManager(ctx);
      let reconciled = "_not requested_";
      if (params.reconcile) {
        const changed = await manager.reconcileRuns();
        reconciled = changed.length === 0 ? "no stale runs" : `marked interrupted: ${changed.map((run) => run.id).join(", ")}`;
      }
      const report = await manager.read((project) => buildResumeReport(project));
      return ok(`${report}\n\n(reconcile: ${reconciled})`);
    },
  });
}
