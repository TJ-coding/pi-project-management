/**
 * Semantic history (spec 20) and completion summaries (spec 21).
 *
 * Git holds the low-level history. This module builds the higher-level,
 * human-readable story: what changed, when, why, and what it means.
 */

import { byQuestionPriority, byRiskPriority, scoreBand } from "./scoring.ts";
import type { HistoryEvent, HistoryKind, Project } from "./types.ts";

export interface RecordEventInput {
  kind: HistoryKind;
  summary: string;
  by?: string;
  refs?: string[];
  details?: Record<string, unknown>;
  at?: string;
}

export function appendHistory(project: Project, input: RecordEventInput, clockNow: string): HistoryEvent {
  const seq = project.history.reduce((max, event) => Math.max(max, event.seq), 0) + 1;
  const event: HistoryEvent = {
    seq,
    at: input.at ?? clockNow,
    kind: input.kind,
    summary: input.summary,
    by: input.by ?? "agent",
    refs: input.refs ?? [],
    ...(input.details ? { details: input.details } : {}),
  };
  project.history.push(event);
  return event;
}

export function eventsSince(project: Project, since: string | null | undefined): HistoryEvent[] {
  if (!since) return [...project.history];
  const cutoff = Date.parse(since);
  if (!Number.isFinite(cutoff)) return [...project.history];
  return project.history.filter((event) => Date.parse(event.at) >= cutoff);
}

export interface PlanEvolutionEntry {
  plan: string;
  version: number;
  title: string;
  rationale: string;
  createdAt: string;
  supersededBy: string | null;
  change?: { reason: string; trigger: string; by: string; at: string };
  nodes: Array<{ id: string; status: string; title: string; type: string }>;
}

/** Sequence of plans with why each was replaced (spec 11 / 20). */
export function planEvolution(project: Project): PlanEvolutionEntry[] {
  return project.plans.plans
    .map((plan) => {
      const change = project.plans.changes.find((item) => item.to === plan.id);
      return {
        plan: plan.id,
        version: plan.version,
        title: plan.title,
        rationale: plan.rationale,
        createdAt: plan.createdAt,
        supersededBy: plan.supersededBy,
        ...(change
          ? { change: { reason: change.reason, trigger: change.trigger, by: change.by, at: change.at } }
          : {}),
        nodes: plan.nodes.map((node) => ({ id: node.id, status: node.status, title: node.title, type: node.type })),
      };
    })
    .sort((a, b) => a.version - b.version);
}

export interface AwaySummary {
  since: string;
  events: number;
  goalsCompleted: string[];
  goalsFailed: string[];
  goalsAbandoned: string[];
  goalsSuperseded: string[];
  questionsAnswered: string[];
  risksResolved: string[];
  risksCreated: string[];
  planChanges: string[];
  decisions: string[];
  gateFailures: string[];
  gatePasses: string[];
  runsFinished: string[];
}

/** "What happened while I was away?" (spec 28). */
export function summarizeSince(project: Project, since: string): AwaySummary {
  const events = eventsSince(project, since);
  const pick = (kind: HistoryEvent["kind"]): string[] =>
    events.filter((event) => event.kind === kind).map((event) => event.summary);

  return {
    since,
    events: events.length,
    goalsCompleted: pick("goal.completed"),
    goalsFailed: pick("goal.failed"),
    goalsAbandoned: pick("goal.abandoned"),
    goalsSuperseded: pick("goal.superseded"),
    questionsAnswered: pick("question.answered"),
    risksResolved: pick("risk.resolved"),
    risksCreated: pick("risk.created"),
    planChanges: pick("plan.changed"),
    decisions: pick("decision.made"),
    gateFailures: pick("gate.failed"),
    gatePasses: pick("gate.passed"),
    runsFinished: pick("run.finished"),
  };
}

export function formatAwaySummary(summary: AwaySummary): string {
  const lines: string[] = [`Since ${summary.since}: ${summary.events} recorded event(s).`];
  const push = (label: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push(`${label}:`);
    for (const item of items) lines.push(`  - ${item}`);
  };
  push("Goals completed", summary.goalsCompleted);
  push("Goals failed", summary.goalsFailed);
  push("Goals abandoned", summary.goalsAbandoned);
  push("Goals superseded", summary.goalsSuperseded);
  push("Questions answered", summary.questionsAnswered);
  push("Risks resolved", summary.risksResolved);
  push("Risks created", summary.risksCreated);
  push("Plan changes", summary.planChanges);
  push("Decisions", summary.decisions);
  push("Gates passed", summary.gatePasses);
  push("Gates failed", summary.gateFailures);
  push("Runs finished", summary.runsFinished);
  return lines.join("\n");
}

const GOAL_GLYPH: Record<string, string> = {
  COMPLETED: "✓",
  FAILED: "✗",
  ABANDONED: "⊘",
  SUPERSEDED: "↪",
  ACTIVE: "→",
};

/**
 * Final project summary (spec 21): vision, final state, goals with outcomes,
 * major risks/questions/decisions, plan evolution and lessons learned.
 */
export function renderCompletionSummary(project: Project): string {
  const lines: string[] = [`# ${project.meta.name} — Project Summary`, ""];

  lines.push("## Vision", "", project.direction.vision || "_Not defined._", "");
  if (project.direction.intent) lines.push("## Intent", "", project.direction.intent, "");

  lines.push("## Final State", "", project.state.current || "_Not recorded._", "");

  lines.push("## Goals", "");
  if (project.goals.length === 0) lines.push("_No goals recorded._");
  for (const goal of project.goals) {
    const glyph = GOAL_GLYPH[goal.status] ?? "?";
    lines.push(`- ${glyph} ${goal.id} ${goal.title} (${goal.status})`);
    if (goal.supersededBy) lines.push(`    superseded by ${goal.supersededBy}`);
  }
  lines.push("");

  lines.push("## Major Risks", "");
  const risks = byRiskPriority(project.risks).slice(0, 8);
  if (risks.length === 0) lines.push("_No risks recorded._");
  for (const risk of risks) {
    lines.push(
      `- ${risk.id} ${risk.title} — exposure ${risk.probability.toFixed(2)} x ${risk.impact.toFixed(2)}, status ${risk.status}`,
    );
  }
  lines.push("");

  lines.push("## Major Questions", "");
  const questions = byQuestionPriority(project.questions).slice(0, 8);
  if (questions.length === 0) lines.push("_No questions recorded._");
  for (const question of questions) {
    lines.push(`- ${question.id} ${question.question} — ${question.status} (${scoreBand(questionScoreSafe(question))})`);
  }
  lines.push("");

  lines.push("## Major Decisions", "");
  if (project.decisions.length === 0) lines.push("_No decisions recorded._");
  for (const decision of project.decisions) {
    lines.push(`- ${decision.id} ${decision.title} (${decision.authority}${decision.autoAccepted ? ", auto-accepted" : ""})`);
  }
  lines.push("");

  lines.push("## Plan Evolution", "");
  const evolution = planEvolution(project);
  if (evolution.length === 0) lines.push("_No plans recorded._");
  for (const entry of evolution) {
    lines.push(`- ${entry.plan} (v${entry.version}) ${entry.title}${entry.supersededBy ? ` → superseded by ${entry.supersededBy}` : ""}`);
    if (entry.change) lines.push(`    why: ${entry.change.reason}`);
  }
  lines.push("");

  lines.push("## Lessons / Findings", "");
  const findings = [
    ...project.state.discoveries,
    ...project.questions
      .filter((question) => question.status === "CONFIRMED" || question.status === "INVALIDATED")
      .map((question) => `${question.id} ${question.status}: ${question.answer || "no answer recorded"}`),
  ];
  if (findings.length === 0) lines.push("_None recorded._");
  for (const finding of findings) lines.push(`- ${finding}`);
  lines.push("");

  return lines.join("\n");
}

function questionScoreSafe(question: Project["questions"][number]): number {
  // Local import cycle avoidance: recompute the score inline.
  const uncertainty =
    question.status === "UNKNOWN"
      ? 1
      : question.status === "PARTIAL"
        ? 0.6
        : question.status === "ANSWERED"
          ? 0.3
          : 0;
  return Math.min(1, Math.max(0, question.importance) * uncertainty * Math.max(0, question.decisionImpact));
}
