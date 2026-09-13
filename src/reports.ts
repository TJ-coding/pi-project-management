/**
 * Composite human/agent-readable reports shared by tools and commands:
 * replanning analysis (spec 25) and strategic review (spec 13).
 */

import { dagStats, readyNodes } from "./dag.ts";
import { byQuestionPriority, byRiskPriority, riskExposure, questionScore, scoreBand } from "./scoring.ts";
import type { ReplanProposal } from "./replan.ts";
import type { Project } from "./types.ts";
import { validateProject } from "./validate.ts";

/** The 12 inputs spec 25 requires a replanner to consider, plus the proposal. */
export function renderReplanAnalysis(project: Project, proposal: ReplanProposal): string {
  const active = activePlan(project);
  const lines: string[] = [];
  lines.push("# Replanning analysis (spec 25 inputs)", "");
  lines.push("## 1-4. Direction");
  lines.push(`- Vision: ${project.direction.vision || "_not defined_"}`);
  lines.push(`- Intent: ${project.direction.intent || "_not defined_"}`);
  lines.push(`- Values: ${project.direction.values.join(", ") || "_none_"}`);
  lines.push(
    `- Concepts: ${project.direction.concepts.map((concept) => `[${concept.type}] ${concept.text}`).join("; ") || "_none_"}`,
  );

  lines.push("", "## 5. Goals");
  for (const goal of project.goals.filter((item) => item.status === "ACTIVE")) {
    lines.push(`- ${goal.id} P${goal.priority}: ${goal.title}`);
  }
  if (!project.goals.some((goal) => goal.status === "ACTIVE")) lines.push("- _no active goals_");

  lines.push("", "## 6. Current state");
  lines.push(project.state.current || "_not recorded_");

  lines.push("", "## 7. Highest priority intelligence");
  const questions = byQuestionPriority(
    project.questions.filter((item) => item.status === "UNKNOWN" || item.status === "PARTIAL"),
  ).slice(0, 5);
  if (questions.length === 0) lines.push("- _no open questions_");
  for (const question of questions) {
    lines.push(`- ${question.id} (${scoreBand(questionScore(question))}) ${question.question}`);
  }

  lines.push("", "## 8. Highest priority risks");
  const risks = byRiskPriority(project.risks).slice(0, 5);
  if (risks.length === 0) lines.push("- _no risks_");
  for (const risk of risks) {
    lines.push(`- ${risk.id} ${risk.title} (exposure ${riskExposure(risk)}, ${risk.status})`);
  }

  lines.push("", "## 9. Previous work");
  if (active) {
    const executed = active.nodes.filter((node) => node.status !== "PENDING");
    if (executed.length === 0) lines.push("- _nothing executed yet_");
    for (const node of executed) {
      lines.push(`- ${node.id} [${node.status}] ${node.title}${node.failureReason ? ` — ${node.failureReason}` : ""}`);
    }
  } else {
    lines.push("- _no previous plan_");
  }

  lines.push("", "## 10. Strategy");
  lines.push(project.strategy.approach || "_not defined_");
  if (project.strategy.hypotheses.length > 0) {
    lines.push(`hypotheses: ${project.strategy.hypotheses.join("; ")}`);
  }

  lines.push("", "## 11. Current plan");
  lines.push(active ? `${active.id} v${active.version}: ${active.title} (${active.nodes.length} nodes)` : "_none_");

  lines.push("", "## 12. New evidence");
  lines.push(proposal.trigger || "_none provided_");
  if (proposal.evidenceHints && proposal.evidenceHints.length > 0) {
    for (const hint of proposal.evidenceHints) lines.push(`- ${hint}`);
  }

  lines.push("", "## Proposed smallest useful plan", "", proposal.rationale, "");
  for (const node of proposal.nodes) {
    lines.push(`- ${node.ref ?? "?"} [${node.type}]${node.status ? ` (${node.status})` : ""} ${node.title}`);
    if (node.description) lines.push(`    ${node.description}`);
    if (node.dependsOn && node.dependsOn.length > 0) lines.push(`    after: ${node.dependsOn.join(", ")}`);
  }

  if (proposal.notes.length > 0) {
    lines.push("", "## What changed", "");
    for (const note of proposal.notes) lines.push(`- ${note}`);
  }
  return lines.join("\n");
}

/** Strategic review: consistency with direction + readiness + integrity. */
export function renderReviewReport(project: Project): string {
  const lines: string[] = [`# Strategic review — ${project.meta.name}`, ""];
  lines.push("## Consistency with direction");
  lines.push(`- Vision: ${project.direction.vision || "_not defined_"}`);
  lines.push(`- Intent: ${project.direction.intent || "_not defined_"}`);
  lines.push(`- Values considered: ${project.direction.values.join(", ") || "_none_"}`);
  lines.push(`- Concepts: ${project.direction.concepts.map((concept) => concept.text).join("; ") || "_none_"}`);

  const activeGoals = project.goals.filter((goal) => goal.status === "ACTIVE");
  lines.push("", "## Goals");
  if (activeGoals.length === 0) lines.push("- _no active goals_");
  for (const goal of activeGoals) {
    const openLinked = project.questions.filter(
      (question) =>
        goal.questions.includes(question.id) && (question.status === "UNKNOWN" || question.status === "PARTIAL"),
    ).length;
    lines.push(`- ${goal.id} P${goal.priority} ${goal.title}${openLinked > 0 ? ` (${openLinked} open question(s))` : ""}`);
  }

  lines.push("", "## Most important unknowns");
  const open = byQuestionPriority(
    project.questions.filter((question) => question.status === "UNKNOWN" || question.status === "PARTIAL"),
  );
  if (open.length === 0) lines.push("- _none_");
  for (const question of open.slice(0, 5)) {
    lines.push(`- ${question.id} ${question.question} (confidence ${question.confidence.toFixed(2)})`);
  }

  lines.push("", "## Top risks");
  const risks = byRiskPriority(project.risks).slice(0, 5);
  if (risks.length === 0) lines.push("- _none_");
  for (const risk of risks) {
    lines.push(`- ${risk.id} ${risk.title} (exposure ${riskExposure(risk)}, ${risk.status})`);
  }

  const active = activePlan(project);
  lines.push("", "## Plan readiness");
  if (!active) {
    lines.push("- _no active plan_");
  } else {
    const stats = dagStats(active.nodes);
    const failed = active.nodes.filter((node) => node.status === "FAILED");
    lines.push(`- ${active.id} v${active.version}: ${active.title}`);
    lines.push(
      `- ${stats.ready} ready, ${stats.byStatus.COMPLETED} completed, ${failed.length} failed, ${stats.blocked} blocked`,
    );
    const ready = readyNodes(active.nodes).slice(0, 5);
    for (const node of ready) lines.push(`  - next: ${node.id} ${node.title}`);
    if (failed.length > 0) {
      lines.push("- failed work needs replanning:");
      for (const node of failed) lines.push(`  - ${node.id} ${node.title}: ${node.failureReason ?? "no reason"}`);
    }
  }

  const issues = validateProject(project);
  lines.push("", "## Validation");
  if (issues.length === 0) lines.push("- no issues");
  for (const issue of issues) lines.push(`- ${issue}`);

  lines.push("", "## Gate outcomes");
  const gates = project.plans.plans.flatMap((plan) => plan.gates);
  if (gates.length === 0) lines.push("- _no gates evaluated yet_");
  for (const gate of gates.slice(-10)) {
    lines.push(`- ${gate.at} ${gate.node} ${gate.outcome}${gate.notes ? `: ${gate.notes}` : ""}`);
  }

  lines.push("", "## Suggested outcome");
  const failed = active ? active.nodes.filter((node) => node.status === "FAILED").length : 0;
  if (failed > 0) lines.push("- REPLAN: failed work invalidates part of the current plan.");
  else if (issues.length > 0) lines.push("- REPLAN: fix the integrity issues above.");
  else if (open.length > 0) lines.push("- PASS (with caution): approach remains consistent; keep answering critical unknowns.");
  else lines.push("- PASS: approach remains consistent with direction and goals.");

  return lines.join("\n");
}

function activePlan(project: Project) {
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
