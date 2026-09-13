/**
 * Derived completions for thinly-specified entities (spec 4.5, goal G6).
 *
 * A goal is often written before its links exist: the human types a title, and
 * the questions, risks and success criteria that belong to it are obvious from
 * the project but tedious to enter. This module derives *proposals* from what is
 * already recorded. It never writes: the caller shows the proposals and applies
 * only the accepted ones, so a human edit is never silently replaced.
 *
 * The rules are deliberately conservative — a proposal is only made when a link
 * or an existing strategy line really is about this goal:
 *  - links come from entities that already name the goal (their side owns it);
 *  - success criteria come from open questions those entities depend on, so the
 *    criterion is "answer Qn", which is what makes a goal done here.
 */

import type { Goal, Project } from "./types.ts";

export interface GoalFillProposal {
  /** Field path, e.g. `questions`. */
  key: "questions" | "risks" | "tasks" | "successCriteria" | "description";
  label: string;
  /** Plain-language reason, shown with the proposal. */
  why: string;
  /** Values to add; only ever appended, never a replacement. */
  add: string[];
}

/** Fields on a goal that a fill-in could populate. */
export const FILLABLE_GOAL_FIELDS = ["questions", "risks", "tasks", "successCriteria"] as const;

/**
 * Proposals for a goal, in the order they are worth accepting. Only fields the
 * goal does not already carry are proposed, and a proposal with nothing to add
 * is dropped, so the list is either useful or empty.
 */
export function suggestGoalFill(project: Project, goalId: string): GoalFillProposal[] {
  const goal = project.goals.find((candidate) => candidate.id === goalId);
  if (!goal) return [];
  const proposals: GoalFillProposal[] = [];

  const questions = project.questions.filter((question) => question.goals.includes(goalId));
  const newQuestions = questions.map((question) => question.id).filter((id) => !goal.questions.includes(id));
  if (newQuestions.length > 0) {
    proposals.push({
      key: "questions",
      label: "Questions",
      why: `${newQuestions.length} question(s) already name this goal but the goal does not list them`,
      add: newQuestions,
    });
  }

  const risks = project.risks.filter((risk) => risk.goals.includes(goalId));
  const newRisks = risks.map((risk) => risk.id).filter((id) => !goal.risks.includes(id));
  if (newRisks.length > 0) {
    proposals.push({
      key: "risks",
      label: "Risks",
      why: `${newRisks.length} risk(s) already name this goal but the goal does not list them`,
      add: newRisks,
    });
  }

  // A node that names this goal is work in service of it.
  const nodes = project.plans.plans.flatMap((plan) => plan.nodes).filter((node) => node.goal === goalId);
  const newTasks = nodes.map((node) => node.id).filter((id) => !goal.tasks.includes(id));
  if (newTasks.length > 0) {
    proposals.push({
      key: "tasks",
      label: "Tasks",
      why: `${newTasks.length} plan node(s) already sit under this goal`,
      add: newTasks,
    });
  }

  if (goal.successCriteria.length === 0) {
    // The clearest signal a goal is done here is that its linked open questions
    // are answered, so propose exactly that.
    const linked = project.questions.filter(
      (question) =>
        (question.goals.includes(goalId) || goal.questions.includes(question.id)) &&
        question.status !== "ANSWERED" &&
        question.status !== "CONFIRMED",
    );
    if (linked.length > 0) {
      proposals.push({
        key: "successCriteria",
        label: "Success criteria",
        why: "the linked open questions currently have no answer, so answering them is the finish line",
        add: linked.map((question) => `Answer ${question.id}: ${question.question}`),
      });
    }
  }

  if (!goal.description.trim()) {
    const fromQuestions = questions[0]?.question ?? "";
    const fromNodes = nodes[0]?.title ?? "";
    const seed = fromQuestions || fromNodes;
    if (seed) {
      proposals.push({
        key: "description",
        label: "Description",
        why: "derived from the first linked question or node",
        add: [seed],
      });
    }
  }

  return proposals;
}

/** Apply the accepted proposals to a goal patch, appending rather than replacing. */
export function applyGoalFill(goal: Goal, accepted: readonly GoalFillProposal[]): Partial<Goal> {
  const patch: Partial<Goal> = {};
  const merged = {
    questions: [...goal.questions],
    risks: [...goal.risks],
    tasks: [...goal.tasks],
    successCriteria: [...goal.successCriteria],
  };
  for (const proposal of accepted) {
    if (proposal.key === "description") {
      patch.description = proposal.add[0] ?? goal.description;
      continue;
    }
    if (proposal.key === "successCriteria") {
      merged.successCriteria.push(...proposal.add);
      continue;
    }
    merged[proposal.key].push(...proposal.add);
  }
  patch.questions = merged.questions;
  patch.risks = merged.risks;
  patch.tasks = merged.tasks;
  patch.successCriteria = merged.successCriteria;
  return patch;
}
