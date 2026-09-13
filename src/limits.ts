/**
 * Twitter-length budgets.
 *
 * Every list row is one line and every reading-pane section is meant to be read
 * at a glance, so project text is budgeted in words *and* characters. Budgets are
 * enforced on write (`ProjectManager.mutate` calls `assertBudgets`): text that is
 * new or changed and over budget is rejected, while text that was already long is
 * grandfathered, so an existing project can be tightened over time without any
 * edit being blocked by history.
 *
 * The limits are also the agent's instruction: `buildDigest` prints them, so the
 * first draft is already short instead of being rejected.
 */

import type { Project } from "./types.ts";

export type TextKind = "title" | "line" | "value" | "prose";

export interface Budget {
  kind: TextKind;
  /** Maximum words. */
  words: number;
  /** Maximum characters (a tweet is 280). */
  chars: number;
  /** How the budget is described in errors and headers. */
  shape: string;
}

export const BUDGETS: Record<TextKind, Budget> = {
  title: { kind: "title", words: 12, chars: 80, shape: "a headline" },
  line: { kind: "line", words: 30, chars: 220, shape: "one line" },
  value: { kind: "value", words: 20, chars: 140, shape: "a value or bullet" },
  prose: { kind: "prose", words: 60, chars: 400, shape: "a short paragraph" },
};

export interface TextField {
  /** Stable path, e.g. `question:Q5.answer`. */
  key: string;
  /** Human label, e.g. `Q5 answer`. */
  label: string;
  text: string;
  kind: TextKind;
}

export interface OverBudget {
  words: number;
  chars: number;
  budget: Budget;
  /** Human phrasing of what is over, e.g. ["143 words (max 40)"]. */
  exceeded: string[];
}

export function countWords(text: string): number {
  const flat = text.trim();
  return flat === "" ? 0 : flat.split(/\s+/).length;
}

export function overBudget(text: string, kind: TextKind): OverBudget | null {
  const budget = BUDGETS[kind];
  const words = countWords(text);
  const chars = text.trim().length;
  const wordsOver = words > budget.words ? (words - budget.words) / budget.words : 0;
  const charsOver = chars > budget.chars ? (chars - budget.chars) / budget.chars : 0;
  if (wordsOver === 0 && charsOver === 0) return null;
  // Report only the binding violation: "86 words (max 60) and 504 chars (max 400)"
  // says the same thing twice.
  const exceeded = charsOver > wordsOver ? [`${chars} chars (max ${budget.chars})`] : [`${words} words (max ${budget.words})`];
  return { words, chars, budget, exceeded };
}

/** Every budgeted piece of text in the project, keyed by field path. */
export function collectTextFields(project: Project): Map<string, TextField> {
  const fields = new Map<string, TextField>();
  const put = (key: string, label: string, text: string | null | undefined, kind: TextKind): void => {
    if (typeof text !== "string" || text.trim() === "") return;
    fields.set(key, { key, label, text, kind });
  };
  const putAll = (key: string, label: string, items: readonly string[], kind: TextKind): void => {
    items.forEach((item, index) => {
      put(`${key}[${index}]`, `${label} #${index + 1}`, item, kind);
    });
  };

  put("direction.vision", "Vision", project.direction.vision, "prose");
  put("direction.intent", "Intent", project.direction.intent, "prose");
  putAll("direction.values", "Value", project.direction.values, "value");
  project.direction.concepts.forEach((concept, index) => {
    put(`direction.concepts[${index}]`, `Concept (${concept.type})`, concept.text, "value");
  });

  put("state.initial", "Initial state", project.state.initial, "prose");
  put("state.current", "Current state", project.state.current, "prose");
  putAll("state.capabilities", "Capability", project.state.capabilities, "line");
  putAll("state.facts", "Known fact", project.state.facts, "line");
  putAll("state.problems", "Problem", project.state.problems, "line");
  putAll("state.constraints", "Constraint", project.state.constraints, "line");
  putAll("state.discoveries", "Discovery", project.state.discoveries, "line");

  for (const goal of project.goals) {
    put(`goal:${goal.id}.title`, `${goal.id} title`, goal.title, "title");
    put(`goal:${goal.id}.description`, `${goal.id} description`, goal.description, "prose");
    putAll(`goal:${goal.id}.successCriteria`, `${goal.id} success criterion`, goal.successCriteria, "line");
  }

  for (const question of project.questions) {
    put(`question:${question.id}.question`, `${question.id} question`, question.question, "title");
    put(`question:${question.id}.answer`, `${question.id} answer`, question.answer, "prose");
    question.evidence.forEach((evidence, index) => {
      put(`question:${question.id}.evidence[${index}]`, `${question.id} evidence #${index + 1}`, evidence.description, "line");
    });
  }

  for (const risk of project.risks) {
    put(`risk:${risk.id}.title`, `${risk.id} title`, risk.title, "title");
    put(`risk:${risk.id}.description`, `${risk.id} description`, risk.description, "line");
    put(`risk:${risk.id}.mitigation`, `${risk.id} mitigation`, risk.mitigation, "line");
    put(`risk:${risk.id}.contingency`, `${risk.id} contingency`, risk.contingency, "line");
  }

  put("strategy.approach", "Approach", project.strategy.approach, "prose");
  put("strategy.rationale", "Rationale", project.strategy.rationale, "prose");
  putAll("strategy.hypotheses", "Hypothesis", project.strategy.hypotheses, "line");
  putAll("strategy.priorities", "Priority", project.strategy.priorities, "line");
  putAll("strategy.alternatives", "Alternative", project.strategy.alternatives, "line");

  // NOTE: generated text is deliberately out of scope — e.g. the replan rationale
  // is written by replan.ts from the analysis, so an author cannot shorten it.

  for (const plan of project.plans.plans) {
    for (const node of plan.nodes) {
      put(`plan:${plan.id}/${node.id}.title`, `${node.id} title`, node.title, "title");
      put(`plan:${plan.id}/${node.id}.description`, `${node.id} description`, node.description, "line");
      put(`plan:${plan.id}/${node.id}.failureReason`, `${node.id} failure reason`, node.failureReason, "line");
      put(`plan:${plan.id}/${node.id}.gate.criteria`, `${node.id} gate criteria`, node.gate?.criteria, "line");
      putAll(`plan:${plan.id}/${node.id}.outputs`, `${node.id} output`, node.outputs, "line");
    }
  }

  for (const decision of project.decisions) {
    put(`decision:${decision.id}.title`, `${decision.id} title`, decision.title, "title");
    put(`decision:${decision.id}.decision`, `${decision.id} decision`, decision.decision, "prose");
    put(`decision:${decision.id}.rationale`, `${decision.id} rationale`, decision.rationale, "line");
    putAll(`decision:${decision.id}.alternatives`, `${decision.id} alternative`, decision.alternatives, "line");
    decision.evidence.forEach((evidence, index) => {
      put(`decision:${decision.id}.evidence[${index}]`, `${decision.id} evidence #${index + 1}`, evidence.description, "line");
    });
  }

  for (const run of project.runs) {
    put(`run:${run.id}.title`, `${run.id} title`, run.title, "title");
    putAll(`run:${run.id}.entries`, `${run.id} log line`, run.entries.map((entry) => entry.text), "line");
    putAll(`run:${run.id}.outputs`, `${run.id} output`, run.outputs.map((output) => output.description), "line");
  }

  return fields;
}

/**
 * Budget errors for text that is over budget.
 *
 * Two rules keep tightening incremental instead of all-or-nothing:
 *  - untouched long text is grandfathered, so old projects keep working;
 *  - an already over-budget field may be edited as long as the edit does not make
 *    it bigger (the "ratchet"), so a typo in a long sentence is still fixable.
 */
export function budgetViolations(
  before: ReadonlyMap<string, TextField>,
  after: ReadonlyMap<string, TextField>,
): string[] {
  const violations: string[] = [];
  for (const field of after.values()) {
    const over = overBudget(field.text, field.kind);
    if (!over) continue;
    const previous = before.get(field.key);
    if (previous && previous.text === field.text) continue;
    const previousOver = previous ? overBudget(previous.text, field.kind) : null;
    // Ratchet on one scalar, not per dimension: swapping a 90-char URL for three
    // short words must count as shrinking.
    if (previousOver && severity(over) <= severity(previousOver) + 1e-9) continue;
    const ratchet = previousOver ? ` (was ${previousOver.words}w/${previousOver.chars}c — may only shrink)` : "";
    violations.push(`${field.label} is ${over.exceeded.join(" and ")}${ratchet} — ${field.kind} budget is ${over.budget.shape}`);
  }
  return violations;
}

/** How badly a field misses its budget: 1.0 = exactly at the limit, 2.0 = twice. */
function severity(over: OverBudget): number {
  return Math.max(over.words / over.budget.words, over.chars / over.budget.chars);
}

/** Throw unless every new or changed field fits its budget. */
export function assertBudgets(before: ReadonlyMap<string, TextField>, after: ReadonlyMap<string, TextField>): void {
  const violations = budgetViolations(before, after);
  if (violations.length === 0) return;
  throw new Error(
    [
      `Rejected — keep it Twitter-short (${budgetSummary()}):`,
      ...violations.map((violation) => `- ${violation}`),
      "Rewrite the field(s) shorter and retry; nothing was written.",
      "A field that is already over budget may be edited, but only to shorten it.",
    ].join("\n"),
  );
}

/** Existing text that is already over budget (lint, status, dashboards). */
export function overBudgetFields(project: Project): Array<{ field: TextField; over: OverBudget }> {
  const findings: Array<{ field: TextField; over: OverBudget }> = [];
  for (const field of collectTextFields(project).values()) {
    const over = overBudget(field.text, field.kind);
    if (over) findings.push({ field, over });
  }
  return findings;
}

/** Field-path prefix -> dashboard view, used for the over-budget tally. */
export const BUDGET_VIEWS: Record<string, string> = {
  direction: "direction",
  state: "state",
  goal: "goals",
  question: "intelligence",
  risk: "risks",
  strategy: "strategy",
  plan: "plan",
  decision: "summary",
  run: "runs",
};

/** Entity ids (`goal:G4`, `plan:P2/N7`, …) that have at least one field over budget. */
export function overBudgetEntityIds(project: Project): Set<string> {
  const ids = new Set<string>();
  for (const { field } of overBudgetFields(project)) {
    const match = /^(goal|question|risk|plan):([^.\[]+)/.exec(field.key);
    if (match) ids.add(`${match[1]}:${match[2]}`);
  }
  return ids;
}

/** Over-budget counts per dashboard view, so the tally adds up. */
export function overBudgetByView(project: Project): { total: number; byView: Map<string, number> } {
  const byView = new Map<string, number>();
  let total = 0;
  for (const { field } of overBudgetFields(project)) {
    const prefix = field.key.split(/[.:[]/)[0] ?? "";
    const view = BUDGET_VIEWS[prefix] ?? "other";
    byView.set(view, (byView.get(view) ?? 0) + 1);
    total += 1;
  }
  return { total, byView };
}

/** Compact budget line: shown in the digest and in errors. */
export function budgetSummary(): string {
  const { title, line, value, prose } = BUDGETS;
  return [
    `titles ≤${title.words}w/${title.chars}c`,
    `one-liners ≤${line.words}w/${line.chars}c`,
    `values ≤${value.words}w/${value.chars}c`,
    `prose ≤${prose.words}w/${prose.chars}c`,
  ].join(" · ");
}
