/**
 * Targeted context assembly (spec 24).
 *
 * Prefer the smallest set of project facts that is relevant to the current
 * work over dumping the entire project into the model. `buildDigest` is the
 * always-on orientation blurb; `buildTargetedContext` is for a specific task,
 * node, goal, question or risk.
 */

import { readyNodes, blockedByDependencies, runningNodes } from "./dag.ts";
import { budgetSummary } from "./limits.ts";
import { byQuestionPriority, byRiskPriority, priorityBand, scoreBand } from "./scoring.ts";
import { truncate } from "./format.ts";
import type { PlanNode, Project } from "./types.ts";

export interface ContextOptions {
  node?: string;
  goal?: string;
  question?: string;
  risk?: string;
  /** Free-text query used when no explicit entity is given. */
  query?: string;
  /** Soft cap on the size of the rendered context. */
  maxChars?: number;
  /** Include recent history entries. */
  history?: boolean;
}

const DEFAULT_MAX_CHARS = 6000;

/** Short orientation digest. Cheap enough to inject on every turn. */
export function buildDigest(project: Project): string {
  const active = activePlan(project);
  const topQuestion = byQuestionPriority(project.questions.filter((q) => q.status === "UNKNOWN" || q.status === "PARTIAL"))[0];
  const topRisk = byRiskPriority(project.risks)[0];
  const goals = project.goals.filter((goal) => goal.status === "ACTIVE");
  const lines: string[] = [];

  lines.push(`PROJECT: ${project.meta.name} (${project.meta.workspace ?? project.root})`);
  if (project.direction.vision) lines.push(`VISION: ${truncate(project.direction.vision, 300)}`);
  if (project.direction.values.length > 0) lines.push(`VALUES: ${truncate(project.direction.values.join(", "), 220)}`);
  if (project.direction.concepts.length > 0) {
    lines.push(`CONCEPTS: ${truncate(project.direction.concepts.map((concept) => `[${concept.type}] ${concept.text}`).join("; "), 260)}`);
  }
  lines.push(`STATE: ${project.state.current ? truncate(project.state.current, 300) : "not recorded"}`);
  if (goals.length > 0) {
    lines.push(`ACTIVE GOALS: ${goals.map((goal) => `${goal.id}(${priorityBand(goal.priority)}) ${truncate(goal.title, 60)}`).join("; ")}`);
  } else {
    lines.push("ACTIVE GOALS: none");
  }
  if (project.strategy.approach) lines.push(`STRATEGY: ${truncate(project.strategy.approach, 240)}`);
  if (topQuestion) lines.push(`TOP UNKNOWN: ${topQuestion.id} (${scoreBand(questionBand(topQuestion))}) ${truncate(topQuestion.question, 160)}`);
  if (topRisk) lines.push(`TOP RISK: ${topRisk.id} ${truncate(topRisk.title, 120)} [${topRisk.status}]`);
  if (active) {
    lines.push(`PLAN: ${active.id} v${active.version} — ${truncate(active.title, 80)}`);
    const readyAll = readyNodes(active.nodes);
    const ready = readyAll.slice(0, 4);
    // Never drop facts silently: a capped list says how much it hid and where to
    // read the rest, so the agent never believes it has seen the whole DAG.
    const more = readyAll.length - ready.length;
    if (ready.length > 0) {
      const hidden = more > 0 ? ` (+${more} more ready — /project plan)` : "";
      lines.push(`NEXT: ${ready.map((node) => `${node.id} ${truncate(node.title, 50)}`).join("; ")}${hidden}`);
    }
  } else {
    lines.push("PLAN: none");
  }
  lines.push(`YOLO: ${project.meta.yolo ? "on" : "off"}`);
  // A paused project says so, and says how to pick the thread back up.
  if (project.meta.paused) {
    const hint = project.meta.resumeNote ? ` — resume with: ${truncate(project.meta.resumeNote, 120)}` : "";
    lines.push(`PAUSED (${project.meta.pausedAt?.slice(0, 10) ?? "date unknown"})${hint} — do not start new work without asking`);
  }
  // Twitter-length budget: the agent writes short first time instead of being rejected.
  lines.push(`BUDGETS (over-budget writes are rejected): ${budgetSummary()}`);
  return lines.join("\n");
}

/** Context for a specific piece of work, with explicit relevance selection. */
export function buildTargetedContext(project: Project, options: ContextOptions = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const active = activePlan(project);
  const node = options.node ? active?.nodes.find((item) => item.id === options.node) : undefined;
  const goalId = options.goal ?? node?.goal ?? undefined;
  const questionId = options.question ?? node?.question ?? undefined;
  const riskId = options.risk ?? node?.risk ?? undefined;

  const relatedQuestionIds = new Set<string>();
  const relatedRiskIds = new Set<string>();

  if (goalId) {
    const goal = project.goals.find((item) => item.id === goalId);
    for (const id of goal?.questions ?? []) relatedQuestionIds.add(id);
    for (const id of goal?.risks ?? []) relatedRiskIds.add(id);
  }

  const parts: string[] = [];
  parts.push(buildDigest(project));

  if (options.query) {
    const scored = scoreEntities(project, options.query);
    if (scored.goals.length > 0) parts.push(`RELATED GOALS: ${scored.goals.map((g) => `${g.id} ${g.title}`).join("; ")}`);
    if (scored.questions.length > 0) {
      parts.push(
        `RELATED QUESTIONS:\n${scored.questions
          .map((q) => `- ${q.id} [${q.status}] ${q.question} — answer: ${q.answer || "unknown"}`)
          .join("\n")}`,
      );
    }
    if (scored.risks.length > 0) {
      parts.push(`RELATED RISKS:\n${scored.risks.map((r) => `- ${r.id} [${r.status}] ${r.title} (exposure ${(r.probability * r.impact).toFixed(2)})`).join("\n")}`);
    }
    if (scored.nodes.length > 0) {
      parts.push(`RELATED NODES:\n${scored.nodes.map((n) => `- ${n.id} [${n.status}] ${n.title}`).join("\n")}`);
    }
  }

  if (node) {
    parts.push(
      [
        `ACTIVE NODE: ${node.id} [${node.type}/${node.status}] ${node.title}`,
        node.description ? `description: ${node.description}` : null,
        node.dependsOn.length > 0 ? `depends on: ${node.dependsOn.join(", ")}` : null,
        node.gate ? `gate (${node.gate.type}): ${node.gate.criteria}` : null,
        node.outputs.length > 0 ? `outputs: ${node.outputs.join("; ")}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (goalId) {
    const goal = project.goals.find((item) => item.id === goalId);
    if (goal) {
      parts.push(
        [
          `GOAL ${goal.id} [${goal.status}] P${goal.priority}: ${goal.title}`,
          goal.description ? goal.description : null,
          goal.successCriteria.length > 0 ? `success criteria: ${goal.successCriteria.join("; ")}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  if (questionId) {
    const question = project.questions.find((item) => item.id === questionId);
    if (question) {
      parts.push(
        [
          `QUESTION ${question.id} [${question.status}] ${question.question}`,
          `answer: ${question.answer || "unknown"} (confidence ${question.confidence.toFixed(2)})`,
          question.evidence.length > 0 ? `evidence: ${question.evidence.map((e) => e.description).join("; ")}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  if (riskId) {
    const risk = project.risks.find((item) => item.id === riskId);
    if (risk) {
      parts.push(
        [
          `RISK ${risk.id} [${risk.status}] ${risk.title}`,
          `probability ${risk.probability.toFixed(2)} x impact ${risk.impact.toFixed(2)}`,
          risk.mitigation ? `mitigation: ${risk.mitigation}` : null,
          risk.contingency ? `contingency: ${risk.contingency}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  for (const id of relatedQuestionIds) {
    const question = project.questions.find((item) => item.id === id);
    if (question && question.id !== questionId) parts.push(`LINKED QUESTION ${question.id} [${question.status}] ${question.question}`);
  }
  for (const id of relatedRiskIds) {
    const risk = project.risks.find((item) => item.id === id);
    if (risk && risk.id !== riskId) parts.push(`LINKED RISK ${risk.id} [${risk.status}] ${risk.title}`);
  }

  if (active && (node || options.node)) {
    const ready = readyNodes(active.nodes).filter((item) => item.id !== node?.id).slice(0, 3);
    if (ready.length > 0) parts.push(`OTHER READY NODES: ${ready.map((item) => `${item.id} ${item.title}`).join("; ")}`);
  }

  if (options.history) {
    const recent = project.history.slice(-8);
    if (recent.length > 0) {
      parts.push(`RECENT HISTORY:\n${recent.map((event) => `- ${event.at} ${event.kind}: ${event.summary}`).join("\n")}`);
    }
  }

  return clampText(parts.join("\n\n"), maxChars);
}

/** Everything needed for a "resume after interruption" report (spec 16). */
export function buildResumeReport(project: Project): string {
  const active = activePlan(project);
  const lines: string[] = [`# Resume: ${project.meta.name}`, ""];
  lines.push(buildDigest(project), "");

  const interrupted = project.runs.filter((run) => run.status === "STARTED" || run.status === "RUNNING");
  lines.push("## Unfinished runs", "");
  if (interrupted.length === 0) lines.push("_none_");
  for (const run of interrupted) {
    lines.push(`- ${run.id} [${run.status}] ${run.title}${run.pid ? ` pid ${run.pid}` : ""}${run.node ? ` (node ${run.node})` : ""}`);
    const last = run.entries[run.entries.length - 1];
    if (last) lines.push(`    last log: ${last.at} ${last.text}`);
  }
  lines.push("");

  if (active) {
    const running = runningNodes(active.nodes);
    const ready = readyNodes(active.nodes);
    const blocked = blockedByDependencies(active.nodes);
    lines.push("## Execution state", "");
    lines.push(`plan ${active.id} v${active.version}`);
    lines.push(`running nodes: ${running.length > 0 ? running.map((node) => node.id).join(", ") : "none"}`);
    for (const node of running) {
      lines.push(`- RUNNING ${node.id} ${node.title}${node.run ? ` (run ${node.run})` : ""}`);
    }
    lines.push(`ready nodes: ${ready.length > 0 ? ready.map((node) => `${node.id} ${node.title}`).join("; ") : "none"}`);
    lines.push(`blocked nodes: ${blocked.length > 0 ? blocked.map((node) => node.id).join(", ") : "none"}`);
    const failed = active.nodes.filter((node) => node.status === "FAILED");
    if (failed.length > 0) {
      lines.push("failed nodes needing replan:");
      for (const node of failed) lines.push(`- ${node.id} ${node.title}: ${node.failureReason ?? "no reason recorded"}`);
    }
    lines.push("");
  }

  lines.push("## Next actions", "");
  if (active) {
    const next = readyNodes(active.nodes).slice(0, 5);
    if (next.length > 0) for (const node of next) lines.push(`- start ${node.id} ${node.title}`);
    for (const run of interrupted) lines.push(`- resolve run ${run.id} (mark completed/failed/interrupted)`);
  } else {
    lines.push("- no active plan: run project_replan or create a plan");
  }
  return lines.join("\n");
}

function activePlan(project: Project) {
  if (project.meta.activePlan) {
    const found = project.plans.plans.find((item) => item.id === project.meta.activePlan);
    if (found) return found;
  }
  if (project.plans.active) {
    const found = project.plans.plans.find((item) => item.id === project.plans.active);
    if (found) return found;
  }
  return project.plans.plans[project.plans.plans.length - 1];
}

function scoreEntities(project: Project, query: string): {
  goals: Project["goals"];
  questions: Project["questions"];
  risks: Project["risks"];
  nodes: PlanNode[];
} {
  const terms = tokenize(query);
  const match = (text: string): number => {
    const haystack = text.toLowerCase();
    return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
  };
  const top = <T>(items: T[], text: (item: T) => string, limit: number): T[] =>
    items
      .map((item) => ({ item, score: match(text(item)) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.item);

  const active = activePlan(project);
  return {
    goals: top(project.goals, (goal) => `${goal.title} ${goal.description}`, 3),
    questions: top(project.questions, (question) => `${question.question} ${question.answer}`, 4),
    risks: top(project.risks, (risk) => `${risk.title} ${risk.description}`, 3),
    nodes: top(active?.nodes ?? [], (node) => `${node.title} ${node.description}`, 4),
  };
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3);
}

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 60)}\n[... context truncated to ${maxChars} chars ...]`;
}

function questionBand(question: Project["questions"][number]): number {
  const uncertainty =
    question.status === "UNKNOWN" ? 1 : question.status === "PARTIAL" ? 0.6 : question.status === "ANSWERED" ? 0.3 : 0;
  return Math.min(1, Math.max(0, question.importance) * uncertainty * Math.max(0, question.decisionImpact));
}
