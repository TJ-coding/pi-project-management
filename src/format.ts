/**
 * Plain-text (LLM-facing) renderers for every project view.
 *
 * The TUI has its own theme-aware renderers in `dashboard.ts`; these functions
 * produce compact markdown-ish text used by tools, commands and context
 * injection. Keeping them free of ANSI keeps them ideal for model consumption.
 */

import { dagStats, readyNodes, topoOrder } from "./dag.ts";
import { formatAwaySummary, planEvolution, summarizeSince } from "./history.ts";
import { byQuestionPriority, byRiskPriority, riskExposure, scoreBand, priorityBand } from "./scoring.ts";
import type { Goal, NodeStatus, Project, Question, Risk } from "./types.ts";

/**
 * The objective, its progress and what "done" means, as plain text.
 * Shared by the tool and `/project objective` so both read identically, and
 * so a missing objective is stated rather than rendering as an empty section.
 */
export function renderObjectiveText(project: Project): string {
  const objective = project.meta.objective;
  if (!objective) {
    return [
      `# Objective\n`,
      `_none set for ${project.meta.name}_`,
      "",
      "The objective is the one sentence this stretch of work is for, separate from\n" +
        "vision (why the project exists) and goals (durable end states). Set it with:\n" +
        "  /project objective <sentence>",
    ].join("\n");
  }

  const active = plan(project);
  const lines = [`# Objective\n`, objective, ""];
  if (project.meta.objectiveSetAt) lines.push(`set: ${project.meta.objectiveSetAt.slice(0, 10)}`);
  lines.push("");

  lines.push("## Progress");
  if (!active || active.nodes.length === 0) {
    lines.push("no plan yet, so there is nothing measurable to finish");
  } else {
    const stats = dagStats(active.nodes);
    lines.push(`plan ${active.id} v${active.version}: ${stats.byStatus.COMPLETED}/${stats.total} nodes done, ${stats.byStatus.RUNNING} running, ${stats.ready} ready`);
    const next = readyNodes(active.nodes)[0];
    if (next) lines.push(`next: ${next.id} ${next.title}`);
    else if (stats.byStatus.COMPLETED === stats.total) lines.push("all nodes done — verify the goals, then complete or replan");
  }

  lines.push("", "## Done when");
  const aimed = project.goals.filter((goal) => goal.status === "ACTIVE" && (!active || active.nodes.some((n) => n.goal === goal.id)));
  const target = aimed.length > 0 ? aimed : project.goals.filter((goal) => goal.status === "ACTIVE");
  if (target.length === 0) {
    lines.push("no active goal is linked to this work — link a goal, or say what finished looks like");
  } else {
    for (const goal of target) {
      lines.push(`${goal.id} ${goal.title} [${goal.status}]`);
      if (goal.successCriteria.length === 0) lines.push("  (no success criteria recorded)");
      for (const criterion of goal.successCriteria) lines.push(`  - ${criterion}`);
    }
  }
  return lines.join("\n");
}

export function renderStatusText(project: Project): string {
  const active = plan(project);
  const stats = active ? dagStats(active.nodes) : null;
  const topQuestion = byQuestionPriority(project.questions)[0];
  const topRisk = byRiskPriority(project.risks)[0];
  const activeGoals = project.goals.filter((goal) => goal.status === "ACTIVE");

  const lines: string[] = [];
  lines.push(`# ${project.meta.name}`);
  if (project.direction.vision) lines.push("", truncate(project.direction.vision, 320));
  lines.push("", "**Where are we? (State)**");
  lines.push(project.state.current ? truncate(project.state.current, 400) : "_not recorded_");
  lines.push("", `**Where are we going?** ${activeGoals.length} active goal(s)`);
  for (const goal of activeGoals.slice(0, 5)) {
    lines.push(`- ${goal.id} ${priorityBand(goal.priority)}: ${goal.title}`);
  }
  if (activeGoals.length === 0) lines.push("_no active goals_");
  lines.push("", "**What do we believe?**");
  lines.push(`Strategy: ${project.strategy.approach ? truncate(project.strategy.approach, 240) : "_not defined_"}`);
  lines.push(
    topQuestion
      ? `Most important unknown: ${topQuestion.id} ${truncate(topQuestion.question, 160)} (${scoreBand(score(topQuestion))})`
      : "Most important unknown: _no open questions_",
  );
  lines.push("", "**What are we doing about it?**");
  if (!active) {
    lines.push("_no active plan_");
  } else {
    lines.push(`Plan ${active.id} v${active.version}: ${active.title}`);
    if (stats) {
      lines.push(
        `Nodes: ${stats.total} total, ${stats.byStatus.COMPLETED} completed, ${stats.ready} ready, ${stats.byStatus.RUNNING} running, ${stats.byStatus.FAILED} failed`,
      );
    }
    for (const node of readyNodes(active.nodes).slice(0, 5)) {
      lines.push(`- next: ${node.id} [${node.type}] ${node.title}`);
    }
  }
  lines.push("", "**Top risks**");
  if (project.risks.length === 0) lines.push("_none recorded_");
  for (const risk of byRiskPriority(project.risks).slice(0, 5)) {
    lines.push(`- ${risk.id} ${scoreBand(riskScore(risk))}: ${risk.title} (${risk.status}, exposure ${riskExposure(risk)})`);
  }
  if (topRisk) lines.push("", `Highest risk: ${topRisk.id} ${topRisk.title}`);
  return lines.join("\n");
}

export function renderDirectionText(project: Project): string {
  const lines = ["# Direction", "", "## Vision", "", project.direction.vision || "_not defined_", ""];
  lines.push("## Intent", "", project.direction.intent || "_not defined_", "");
  lines.push("## Values", "");
  lines.push(...(project.direction.values.length > 0 ? project.direction.values.map((value) => `- ${value}`) : ["_none_"]));
  lines.push("", "## Concepts", "");
  lines.push(
    ...(project.direction.concepts.length > 0
      ? project.direction.concepts.map((concept) => `- [${concept.type}] ${concept.text}`)
      : ["_none_"]),
  );
  return lines.join("\n");
}

/**
 * `▰▰▰▱▱▱ 50%` — a percent as a bar plus the number, because the bar answers
 * "roughly how far" at a glance and the number answers "exactly how far".
 * The number is never dropped: at a small width the bar is unreadable, the
 * digits are not, and a bar with no number invites a wrong guess.
 */
/**
 * `██████░░░░ 60%` — a percent as a bar plus the number, because the bar answers
 * "roughly how far" at a glance and the number answers "exactly how far".
 *
 * One vocabulary (█ and ░) at one width everywhere: k3's review found the
 * selected-node pane using ▰▱ at 6 cells while the dashboard used █░, so the
 * same concept had to be re-learned per panel, and a 6-cell bar rounded 60%
 * to 67%. The number is never dropped - a bar alone invites a wrong guess.
 */
export function progressBar(percent: number, cells = 10): string {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)));
  const filled = Math.round((clamped / 100) * cells);
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, cells - filled));
  return `${bar} ${clamped}%`;
}

/** The badge form used in list rows: percent only, so columns stay aligned. */
export function percentBadge(percent: number | null): string {
  if (percent === null) return "";
  return `${Math.min(100, Math.max(0, Math.round(percent)))}%`;
}

export function renderGoalsText(project: Project, statuses?: readonly string[]): string {
  // Archived goals stay readable but are marked, so they cannot be mistaken for
  // active work when the list is read.
  const goals = statuses && statuses.length > 0
    ? project.goals.filter((goal) => statuses.includes(goal.status))
    : project.goals;
  if (goals.length === 0) return "# Goals\n\n_none_" ;
  const archived = goals.filter((goal) => goal.archived === true).length;
  const lines = ["# Goals", ""];
  if (archived > 0) lines.push(`_${archived} archived (marked ⌫ below)_`, "");
  for (const goal of [...goals].sort(byGoalPriority)) {
    lines.push(`## ${glyph(goal.status)} ${goal.id} [${goal.status}]${goal.archived ? " [ARCHIVED]" : ""} P${goal.priority}${goal.percent !== null ? ` ${goal.percent}%` : ""} — ${goal.title}`);
    if (goal.description) lines.push(goal.description);
    if (goal.parent) lines.push(`parent: ${goal.parent}`);
    if (goal.successCriteria.length > 0) {
      lines.push("success criteria:");
      for (const criterion of goal.successCriteria) lines.push(`  - ${criterion}`);
    }
    const links = [
      goal.questions.length > 0 ? `questions: ${goal.questions.join(", ")}` : null,
      goal.risks.length > 0 ? `risks: ${goal.risks.join(", ")}` : null,
      goal.tasks.length > 0 ? `tasks: ${goal.tasks.join(", ")}` : null,
      goal.supersededBy ? `superseded by: ${goal.supersededBy}` : null,
    ].filter(Boolean);
    if (links.length > 0) lines.push(links.join(" | "));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderStateText(project: Project): string {
  const lines = ["# State", "", "## Initial State", "", project.state.initial || "_not recorded_", ""];
  lines.push("## Current State", "", project.state.current || "_not recorded_", "");
  const list = (title: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push(`## ${title}`, "");
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  };
  list("Capabilities", project.state.capabilities);
  list("Known Facts", project.state.facts);
  list("Active Problems", project.state.problems);
  list("Constraints", project.state.constraints);
  list("Discoveries", project.state.discoveries);
  return lines.join("\n").trimEnd();
}

export function renderIntelligenceText(project: Project, limit = 50): string {
  if (project.questions.length === 0) return "# Intelligence\n\n_no questions_";
  const lines = ["# Intelligence (prioritized)", ""];
  const open = byQuestionPriority(project.questions.filter((q) => q.status === "UNKNOWN" || q.status === "PARTIAL"));
  const rest = byQuestionPriority(project.questions.filter((q) => q.status !== "UNKNOWN" && q.status !== "PARTIAL"));
  for (const question of [...open, ...rest].slice(0, limit)) {
    lines.push(
      `## ${question.id} [${question.status}] ${scoreBand(score(question))} — ${question.question}`,
    );
    lines.push(
      `answer: ${question.answer || "_unknown_"} (confidence ${question.confidence.toFixed(2)}, importance ${question.importance.toFixed(2)}, uncertainty ${question.uncertainty.toFixed(2)}, decision impact ${question.decisionImpact.toFixed(2)})`,
    );
    if (question.evidence.length > 0) {
      lines.push("evidence:");
      for (const evidence of question.evidence) {
        lines.push(`  - ${evidence.description}${evidence.ref ? ` (${evidence.ref})` : ""}${evidence.run ? ` [${evidence.run}]` : ""}`);
      }
    }
    const links = [
      question.goals.length > 0 ? `goals: ${question.goals.join(", ")}` : null,
      question.risks.length > 0 ? `risks: ${question.risks.join(", ")}` : null,
      question.tasks.length > 0 ? `tasks: ${question.tasks.join(", ")}` : null,
    ].filter(Boolean);
    if (links.length > 0) lines.push(links.join(" | "));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderRisksText(project: Project, limit = 50): string {
  if (project.risks.length === 0) return "# Risks\n\n_no risks_";
  const lines = ["# Risks (prioritized by exposure)", ""];
  for (const risk of byRiskPriority(project.risks).slice(0, limit)) {
    lines.push(`## ${risk.id} [${risk.status}] ${scoreBand(riskScore(risk))} — ${risk.title}`);
    if (risk.description) lines.push(risk.description);
    lines.push(
      `probability ${risk.probability.toFixed(2)} x impact ${risk.impact.toFixed(2)} = exposure ${riskExposure(risk)}`,
    );
    if (risk.mitigation) lines.push(`mitigation: ${risk.mitigation}`);
    if (risk.contingency) lines.push(`contingency: ${risk.contingency}`);
    const links = [
      risk.questions.length > 0 ? `questions: ${risk.questions.join(", ")}` : null,
      risk.goals.length > 0 ? `goals: ${risk.goals.join(", ")}` : null,
      risk.tasks.length > 0 ? `tasks: ${risk.tasks.join(", ")}` : null,
    ].filter(Boolean);
    if (links.length > 0) lines.push(links.join(" | "));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderStrategyText(project: Project): string {
  const strategy = project.strategy;
  const lines = ["# Strategy", "", "## Current Approach", "", strategy.approach || "_not defined_", ""];
  const list = (title: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push(`## ${title}`, "");
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  };
  list("Strategic Hypotheses", strategy.hypotheses);
  list("Priorities", strategy.priorities);
  list("Major Alternatives Considered", strategy.alternatives);
  if (strategy.rationale) lines.push("## Rationale", "", strategy.rationale, "");
  return lines.join("\n").trimEnd();
}

export function renderPlanText(project: Project, planId?: string): string {
  const active = planId
    ? project.plans.plans.find((item) => item.id === planId)
    : plan(project);
  if (!active) return "# Plan\n\n_no active plan_";
  const stats = dagStats(active.nodes);
  const lines = [
    `# Plan ${active.id} (v${active.version}) — ${active.title}`,
    "",
    active.rationale || "",
    "",
    `status: ${stats.byStatus.PENDING} pending, ${stats.byStatus.RUNNING} running, ${stats.byStatus.COMPLETED} completed, ${stats.byStatus.FAILED} failed, ${stats.byStatus.BLOCKED} blocked, ${stats.byStatus.INTERRUPTED} interrupted`,
    "",
    "## Nodes (dependency order)",
  ];
  const byId = new Map(active.nodes.map((node) => [node.id, node]));
  for (const node of topoOrder(active.nodes)) {
    const deps = node.dependsOn.map((dep) => `${dep}(${byId.get(dep)?.status ?? "?"})`).join(", ");
    lines.push(`- [${node.status}] ${node.id} ${node.type}: ${node.title}${node.percent !== null ? ` (${node.percent}%)` : ""}${deps ? `  <- ${deps}` : ""}`);
    const links = [
      node.goal ? `goal:${node.goal}` : null,
      node.question ? `question:${node.question}` : null,
      node.risk ? `risk:${node.risk}` : null,
      node.run ? `run:${node.run}` : null,
    ].filter(Boolean);
    if (links.length > 0) lines.push(`    ${links.join(" ")}`);
    if (node.gate) lines.push(`    gate(${node.gate.type}): ${node.gate.criteria}`);
    if (node.failureReason) lines.push(`    failure: ${node.failureReason}`);
    if (node.outputs.length > 0) lines.push(`    outputs: ${node.outputs.join("; ")}`);
  }
  const ready = readyNodes(active.nodes);
  lines.push("", "## Ready now", "");
  lines.push(...(ready.length > 0 ? ready.map((node) => `- ${node.id} ${node.title}`) : ["_nothing ready_"]));
  if (active.gates.length > 0) {
    lines.push("", "## Gate results", "");
    for (const gate of active.gates) {
      lines.push(`- ${gate.at} ${gate.node}: ${gate.outcome}${gate.notes ? ` — ${gate.notes}` : ""}`);
    }
  }
  return lines.join("\n").trimEnd();
}

export function renderHistoryText(project: Project, limit = 100): string {
  if (project.history.length === 0) return "# History\n\n_nothing recorded yet_";
  const lines = ["# History", ""];
  for (const event of project.history.slice(-limit).reverse()) {
    const refs = event.refs.length > 0 ? ` [${event.refs.join(", ")}]` : "";
    lines.push(`- ${event.at} ${event.kind}: ${event.summary}${refs} (by ${event.by})`);
  }
  return lines.join("\n");
}

export function renderPlanEvolutionText(project: Project): string {
  const evolution = planEvolution(project);
  if (evolution.length === 0) return "# Plan Evolution\n\n_no plans yet_";
  const lines = ["# Plan Evolution", ""];
  for (const entry of evolution) {
    lines.push(`## ${entry.plan} (v${entry.version}) — ${entry.title}`);
    lines.push(entry.rationale || "_no rationale_");
    if (entry.change) {
      lines.push(`changed: ${entry.change.at} (${entry.change.by})`);
      lines.push(`reason: ${entry.change.reason}`);
      lines.push(`trigger: ${entry.change.trigger}`);
    }
    if (entry.supersededBy) lines.push(`superseded by ${entry.supersededBy}`);
    const done = entry.nodes.filter((node) => node.status === "COMPLETED").length;
    lines.push(`nodes: ${entry.nodes.length} (${done} completed)`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderAwayText(project: Project, since: string): string {
  return formatAwaySummary(summarizeSince(project, since));
}

export function renderRunsText(project: Project, limit = 30): string {
  if (project.runs.length === 0) return "# Runs\n\n_no runs recorded_";
  const lines = ["# Runs", ""];
  for (const run of [...project.runs].slice(-limit).reverse()) {
    lines.push(`## ${run.id} [${run.status}] ${run.title}`);
    lines.push(`started ${run.started}${run.finished ? `, finished ${run.finished}` : ""}`);
    if (run.node) lines.push(`node: ${run.node}`);
    if (run.command) lines.push(`command: ${run.command}`);
    if (run.pid) lines.push(`pid: ${run.pid}${run.host ? ` on ${run.host}` : ""}`);
    for (const environment of run.environment) {
      lines.push(`environment: ${environment.kind} ${environment.target}${environment.note ? ` (${environment.note})` : ""}`);
    }
    if (run.entries.length > 0) {
      lines.push("log:");
      for (const entry of run.entries.slice(-5)) lines.push(`  ${entry.at} [${entry.kind}] ${entry.text}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * Goal rows use `●` for ACTIVE rather than the shared `→`: at the start of a row a
 * leading arrow reads as a cursor, and `→` is already doing ancestry duty in the
 * plan pane (`N1 → N2 → N4`).
 */
export function goalGlyph(status: Goal["status"]): string {
  return status === "ACTIVE" ? "●" : glyph(status);
}

export function statusGlyph(status: NodeStatus): string {
  switch (status) {
    case "COMPLETED":
      return "✓";
    case "FAILED":
      return "✗";
    case "RUNNING":
      return "●";
    case "BLOCKED":
      return "■";
    case "INTERRUPTED":
      return "‖";
    case "ABANDONED":
      return "⊘";
    case "SUPERSEDED":
      return "↪";
    default:
      return "○";
  }
}

function glyph(status: string): string {
  switch (status) {
    case "COMPLETED":
      return "✓";
    case "FAILED":
      return "✗";
    case "ABANDONED":
      return "⊘";
    case "SUPERSEDED":
      return "↪";
    case "ACTIVE":
      return "→";
    default:
      return "?";
  }
}

export function byGoalPriority(a: Goal, b: Goal): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return a.id.localeCompare(b.id, undefined, { numeric: true });
}

export function plan(project: Project) {
  if (!project.plans.active) return project.plans.plans[project.plans.plans.length - 1];
  return project.plans.plans.find((item) => item.id === project.plans.active);
}

function score(item: Question): number {
  const uncertainty =
    item.status === "UNKNOWN" ? 1 : item.status === "PARTIAL" ? 0.6 : item.status === "ANSWERED" ? 0.3 : 0;
  return Math.min(1, Math.max(0, item.importance) * uncertainty * Math.max(0, item.decisionImpact));
}

function riskScore(risk: Risk): number {
  const weight = risk.status === "RESOLVED" || risk.status === "CLOSED" ? 0 : risk.status === "ACCEPTED" ? 0.4 : 1;
  return riskExposure(risk) * weight;
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
