/**
 * Graphical (form-based) editors for project entities and documents.
 *
 * Each builder returns a `FormEditor` field list plus the save/delete behaviour
 * for a draft object. The draft is a plain, mutable copy of the entity; saving
 * calls the same ProjectManager methods the agent uses, so validation, history
 * and Git stay consistent.
 */

import type { FormField } from "./form.ts";
import type { ProjectManager } from "./project.ts";
import { priorityBand, riskExposure, scoreBand } from "./scoring.ts";
import type { Concept, ExternalRef, GateType, Goal, PlanNode, Project, Question, Risk } from "./types.ts";
import {
  ANSWER_STATUSES,
  GATE_TYPES,
  GOAL_STATUSES,
  NODE_STATUSES,
  NODE_TYPES,
  RISK_STATUSES,
} from "./types.ts";

export type EntityKind = "goal" | "risk" | "question";

export interface SaveOptions {
  approved?: boolean;
  approvedBy?: string;
}

export interface EntityForm {
  title: string;
  fields: FormField[];
  /** Persist the draft. Returns a one-line summary. May throw a requires-approval error. */
  save: (manager: ProjectManager, options?: SaveOptions) => Promise<string>;
  /** Delete the underlying entity (only for existing entities). */
  remove?: (manager: ProjectManager) => Promise<string>;
}

/* ------------------------------------------------------------------ */
/* Link helpers                                                       */
/* ------------------------------------------------------------------ */

function nodeChoices(project: Project): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; label: string }> = [];
  for (const plan of project.plans.plans) {
    for (const node of plan.nodes) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      out.push({ id: node.id, label: `${node.title} [${node.status}]` });
    }
  }
  return out;
}

function goalChoices(project: Project, exclude?: string): Array<{ id: string; label: string }> {
  return project.goals
    .filter((goal) => goal.id !== exclude)
    .map((goal) => ({ id: goal.id, label: `${goal.title} [${goal.status}] P${goal.priority}` }));
}

function questionChoices(project: Project, exclude?: string): Array<{ id: string; label: string }> {
  return project.questions
    .filter((question) => question.id !== exclude)
    .map((question) => ({ id: question.id, label: `${question.question} [${question.status}]` }));
}

function riskChoices(project: Project, exclude?: string): Array<{ id: string; label: string }> {
  return project.risks
    .filter((risk) => risk.id !== exclude)
    .map((risk) => ({ id: risk.id, label: `${risk.title} [${risk.status}] ${riskExposure(risk).toFixed(2)}` }));
}

/* ------------------------------------------------------------------ */
/* Goals                                                              */
/* ------------------------------------------------------------------ */

interface GoalDraft {
  id?: string;
  title: string;
  description: string;
  priority: number;
  status: string;
  parent: string | null;
  successCriteria: string[];
  questions: string[];
  risks: string[];
  tasks: string[];
}

export function goalForm(project: Project, id?: string): EntityForm {
  const existing = id ? project.goals.find((goal) => goal.id === id) : undefined;
  const draft: GoalDraft = existing
    ? {
        id: existing.id,
        title: existing.title,
        description: existing.description,
        priority: existing.priority,
        status: existing.status,
        parent: existing.parent,
        successCriteria: [...existing.successCriteria],
        questions: [...existing.questions],
        risks: [...existing.risks],
        tasks: [...existing.tasks],
      }
    : {
        title: "",
        description: "",
        priority: 3,
        status: "ACTIVE",
        parent: null,
        successCriteria: [],
        questions: [],
        risks: [],
        tasks: [],
      };

  const fields: FormField[] = [
    {
      kind: "text",
      key: "title",
      label: "Title",
      required: true,
      placeholder: "(required)",
      get: () => draft.title,
      set: (value) => {
        draft.title = value;
      },
    },
    {
      kind: "prose",
      key: "description",
      label: "Description",
      lines: 3,
      get: () => draft.description,
      set: (value) => {
        draft.description = value;
      },
    },
    {
      kind: "int",
      key: "priority",
      label: "Priority",
      min: 1,
      max: 5,
      describe: (value) => `${priorityBand(value)} (1 low … 5 critical)`,
      get: () => draft.priority,
      set: (value) => {
        draft.priority = value;
      },
    },
    {
      kind: "enum",
      key: "status",
      label: "Status",
      options: GOAL_STATUSES,
      get: () => draft.status,
      set: (value) => {
        draft.status = value;
      },
    },
    {
      kind: "ref",
      key: "parent",
      label: "Parent goal",
      get: () => draft.parent,
      set: (value) => {
        draft.parent = value;
      },
      available: () => goalChoices(project, draft.id),
    },
    {
      kind: "list",
      key: "successCriteria",
      label: "Success criteria",
      hint: "how we know it is done",
      get: () => draft.successCriteria,
      set: (value) => {
        draft.successCriteria = value;
      },
    },
    {
      kind: "refs",
      key: "questions",
      label: "Questions",
      get: () => draft.questions,
      set: (value) => {
        draft.questions = value;
      },
      available: () => questionChoices(project),
    },
    {
      kind: "refs",
      key: "risks",
      label: "Risks",
      get: () => draft.risks,
      set: (value) => {
        draft.risks = value;
      },
      available: () => riskChoices(project),
    },
    {
      kind: "refs",
      key: "tasks",
      label: "Plan nodes",
      get: () => draft.tasks,
      set: (value) => {
        draft.tasks = value;
      },
      available: () => nodeChoices(project),
    },
  ];

  return {
    title: existing ? `Goal ${existing.id}` : "New goal",
    fields,
    save: async (manager, options) => {
      const input = {
        title: draft.title,
        description: draft.description,
        priority: draft.priority,
        successCriteria: draft.successCriteria,
        parent: draft.parent,
        questions: draft.questions,
        risks: draft.risks,
        tasks: draft.tasks,
      };
      if (!draft.id) {
        const created = await manager.createGoal({ ...input, status: draft.status as Goal["status"] });
        return `Goal ${created.id} created`;
      }

      // Status changes go through the gated path; other fields through updateGoal.
      const original = project.goals.find((goal) => goal.id === draft.id);
      const statusChanged = original ? original.status !== draft.status : false;
      if (statusChanged) {
        const outcome = await manager.setGoalStatus(draft.id, draft.status as Goal["status"], {
          approved: options?.approved,
          approvedBy: options?.approvedBy,
          reason: "edited in the form",
        });
        if (outcome.status === "requires-approval") throw new Error(outcome.message);
      }
      await manager.updateGoal(draft.id, input);
      return `Goal ${draft.id} updated${statusChanged ? ` (status ${draft.status})` : ""}`;
    },
    ...(existing
      ? {
          remove: async (manager: ProjectManager) => {
            await manager.deleteGoal(existing.id);
            return `Goal ${existing.id} deleted`;
          },
        }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Risks                                                              */
/* ------------------------------------------------------------------ */

interface RiskDraft {
  id?: string;
  title: string;
  description: string;
  probability: number;
  impact: number;
  status: string;
  mitigation: string;
  contingency: string;
  owner: string;
  questions: string[];
  goals: string[];
  tasks: string[];
}

export function riskForm(project: Project, id?: string): EntityForm {
  const existing = id ? project.risks.find((risk) => risk.id === id) : undefined;
  const draft: RiskDraft = existing
    ? {
        id: existing.id,
        title: existing.title,
        description: existing.description,
        probability: existing.probability,
        impact: existing.impact,
        status: existing.status,
        mitigation: existing.mitigation,
        contingency: existing.contingency,
        owner: existing.owner ?? "",
        questions: [...existing.questions],
        goals: [...existing.goals],
        tasks: [...existing.tasks],
      }
    : {
        title: "",
        description: "",
        probability: 0.5,
        impact: 0.5,
        status: "OPEN",
        mitigation: "",
        contingency: "",
        owner: "",
        questions: [],
        goals: [],
        tasks: [],
      };

  const fields: FormField[] = [
    {
      kind: "text",
      key: "title",
      label: "Title",
      required: true,
      placeholder: "(required)",
      get: () => draft.title,
      set: (value) => {
        draft.title = value;
      },
    },
    {
      kind: "prose",
      key: "description",
      label: "Description",
      lines: 3,
      get: () => draft.description,
      set: (value) => {
        draft.description = value;
      },
    },
    {
      kind: "float",
      key: "probability",
      label: "Probability",
      min: 0,
      max: 1,
      step: 0.05,
      describe: (value) => `${(value * 100).toFixed(0)}% chance`,
      get: () => draft.probability,
      set: (value) => {
        draft.probability = value;
      },
    },
    {
      kind: "float",
      key: "impact",
      label: "Impact",
      min: 0,
      max: 1,
      step: 0.05,
      describe: (value) => `${(value * 100).toFixed(0)}% severity`,
      get: () => draft.impact,
      set: (value) => {
        draft.impact = value;
      },
    },
    {
      kind: "text",
      key: "exposure",
      label: "Exposure",
      hint: () => `p × i = ${(draft.probability * draft.impact).toFixed(2)}  ${scoreBand(draft.probability * draft.impact)}`,
      get: () => "",
      set: () => undefined,
    },
    {
      kind: "enum",
      key: "status",
      label: "Status",
      options: RISK_STATUSES,
      get: () => draft.status,
      set: (value) => {
        draft.status = value;
      },
    },
    {
      kind: "prose",
      key: "mitigation",
      label: "Mitigation",
      lines: 3,
      get: () => draft.mitigation,
      set: (value) => {
        draft.mitigation = value;
      },
    },
    {
      kind: "prose",
      key: "contingency",
      label: "Contingency",
      lines: 3,
      get: () => draft.contingency,
      set: (value) => {
        draft.contingency = value;
      },
    },
    {
      kind: "text",
      key: "owner",
      label: "Owner",
      placeholder: "(optional)",
      get: () => draft.owner,
      set: (value) => {
        draft.owner = value;
      },
    },
    {
      kind: "refs",
      key: "questions",
      label: "Questions",
      get: () => draft.questions,
      set: (value) => {
        draft.questions = value;
      },
      available: () => questionChoices(project),
    },
    {
      kind: "refs",
      key: "goals",
      label: "Goals",
      get: () => draft.goals,
      set: (value) => {
        draft.goals = value;
      },
      available: () => goalChoices(project),
    },
    {
      kind: "refs",
      key: "tasks",
      label: "Plan nodes",
      get: () => draft.tasks,
      set: (value) => {
        draft.tasks = value;
      },
      available: () => nodeChoices(project),
    },
  ];

  return {
    title: existing ? `Risk ${existing.id}` : "New risk",
    fields,
    save: async (manager) => {
      const input = {
        title: draft.title,
        description: draft.description,
        probability: draft.probability,
        impact: draft.impact,
        status: draft.status as Risk["status"],
        mitigation: draft.mitigation,
        contingency: draft.contingency,
        questions: draft.questions,
        goals: draft.goals,
        tasks: draft.tasks,
        ...(draft.owner ? { owner: draft.owner } : {}),
      };
      if (draft.id) {
        await manager.updateRisk(draft.id, input);
        return `Risk ${draft.id} updated`;
      }
      const created = await manager.createRisk(input);
      return `Risk ${created.id} created`;
    },
    ...(existing
      ? {
          remove: async (manager: ProjectManager) => {
            await manager.deleteRisk(existing.id);
            return `Risk ${existing.id} deleted`;
          },
        }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Questions                                                          */
/* ------------------------------------------------------------------ */

interface QuestionDraft {
  id?: string;
  question: string;
  answer: string;
  status: string;
  importance: number;
  uncertainty: number;
  decisionImpact: number;
  confidence: number;
  goals: string[];
  risks: string[];
  tasks: string[];
}

export function questionForm(project: Project, id?: string): EntityForm {
  const existing = id ? project.questions.find((question) => question.id === id) : undefined;
  const draft: QuestionDraft = existing
    ? {
        id: existing.id,
        question: existing.question,
        answer: existing.answer,
        status: existing.status,
        importance: existing.importance,
        uncertainty: existing.uncertainty,
        decisionImpact: existing.decisionImpact,
        confidence: existing.confidence,
        goals: [...existing.goals],
        risks: [...existing.risks],
        tasks: [...existing.tasks],
      }
    : {
        question: "",
        answer: "",
        status: "UNKNOWN",
        importance: 0.5,
        uncertainty: 1,
        decisionImpact: 0.5,
        confidence: 0,
        goals: [],
        risks: [],
        tasks: [],
      };

  const score = (): number => draft.importance * draft.uncertainty * draft.decisionImpact;
  const fields: FormField[] = [
    {
      kind: "prose",
      key: "question",
      label: "Question",
      required: true,
      lines: 3,
      get: () => draft.question,
      set: (value) => {
        draft.question = value;
      },
    },
    {
      kind: "enum",
      key: "status",
      label: "Status",
      options: ANSWER_STATUSES,
      get: () => draft.status,
      set: (value) => {
        draft.status = value;
      },
    },
    {
      kind: "prose",
      key: "answer",
      label: "Answer",
      lines: 3,
      get: () => draft.answer,
      set: (value) => {
        draft.answer = value;
      },
    },
    {
      kind: "float",
      key: "importance",
      label: "Importance",
      min: 0,
      max: 1,
      step: 0.05,
      describe: (value) => `${(value * 100).toFixed(0)}%`,
      get: () => draft.importance,
      set: (value) => {
        draft.importance = value;
      },
    },
    {
      kind: "float",
      key: "uncertainty",
      label: "Uncertainty",
      min: 0,
      max: 1,
      step: 0.05,
      describe: (value) => `${(value * 100).toFixed(0)}%`,
      get: () => draft.uncertainty,
      set: (value) => {
        draft.uncertainty = value;
      },
    },
    {
      kind: "float",
      key: "decisionImpact",
      label: "Decision impact",
      min: 0,
      max: 1,
      step: 0.05,
      describe: (value) => `${(value * 100).toFixed(0)}%`,
      get: () => draft.decisionImpact,
      set: (value) => {
        draft.decisionImpact = value;
      },
    },
    {
      kind: "float",
      key: "confidence",
      label: "Confidence",
      min: 0,
      max: 1,
      step: 0.05,
      describe: (value) => `${(value * 100).toFixed(0)}%`,
      get: () => draft.confidence,
      set: (value) => {
        draft.confidence = value;
      },
    },
    {
      kind: "text",
      key: "score",
      label: "Priority score",
      hint: () => `${score().toFixed(2)}  ${scoreBand(score())}`,
      get: () => "",
      set: () => undefined,
    },
    {
      kind: "refs",
      key: "goals",
      label: "Goals",
      get: () => draft.goals,
      set: (value) => {
        draft.goals = value;
      },
      available: () => goalChoices(project),
    },
    {
      kind: "refs",
      key: "risks",
      label: "Risks",
      get: () => draft.risks,
      set: (value) => {
        draft.risks = value;
      },
      available: () => riskChoices(project),
    },
    {
      kind: "refs",
      key: "tasks",
      label: "Plan nodes",
      get: () => draft.tasks,
      set: (value) => {
        draft.tasks = value;
      },
      available: () => nodeChoices(project),
    },
  ];

  return {
    title: existing ? `Question ${existing.id}` : "New question",
    fields,
    save: async (manager) => {
      if (draft.id) {
        await manager.updateQuestion(draft.id, {
          question: draft.question,
          answer: draft.answer,
          status: draft.status as Question["status"],
          importance: draft.importance,
          uncertainty: draft.uncertainty,
          decisionImpact: draft.decisionImpact,
          confidence: draft.confidence,
          goals: draft.goals,
          risks: draft.risks,
          tasks: draft.tasks,
        });
        return `Question ${draft.id} updated`;
      }
      const created = await manager.createQuestion({
        question: draft.question,
        answer: draft.answer,
        status: draft.status as Question["status"],
        importance: draft.importance,
        uncertainty: draft.uncertainty,
        decisionImpact: draft.decisionImpact,
        confidence: draft.confidence,
        goals: draft.goals,
        risks: draft.risks,
        tasks: draft.tasks,
      });
      return `Question ${created.id} created`;
    },
    ...(existing
      ? {
          remove: async (manager: ProjectManager) => {
            await manager.deleteQuestion(existing.id);
            return `Question ${existing.id} deleted`;
          },
        }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Plan nodes (DAG)                                                   */
/* ------------------------------------------------------------------ */

interface NodeDraft {
  id?: string;
  title: string;
  type: string;
  status: string;
  description: string;
  dependsOn: string[];
  goal: string | null;
  question: string | null;
  risk: string | null;
  gateType: string;
  gateCriteria: string;
  outputs: string[];
  failureReason: string;
  assignee: string;
}

/** Nodes of the active plan, excluding one id (used for dependency pickers). */
function planNodeChoices(project: Project, exclude?: string): Array<{ id: string; label: string }> {
  const plan = activePlanOf(project);
  if (!plan) return [];
  return plan.nodes
    .filter((node) => node.id !== exclude)
    .map((node) => ({ id: node.id, label: `${node.title} [${node.status}]` }));
}

function activePlanOf(project: Project) {
  if (project.meta.activePlan) {
    const found = project.plans.plans.find((plan) => plan.id === project.meta.activePlan);
    if (found) return found;
  }
  if (project.plans.active) {
    const found = project.plans.plans.find((plan) => plan.id === project.plans.active);
    if (found) return found;
  }
  return project.plans.plans[project.plans.plans.length - 1];
}

export function nodeForm(project: Project, id?: string): EntityForm {
  const plan = activePlanOf(project);
  const existing = id && plan ? plan.nodes.find((node) => node.id === id) : undefined;
  const draft: NodeDraft = existing
    ? {
        id: existing.id,
        title: existing.title,
        type: existing.type,
        status: existing.status,
        description: existing.description,
        dependsOn: [...existing.dependsOn],
        goal: existing.goal,
        question: existing.question,
        risk: existing.risk,
        gateType: existing.gate?.type ?? "REVIEW",
        gateCriteria: existing.gate?.criteria ?? "",
        outputs: [...existing.outputs],
        failureReason: existing.failureReason ?? "",
        assignee: existing.assignee,
      }
    : {
        title: "",
        type: "TASK",
        status: "PENDING",
        description: "",
        dependsOn: [],
        goal: null,
        question: null,
        risk: null,
        gateType: "REVIEW",
        gateCriteria: "",
        outputs: [],
        failureReason: "",
        assignee: "agent",
      };

  const fields: FormField[] = [
    {
      kind: "text",
      key: "title",
      label: "Title",
      required: true,
      placeholder: "(required)",
      get: () => draft.title,
      set: (value) => {
        draft.title = value;
      },
    },
    {
      kind: "enum",
      key: "type",
      label: "Type",
      options: NODE_TYPES,
      get: () => draft.type,
      set: (value) => {
        draft.type = value;
      },
    },
    {
      kind: "enum",
      key: "status",
      label: "Status",
      options: NODE_STATUSES,
      get: () => draft.status,
      set: (value) => {
        draft.status = value;
      },
    },
    {
      kind: "enum",
      key: "assignee",
      label: "Assignee",
      options: ["agent", "human"],
      get: () => draft.assignee,
      set: (value) => {
        draft.assignee = value;
      },
    },
    {
      kind: "prose",
      key: "description",
      label: "Description",
      lines: 3,
      get: () => draft.description,
      set: (value) => {
        draft.description = value;
      },
    },
    {
      kind: "refs",
      key: "dependsOn",
      label: "Depends on",
      hint: "the DAG edges",
      get: () => draft.dependsOn,
      set: (value) => {
        draft.dependsOn = value;
      },
      available: () => planNodeChoices(project, draft.id),
    },
    {
      kind: "ref",
      key: "question",
      label: "Question",
      get: () => draft.question,
      set: (value) => {
        draft.question = value;
      },
      available: () => questionChoices(project),
    },
    {
      kind: "ref",
      key: "risk",
      label: "Risk",
      get: () => draft.risk,
      set: (value) => {
        draft.risk = value;
      },
      available: () => riskChoices(project),
    },
    {
      kind: "ref",
      key: "goal",
      label: "Goal",
      get: () => draft.goal,
      set: (value) => {
        draft.goal = value;
      },
      available: () => goalChoices(project),
    },
    {
      kind: "enum",
      key: "gateType",
      label: "Gate type",
      hint: "used when Type = GATE",
      options: GATE_TYPES,
      get: () => draft.gateType,
      set: (value) => {
        draft.gateType = value;
      },
    },
    {
      kind: "prose",
      key: "gateCriteria",
      label: "Gate criteria",
      hint: "used when Type = GATE",
      lines: 2,
      get: () => draft.gateCriteria,
      set: (value) => {
        draft.gateCriteria = value;
      },
    },
    {
      kind: "list",
      key: "outputs",
      label: "Outputs",
      hint: "evidence produced",
      get: () => draft.outputs,
      set: (value) => {
        draft.outputs = value;
      },
    },
    {
      kind: "text",
      key: "failureReason",
      label: "Failure reason",
      hint: "shown when Status = FAILED",
      get: () => draft.failureReason,
      set: (value) => {
        draft.failureReason = value;
      },
    },
  ];

  return {
    title: existing ? `Node ${existing.id}` : "New node",
    fields,
    save: async (manager) => {
      const gate: { type: GateType; criteria: string } | null =
        draft.type === "GATE" ? { type: draft.gateType as GateType, criteria: draft.gateCriteria } : null;
      if (draft.id) {
        const original = plan?.nodes.find((node) => node.id === draft.id);
        await manager.updateNode(draft.id, {
          title: draft.title,
          type: draft.type as PlanNode["type"],
          description: draft.description,
          dependsOn: draft.dependsOn,
          goal: draft.goal,
          risk: draft.risk,
          question: draft.question,
          assignee: draft.assignee as PlanNode["assignee"],
          gate,
        });
        if (original && original.status !== draft.status) {
          await manager.setNodeStatus(draft.id, draft.status as PlanNode["status"], {
            reason: draft.failureReason,
            outputs: draft.outputs.filter((output) => !original.outputs.includes(output)),
          });
        } else if (draft.outputs.length > 0) {
          const extra = draft.outputs.filter((output) => !(original?.outputs ?? []).includes(output));
          if (extra.length > 0) await manager.setNodeStatus(draft.id, draft.status as PlanNode["status"], { outputs: extra });
        }
        return `Node ${draft.id} updated`;
      }
      const created = await manager.addNode({
        title: draft.title,
        type: draft.type as PlanNode["type"],
        description: draft.description,
        dependsOn: draft.dependsOn,
        goal: draft.goal,
        risk: draft.risk,
        question: draft.question,
        assignee: draft.assignee as PlanNode["assignee"],
        gate,
        status: draft.status as PlanNode["status"],
      });
      return `Node ${created.id} created`;
    },
    ...(existing
      ? {
          remove: async (manager: ProjectManager) => {
            await manager.removeNode(existing.id);
            return `Node ${existing.id} deleted (dependencies removed)`;
          },
        }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Documents (direction / state / strategy)                           */
/* ------------------------------------------------------------------ */

export function directionForm(project: Project): EntityForm {
  const draft = {
    vision: project.direction.vision,
    intent: project.direction.intent,
    values: [...project.direction.values],
    concepts: project.direction.concepts.map(conceptToString),
  };
  return {
    title: "Direction (strategic — saving asks for confirmation)",
    fields: [
      {
        kind: "prose",
        key: "vision",
        label: "Vision",
        lines: 4,
        get: () => draft.vision,
        set: (value) => {
          draft.vision = value;
        },
      },
      {
        kind: "prose",
        key: "intent",
        label: "Intent",
        lines: 3,
        get: () => draft.intent,
        set: (value) => {
          draft.intent = value;
        },
      },
      {
        kind: "list",
        key: "values",
        label: "Values",
        hint: "guidance when choices are close",
        get: () => draft.values,
        set: (value) => {
          draft.values = value;
        },
      },
      {
        kind: "list",
        key: "concepts",
        label: "Concepts",
        hint: "format: [type] text",
        get: () => draft.concepts,
        set: (value) => {
          draft.concepts = value;
        },
      },
    ],
    save: async (manager) => {
      const outcome = await manager.updateDirection(
        {
          vision: draft.vision,
          intent: draft.intent,
          values: draft.values,
          concepts: draft.concepts.map(parseConcept),
        },
        { approved: true, approvedBy: "human", reason: "edited in the dashboard" },
      );
      if (outcome.status === "requires-approval") throw new Error(outcome.message);
      return "Direction saved";
    },
  };
}

export function stateForm(project: Project): EntityForm {
  const draft = {
    initial: project.state.initial,
    current: project.state.current,
    capabilities: [...project.state.capabilities],
    facts: [...project.state.facts],
    problems: [...project.state.problems],
    constraints: [...project.state.constraints],
    discoveries: [...project.state.discoveries],
  };
  const list = (key: keyof typeof draft, label: string, hint?: string): FormField => ({
    kind: "list",
    key,
    label,
    ...(hint ? { hint } : {}),
    get: () => draft[key] as string[],
    set: (value) => {
      (draft[key] as string[]) = value;
    },
  });
  return {
    title: "Current state",
    fields: [
      {
        kind: "prose",
        key: "current",
        label: "Current state",
        lines: 4,
        get: () => draft.current,
        set: (value) => {
          draft.current = value;
        },
      },
      {
        kind: "prose",
        key: "initial",
        label: "Initial state",
        lines: 3,
        get: () => draft.initial,
        set: (value) => {
          draft.initial = value;
        },
      },
      list("capabilities", "Capabilities"),
      list("facts", "Known facts"),
      list("problems", "Active problems"),
      list("constraints", "Constraints"),
      list("discoveries", "Discoveries"),
    ],
    save: async (manager) => {
      await manager.updateState(
        {
          initial: draft.initial,
          current: draft.current,
          capabilities: draft.capabilities,
          facts: draft.facts,
          problems: draft.problems,
          constraints: draft.constraints,
          discoveries: draft.discoveries,
        },
        { summary: "state edited in the dashboard" },
      );
      return "State saved";
    },
  };
}

export function strategyForm(project: Project): EntityForm {
  const draft = {
    approach: project.strategy.approach,
    hypotheses: [...project.strategy.hypotheses],
    priorities: [...project.strategy.priorities],
    rationale: project.strategy.rationale,
    alternatives: [...project.strategy.alternatives],
  };
  const list = (key: "hypotheses" | "priorities" | "alternatives", label: string): FormField => ({
    kind: "list",
    key,
    label,
    get: () => draft[key],
    set: (value) => {
      draft[key] = value;
    },
  });
  return {
    title: "Strategy",
    fields: [
      {
        kind: "prose",
        key: "approach",
        label: "Approach",
        lines: 4,
        get: () => draft.approach,
        set: (value) => {
          draft.approach = value;
        },
      },
      list("hypotheses", "Hypotheses"),
      list("priorities", "Priorities"),
      {
        kind: "prose",
        key: "rationale",
        label: "Rationale",
        lines: 3,
        get: () => draft.rationale,
        set: (value) => {
          draft.rationale = value;
        },
      },
      list("alternatives", "Alternatives"),
    ],
    save: async (manager) => {
      await manager.setStrategy(draft, { reason: "strategy edited in the dashboard" });
      return "Strategy saved";
    },
  };
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                           */
/* ------------------------------------------------------------------ */

/** Entity lists used by the picker. */
export function entityChoices(project: Project, kind: EntityKind): Array<{ id: string; label: string; description: string }> {
  switch (kind) {
    case "goal":
      return project.goals.map((goal) => ({
        id: goal.id,
        label: `${goal.id} ${goal.title}`,
        description: `${goal.status} · P${goal.priority} · ${goal.successCriteria.length} criteria`,
      }));
    case "risk":
      return project.risks.map((risk) => ({
        id: risk.id,
        label: `${risk.id} ${risk.title}`,
        description: `${risk.status} · exposure ${riskExposure(risk).toFixed(2)}`,
      }));
    case "question":
      return project.questions.map((question) => ({
        id: question.id,
        label: `${question.id} ${question.question}`,
        description: `${question.status} · confidence ${question.confidence.toFixed(2)}`,
      }));
  }
}

export function entityForm(kind: EntityKind, project: Project, id?: string): EntityForm {
  switch (kind) {
    case "goal":
      return goalForm(project, id);
    case "risk":
      return riskForm(project, id);
    case "question":
      return questionForm(project, id);
  }
}

export function entityKindLabel(kind: EntityKind): string {
  switch (kind) {
    case "goal":
      return "goal";
    case "risk":
      return "risk";
    case "question":
      return "question";
  }
}

export function documentForm(section: string, project: Project): EntityForm | undefined {
  switch (section) {
    case "direction":
      return directionForm(project);
    case "state":
      return stateForm(project);
    case "strategy":
      return strategyForm(project);
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Concept helpers                                                    */
/* ------------------------------------------------------------------ */

function conceptToString(concept: Concept): string {
  return `[${concept.type}] ${concept.text}`;
}

function parseConcept(value: string): Concept {
  const match = /^\[([^\]]+)\]\s*(.*)$/.exec(value.trim());
  if (match) return { type: match[1]!.trim().toLowerCase(), text: match[2]!.trim() };
  return { type: "concept", text: value.trim() };
}

/** External references are edited with raw text; kept here for completeness. */
export function renderResources(resources: readonly ExternalRef[]): string[] {
  return resources.map((resource) => `${resource.kind}: ${resource.target}${resource.note ? ` (${resource.note})` : ""}`);
}
