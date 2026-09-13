/**
 * TUI: the mandatory project dashboard (spec 22).
 *
 * A single scrollable browser with views for Dashboard, Direction, Goals,
 * State, Intelligence, Risks, Strategy, Plan/DAG, History, Runs and Summary.
 * It is intentionally plain text so it stays usable inside Pi's terminal.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { blockedByDependencies, dagStats, nextActionable, readyNodes, topoOrder } from "./dag.ts";
import { planEvolution } from "./history.ts";
import { byQuestionPriority, byRiskPriority, priorityBand, questionScore, riskExposure, scoreBand, riskScore } from "./scoring.ts";
import { PROJECT_DIR } from "./storage.ts";
import type { PlanNode, Project } from "./types.ts";

export interface ViewDefinition {
  id: string;
  title: string;
  render: (project: Project, theme: Theme, width: number) => string[];
}

/* ------------------------------------------------------------------ */
/* Views                                                              */
/* ------------------------------------------------------------------ */

function statusGlyph(status: string): string {
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
    case "ACTIVE":
      return "→";
    default:
      return "○";
  }
}

function bandColor(theme: Theme, band: string): (text: string) => string {
  switch (band) {
    case "CRITICAL":
      return (text) => theme.fg("error", text);
    case "HIGH":
      return (text) => theme.fg("warning", text);
    case "MEDIUM":
      return (text) => theme.fg("muted", text);
    default:
      return (text) => theme.fg("dim", text);
  }
}

function heading(theme: Theme, title: string, width: number): string[] {
  const label = theme.fg("accent", theme.bold(` ${title} `));
  // visibleWidth ignores ANSI escapes, unlike String#length, so the rule fits exactly.
  const remaining = Math.max(0, width - visibleWidth(label) - 3);
  return [theme.fg("borderMuted", "─".repeat(3)) + label + theme.fg("borderMuted", "─".repeat(remaining))];
}

/** Per-view count badges for the rail (index matches VIEWS order). */
export function viewCounts(project: Project): number[] {
  const openQuestions = project.questions.filter((question) => question.status === "UNKNOWN" || question.status === "PARTIAL").length;
  const openRisks = project.risks.filter((risk) => risk.status === "OPEN" || risk.status === "MITIGATING").length;
  const plan = activePlan(project);
  const runningRuns = project.runs.filter((run) => run.status === "RUNNING" || run.status === "STARTED").length;
  const activeGoals = project.goals.filter((goal) => goal.status === "ACTIVE").length;
  return [
    0, // Dashboard
    0, // Direction
    activeGoals, // Goals
    0, // State
    openQuestions, // Intelligence
    openRisks, // Risks
    0, // Strategy
    plan ? plan.nodes.length : 0, // Plan
    0, // History
    runningRuns || project.runs.length, // Runs
    0, // Summary
  ];
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

const dashboardView: ViewDefinition = {
  id: "dashboard",
  title: "Dashboard",
  render(project, theme, width) {
    const lines: string[] = [];
    const plan = activePlan(project);
    const stats = plan ? dagStats(plan.nodes) : null;
    const next = plan ? nextActionable(plan.nodes) : undefined;
    const openQuestions = byQuestionPriority(project.questions.filter((q) => q.status === "UNKNOWN" || q.status === "PARTIAL"));
    const topRisks = byRiskPriority(project.risks).filter((risk) => risk.status === "OPEN" || risk.status === "MITIGATING");
    const activeGoals = project.goals.filter((goal) => goal.status === "ACTIVE");
    const doneGoals = project.goals.filter((goal) => goal.status === "COMPLETED");
    const runningRuns = project.runs.filter((run) => run.status === "RUNNING" || run.status === "STARTED");

    // Identity + vision (one or two lines, no walls of text).
    lines.push(
      sectionHeader(theme, "VISION", `${project.goals.length} goals · ${project.plans.plans.length} plans`, width),
    );
    if (project.direction.vision) {
      lines.push(...truncateWrapped(project.direction.vision, width, 2).map((line) => `  ${theme.fg("muted", line)}`));
    } else {
      lines.push(`  ${theme.fg("dim", "no vision yet — press 2 or type /project edit direction")}`);
    }
    lines.push("");

    // NOW: the three things a human needs before acting.
    lines.push(sectionHeader(theme, "NOW", plan ? `${plan.id} v${plan.version}` : "no plan", width, "success"));
    if (next) {
      lines.push(`  ${theme.fg("success", "▶ next  ")}${theme.fg("text", truncateToWidth(`${next.id} ${next.title}`, width - 12))}`);
    } else if (plan) {
      lines.push(`  ${theme.fg("dim", "no actionable node — ask the agent to replan")}`);
    }
    lines.push(
      `  ${theme.fg("dim", "state ")}${theme.fg("text", truncateToWidth(project.state.current || "not recorded", width - 10))}` +
        (project.state.problems.length > 0 ? `  ${theme.fg("warning", `(${project.state.problems.length} problem${project.state.problems.length === 1 ? "" : "s"})`)}` : ""),
    );
    if (runningRuns.length > 0) {
      lines.push(
        `  ${theme.fg("dim", "runs  ")}${theme.fg("warning", `${runningRuns.length} in progress`)} ${theme.fg("muted", truncateToWidth(runningRuns.map((run) => run.id).join(", "), width - 24))}`,
      );
    }
    lines.push("");

    // PROGRESS: numbers, not lists.
    lines.push(sectionHeader(theme, "PROGRESS", "", width, "muted"));
    if (plan && stats) {
      const barWidth = Math.max(8, Math.min(20, width - 46));
      const filled = stats.total === 0 ? 0 : Math.round((stats.byStatus.COMPLETED / stats.total) * barWidth);
      lines.push(
        `  ${theme.fg("dim", "plan  ")}${theme.fg("success", "█".repeat(filled))}${theme.fg("dim", "░".repeat(barWidth - filled))}` +
          `  ${theme.fg("muted", `${stats.byStatus.COMPLETED}/${stats.total}`)}${theme.fg("dim", ` · ${stats.ready} ready · ${stats.byStatus.BLOCKED + stats.byStatus.INTERRUPTED} blocked`)}`,
      );
    } else {
      lines.push(`  ${theme.fg("dim", "plan  none yet")}`);
    }
    lines.push(
      `  ${theme.fg("dim", "goals ")}${theme.fg("text", `${doneGoals.length}/${project.goals.length}`)}` +
        `${theme.fg("dim", " done")}  ${theme.fg("dim", "·")}  ` +
        `${theme.fg("dim", "open questions ")}${theme.fg(openQuestions.length > 0 ? "warning" : "text", String(openQuestions.length))}  ` +
        `${theme.fg("dim", "·")}  ${theme.fg("dim", "open risks ")}${theme.fg(topRisks.length > 0 ? "warning" : "text", String(topRisks.length))}`,
    );
    lines.push("");

    // SIGNALS: only the top few, with a pointer to the full view.
    lines.push(sectionHeader(theme, "SIGNALS", "top of each list", width, "warning"));
    const signals: string[] = [];
    for (const question of openQuestions.slice(0, 2)) {
      const band = scoreBand(questionScore(question));
      signals.push(`  ${bandColor(theme, band)("?")} ${theme.fg("text", truncateToWidth(`${question.id} ${question.question}`, width - 16))} ${bandColor(theme, band)(band)}`);
    }
    for (const risk of topRisks.slice(0, 2)) {
      const band = scoreBand(riskScore(risk));
      signals.push(`  ${bandColor(theme, band)("!")} ${theme.fg("text", truncateToWidth(`${risk.id} ${risk.title}`, width - 22))} ${theme.fg("dim", `exposure ${riskExposure(risk)}`)}`);
    }
    for (const goal of activeGoals.slice(0, 2)) {
      signals.push(`  ${theme.fg("accent", "→")} ${theme.fg("text", truncateToWidth(`${goal.id} ${goal.title}`, width - 22))} ${theme.fg("dim", `P${goal.priority} ${priorityBand(goal.priority)}`)}`);
    }
    if (signals.length === 0) lines.push(`  ${theme.fg("dim", "nothing recorded yet — ask the agent to set goals, questions and risks")}`);
    lines.push(...signals);

    const hints: string[] = [];
    if (activeGoals.length > 0 || project.goals.length > 0) hints.push("3 goals");
    if (project.questions.length > 0) hints.push("5 intelligence");
    if (project.risks.length > 0) hints.push("6 risks");
    if (plan) hints.push("8 plan");
    if (hints.length > 0) {
      lines.push("");
      lines.push(`  ${theme.fg("dim", `full lists: ${hints.join(" · ")} · ? help`)}`);
    }
    return lines;
  },
};

/** Wrap prose to at most `maxLines` lines, adding an ellipsis when truncated. */
function truncateWrapped(text: string, width: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= width - 2) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && current !== "") lines.push(current);
  const clipped = lines.slice(0, maxLines);
  if (clipped.length === maxLines && words.join(" ").length > clipped.join(" ").length) {
    clipped[maxLines - 1] = `${clipped[maxLines - 1]!.slice(0, Math.max(0, width - 4))}…`;
  }
  return clipped;
}

const directionView: ViewDefinition = {
  id: "direction",
  title: "Direction",
  render(project, theme, width) {
    const lines: string[] = [];
    lines.push(...heading(theme, "VISION", width));
    lines.push(theme.fg("text", project.direction.vision || "not defined"));
    lines.push(...heading(theme, "INTENT", width));
    lines.push(theme.fg("text", project.direction.intent || "not defined"));
    lines.push(...heading(theme, "VALUES", width));
    if (project.direction.values.length === 0) lines.push(theme.fg("dim", "none"));
    for (const value of project.direction.values) lines.push(`${theme.fg("accent", "•")} ${theme.fg("text", value)}`);
    lines.push(...heading(theme, "CONCEPTS", width));
    if (project.direction.concepts.length === 0) lines.push(theme.fg("dim", "none"));
    for (const concept of project.direction.concepts) {
      lines.push(`${theme.fg("accent", "•")} ${theme.fg("muted", `[${concept.type}]`)} ${theme.fg("text", concept.text)}`);
    }
    return lines;
  },
};

const GOAL_GROUPS: Array<{ label: string; statuses: string[]; tone: "accent" | "success" | "muted" }> = [
  { label: "ACTIVE", statuses: ["ACTIVE"], tone: "accent" },
  { label: "COMPLETED", statuses: ["COMPLETED"], tone: "success" },
  { label: "NOT PURSUED", statuses: ["FAILED", "ABANDONED", "SUPERSEDED"], tone: "muted" },
];

const goalsView: ViewDefinition = {
  id: "goals",
  title: "Goals",
  render(project, theme, width) {
    if (project.goals.length === 0) {
      return [`  ${theme.fg("dim", "no goals yet")}`, `  ${theme.fg("dim", "press e to add one, or ask the agent")}`];
    }
    const lines: string[] = [];
    for (const group of GOAL_GROUPS) {
      const goals = project.goals
        .filter((goal) => group.statuses.includes(goal.status))
        .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id, undefined, { numeric: true }));
      if (goals.length === 0) continue;
      lines.push(sectionHeader(theme, group.label, `${goals.length}/${project.goals.length}`, width, group.tone));
      for (const goal of goals) {
        const band = priorityBand(goal.priority);
        const head = `  ${theme.fg(group.tone === "muted" ? "dim" : group.tone, statusGlyph(goal.status))} ${theme.fg("muted", goal.id.padEnd(4))}`;
        const meta = `${band.padEnd(8)} P${goal.priority}`;
        const available = Math.max(10, width - visibleWidth(head) - meta.length - 8);
        const title = goal.title.length > available ? `${goal.title.slice(0, available - 1)}…` : goal.title;
        const extra = goal.successCriteria.length > 0 ? `${goal.successCriteria.length} criteria` : "no criteria";
        lines.push(
          truncateToWidth(
            `${head}${theme.fg("text", title)}${" ".repeat(Math.max(1, width - visibleWidth(head) - visibleWidth(title) - meta.length - 2))}${bandColor(theme, band)(band)} ${theme.fg("dim", `P${goal.priority} · ${extra}`)}`,
            width,
          ),
        );
        if (goal.supersededBy) lines.push(`       ${theme.fg("dim", `superseded by ${goal.supersededBy}`)}`);
      }
      lines.push("");
    }
    lines.push(`  ${theme.fg("dim", "press e on this view to edit or add a goal")}`);
    return lines;
  },
};

const riskGroups: Array<{ label: string; statuses: string[]; tone: "warning" | "success" | "muted" }> = [
  { label: "OPEN", statuses: ["OPEN", "MITIGATING"], tone: "warning" },
  { label: "OCCURRED", statuses: ["OCCURRED"], tone: "warning" },
  { label: "CLOSED", statuses: ["RESOLVED", "ACCEPTED", "CLOSED"], tone: "muted" },
];

const stateView: ViewDefinition = {
  id: "state",
  title: "State",
  render(project, theme, width) {
    const lines: string[] = [];
    const list = (
      title: string,
      items: string[],
      tone: "accent" | "success" | "warning" | "muted",
      cap = 4,
    ): void => {
      if (items.length === 0) return;
      lines.push(sectionHeader(theme, title, `${items.length}`, width, tone));
      for (const item of items.slice(0, cap)) {
        lines.push(`  ${theme.fg("accent", "· ")}${theme.fg("muted", truncateToWidth(item, width - 6))}`);
      }
      if (items.length > cap) lines.push(`  ${theme.fg("dim", `… +${items.length - cap} more`)}`);
    };

    lines.push(sectionHeader(theme, "CURRENT", "", width, "accent"));
    lines.push(...truncateWrapped(project.state.current || "not recorded", width, 4).map((line) => `  ${theme.fg("text", line)}`));
    list("PROBLEMS", project.state.problems, "warning");
    list("CAPABILITIES", project.state.capabilities, "success");
    list("KNOWN FACTS", project.state.facts, "muted");
    list("CONSTRAINTS", project.state.constraints, "muted");
    list("DISCOVERIES", project.state.discoveries, "success");
    lines.push(sectionHeader(theme, "INITIAL", "", width, "muted"));
    lines.push(...truncateWrapped(project.state.initial || "not recorded", width, 2).map((line) => `  ${theme.fg("dim", line)}`));
    lines.push(`  ${theme.fg("dim", "press e to edit the state")}`);
    return lines;
  },
};

const intelligenceView: ViewDefinition = {
  id: "intelligence",
  title: "Intelligence",
  render(project, theme, width) {
    if (project.questions.length === 0) {
      return [`  ${theme.fg("dim", "no questions yet")}`, `  ${theme.fg("dim", "press e to add one, or ask the agent what we don't know")}`];
    }
    const lines: string[] = [];
    const open = byQuestionPriority(project.questions.filter((q) => q.status === "UNKNOWN" || q.status === "PARTIAL"));
    const answered = byQuestionPriority(project.questions.filter((q) => q.status === "ANSWERED"));
    const settled = byQuestionPriority(project.questions.filter((q) => q.status === "CONFIRMED" || q.status === "INVALIDATED"));

    const group = (label: string, questions: typeof open, tone: "warning" | "success" | "muted"): void => {
      if (questions.length === 0) return;
      lines.push(sectionHeader(theme, label, `${questions.length}`, width, tone));
      for (const question of questions) {
        const band = scoreBand(questionScore(question));
        const head = `  ${bandColor(theme, band)("?")} ${theme.fg("muted", question.id.padEnd(4))}`;
        const available = Math.max(10, width - visibleWidth(head) - band.length - question.status.length - 8);
        const title = question.question.length > available ? `${question.question.slice(0, available - 1)}…` : question.question;
        lines.push(
          truncateToWidth(`${head}${theme.fg("text", title)}  ${bandColor(theme, band)(band)} ${theme.fg("dim", question.status)}`, width),
        );
      }
      lines.push("");
    };
    group("OPEN", open, "warning");
    group("ANSWERED", answered, "success");
    group("SETTLED", settled, "muted");
    lines.push(`  ${theme.fg("dim", "press e on this view to edit or add a question")}`);
    return lines;
  },
};

const risksView: ViewDefinition = {
  id: "risks",
  title: "Risks",
  render(project, theme, width) {
    if (project.risks.length === 0) {
      return [`  ${theme.fg("dim", "no risks yet")}`, `  ${theme.fg("dim", "press e to add one, or ask the agent how this could fail")}`];
    }
    const lines: string[] = [];
    for (const group of riskGroups) {
      const risks = byRiskPriority(project.risks.filter((risk) => group.statuses.includes(risk.status)));
      if (risks.length === 0) continue;
      lines.push(sectionHeader(theme, group.label, `${risks.length}`, width, group.tone));
      for (const risk of risks) {
        const band = scoreBand(riskScore(risk));
        const head = `  ${group.tone === "warning" ? bandColor(theme, band)("!") : theme.fg("dim", "·")} ${theme.fg("muted", risk.id.padEnd(4))}`;
        const meta = `exposure ${riskExposure(risk).toFixed(2)}`;
        const available = Math.max(10, width - visibleWidth(head) - meta.length - band.length - 6);
        const title = risk.title.length > available ? `${risk.title.slice(0, available - 1)}…` : risk.title;
        lines.push(
          truncateToWidth(`${head}${theme.fg("text", title)}  ${bandColor(theme, band)(band)} ${theme.fg("dim", `exp ${riskExposure(risk).toFixed(2)} · ${risk.status}`)}`, width),
        );
      }
      lines.push("");
    }
    lines.push(`  ${theme.fg("dim", "press e on this view to edit or add a risk")}`);
    return lines;
  },
};

const strategyView: ViewDefinition = {
  id: "strategy",
  title: "Strategy",
  render(project, theme, width) {
    const lines: string[] = [];
    lines.push(...heading(theme, "CURRENT APPROACH", width));
    lines.push(theme.fg("text", project.strategy.approach || "not defined"));
    const list = (title: string, items: string[]): void => {
      if (items.length === 0) return;
      lines.push(...heading(theme, title.toUpperCase(), width));
      for (const item of items) lines.push(`${theme.fg("accent", "•")} ${theme.fg("muted", item)}`);
    };
    list("Strategic hypotheses", project.strategy.hypotheses);
    list("Priorities", project.strategy.priorities);
    list("Alternatives considered", project.strategy.alternatives);
    if (project.strategy.rationale) {
      lines.push(...heading(theme, "RATIONALE", width));
      lines.push(theme.fg("muted", project.strategy.rationale));
    }
    return lines;
  },
};

const planView: ViewDefinition = {
  id: "plan",
  title: "Plan / DAG",
  render: (project, theme, width) => renderPlanInteractive(project, theme, width, null).lines,
};

/* ------------------------------------------------------------------ */
/* Plan browser (master / detail)                                     */
/* ------------------------------------------------------------------ */

const NODE_TYPE_ABBREVIATIONS: Record<string, string> = {
  TASK: "TASK",
  INVESTIGATION: "INVE",
  EXPERIMENT: "EXPE",
  DECISION: "DECI",
  REVIEW: "REVI",
  GATE: "GATE",
  WAIT: "WAIT",
};

export interface PlanGroup {
  key: string;
  label: string;
  tone: "accent" | "success" | "warning" | "muted";
  nodes: PlanNode[];
  hidden: number;
}

/** Group the active plan's nodes by what the user can do with them (spec 12). */
export function planGroups(project: Project, cap = 6): PlanGroup[] {
  const plan = activePlan(project);
  if (!plan) return [];
  const readyIds = new Set(readyNodes(plan.nodes).map((node) => node.id));
  const blocked = blockedByDependencies(plan.nodes);

  const groups: PlanGroup[] = [
    { key: "running", label: "RUNNING", tone: "accent", nodes: [], hidden: 0 },
    { key: "ready", label: "READY", tone: "success", nodes: [], hidden: 0 },
    { key: "blocked", label: "BLOCKED", tone: "warning", nodes: [], hidden: 0 },
    { key: "finished", label: "FINISHED", tone: "muted", nodes: [], hidden: 0 },
  ];
  const byKey = new Map(groups.map((group) => [group.key, group]));

  for (const node of topoOrder(plan.nodes)) {
    if (node.status === "RUNNING") byKey.get("running")!.nodes.push(node);
    else if (readyIds.has(node.id)) byKey.get("ready")!.nodes.push(node);
    else if (node.status === "PENDING" || node.status === "BLOCKED" || node.status === "INTERRUPTED") {
      byKey.get("blocked")!.nodes.push(node);
    } else byKey.get("finished")!.nodes.push(node);
  }
  void blocked;

  for (const group of groups) {
    if (group.nodes.length > cap) {
      group.hidden = group.nodes.length - cap;
      group.nodes = group.nodes.slice(0, cap);
    }
  }
  return groups.filter((group) => group.nodes.length > 0);
}

/** Nodes in visual order, used for cursor movement. */
export function flatPlanNodes(project: Project): PlanNode[] {
  return planGroups(project).flatMap((group) => group.nodes);
}

export interface PlanRender {
  lines: string[];
  /** Visible node ids in order, so the caller can move a cursor. */
  ids: string[];
}

/**
 * A scannable DAG: status groups with counts, one line per node, and a detail
 * pane for the selected node. Nothing is hidden behind raw YAML.
 */
export function renderPlanInteractive(
  project: Project,
  theme: Theme,
  width: number,
  cursor: string | null,
): PlanRender {
  const plan = activePlan(project);
  if (!plan) {
    return { lines: [theme.fg("dim", "no active plan yet"), "", theme.fg("dim", "the agent can create one when you ask for a plan")], ids: [] };
  }
  const groups = planGroups(project);
  const ids = groups.flatMap((group) => group.nodes.map((node) => node.id));
  const activeId = cursor && ids.includes(cursor) ? cursor : ids[0] ?? null;
  const stats = dagStats(plan.nodes);

  const lines: string[] = [];
  const done = stats.byStatus.COMPLETED;
  const barWidth = Math.max(8, Math.min(24, width - 34));
  const filled = stats.total === 0 ? 0 : Math.round((done / stats.total) * barWidth);
  lines.push(
    theme.fg("accent", theme.bold(`${plan.id} v${plan.version}`)) +
      theme.fg("muted", `  ${plan.title}`) +
      theme.fg("success", `  ${"█".repeat(filled)}`) +
      theme.fg("dim", `${"░".repeat(barWidth - filled)} ${done}/${stats.total}`),
  );
  lines.push(theme.fg("dim", `${stats.ready} ready · ${stats.byStatus.RUNNING} running · ${stats.blocked} blocked · ${stats.byStatus.COMPLETED} done · ${stats.byStatus.FAILED} failed`));
  lines.push("");

  for (const group of groups) {
    lines.push(sectionHeader(theme, group.label, `${group.nodes.length + group.hidden}`, width, group.tone));
    for (const node of group.nodes) {
      lines.push(planNodeLine(theme, node, width, node.id === activeId));
    }
    if (group.hidden > 0) lines.push(`     ${theme.fg("dim", `… +${group.hidden} more (folded; use the agent or the form to see them)`)}`);
  }

  const selected = activeId ? plan.nodes.find((node) => node.id === activeId) : undefined;
  if (selected) lines.push("", ...renderPlanDetail(theme, project, selected, width));

  return { lines, ids };
}

function planNodeLine(theme: Theme, node: PlanNode, width: number, selected: boolean): string {
  const marker = selected ? theme.fg("accent", "▸ ") : "  ";
  const glyph = theme.fg(node.status === "COMPLETED" ? "success" : node.status === "FAILED" ? "error" : node.status === "RUNNING" ? "accent" : "dim", statusGlyph(node.status));
  const id = theme.fg(selected ? "accent" : "muted", node.id.padEnd(4));
  const type = theme.fg("dim", (NODE_TYPE_ABBREVIATIONS[node.type] ?? node.type).padEnd(5));

  const badges: string[] = [];
  if (node.question) badges.push(node.question);
  if (node.risk) badges.push(node.risk);
  if (node.goal) badges.push(node.goal);
  if (node.dependsOn.length > 0) badges.push(`←${node.dependsOn.join(",")}`);
  const badgeText = badges.length > 0 ? ` ${badges.join(" ")}` : "";

  const head = `${marker}${glyph} ${id}${type} `;
  const available = Math.max(8, width - visibleWidth(head) - visibleWidth(badgeText) - 2);
  const title = node.title.length > available ? `${node.title.slice(0, available - 1)}…` : node.title;
  const body = selected ? theme.fg("text", title) : theme.fg("muted", title);
  const fill = " ".repeat(Math.max(1, available - visibleWidth(title) + 1));
  const badgesStyled = badges.length > 0 ? theme.fg("dim", `${fill}${badges.join(" ")}`) : "";
  return truncateToWidth(`${head}${body}${badgesStyled}`, width);
}

function renderPlanDetail(theme: Theme, project: Project, node: PlanNode, width: number): string[] {
  const lines: string[] = [];
  lines.push(sectionHeader(theme, `SELECTED ${node.id}`, `${node.type} · ${node.status}`, width, "accent"));
  if (node.description) lines.push(`  ${theme.fg("muted", truncateToWidth(node.description.replace(/\s+/g, " "), width - 4))}`);
  const meta: string[] = [];
  if (node.assignee) meta.push(`assignee ${node.assignee}`);
  if (node.dependsOn.length > 0) {
    const plan = activePlan(project);
    const described = node.dependsOn.map((dep) => {
      const target = plan?.nodes.find((candidate) => candidate.id === dep);
      return `${dep}${target ? ` (${target.status})` : " (missing)"}`;
    });
    meta.push(`after ${described.join(", ")}`);
  } else {
    meta.push("no dependencies");
  }
  lines.push(`  ${theme.fg("dim", meta.join("  ·  "))}`);
  const links: string[] = [];
  if (node.question) links.push(`question ${node.question}`);
  if (node.risk) links.push(`risk ${node.risk}`);
  if (node.goal) links.push(`goal ${node.goal}`);
  if (node.run) links.push(`run ${node.run}`);
  if (node.gate) links.push(`gate ${node.gate.type}`);
  if (links.length > 0) lines.push(`  ${theme.fg("muted", links.join("  ·  "))}`);
  if (node.gate?.criteria) lines.push(`  ${theme.fg("muted", `criteria: ${truncateToWidth(node.gate.criteria, width - 15)}`)}`);
  if (node.failureReason) lines.push(`  ${theme.fg("error", `failure: ${truncateToWidth(node.failureReason, width - 12)}`)}`);
  if (node.outputs.length > 0) lines.push(`  ${theme.fg("success", `outputs: ${truncateToWidth(node.outputs.join("; "), width - 12)}`)}`);
  lines.push(`  ${theme.fg("dim", "↑↓ select · enter edit · a new node · D delete · E raw yaml")}`);
  return lines;
}

/** `▌ TITLE   meta` — lighter and more structured than a full-width rule. */
export function sectionHeader(
  theme: Theme,
  title: string,
  meta: string,
  width: number,
  tone: "accent" | "success" | "warning" | "muted" = "accent",
): string {
  const left = theme.fg(tone, "▌") + " " + theme.fg(tone, theme.bold(title));
  const right = meta ? theme.fg("dim", meta) : "";
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 1);
  return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width);
}

const historyView: ViewDefinition = {
  id: "history",
  title: "History",
  render(project, theme) {
    const lines: string[] = [];
    if (project.history.length === 0) return [theme.fg("dim", "nothing recorded yet")];
    for (const event of [...project.history].reverse().slice(0, 200)) {
      const color =
        event.kind.includes("fail") || event.kind.includes("abandon")
          ? "error"
          : event.kind.includes("completed") || event.kind.includes("passed") || event.kind.includes("answered")
            ? "success"
            : event.kind.includes("plan")
              ? "accent"
              : "muted";
      const refs = event.refs.length > 0 ? ` ${theme.fg("dim", `[${event.refs.join(", ")}]`)}` : "";
      lines.push(`${theme.fg("dim", event.at.slice(0, 19))} ${theme.fg(color as "muted", event.kind)} ${theme.fg("text", event.summary)}${refs}`);
    }
    return lines;
  },
};

const runsView: ViewDefinition = {
  id: "runs",
  title: "Runs",
  render(project, theme) {
    if (project.runs.length === 0) return [theme.fg("dim", "no runs recorded")];
    const lines: string[] = [];
    for (const run of [...project.runs].reverse()) {
      lines.push(
        `${theme.fg("accent", statusGlyph(run.status === "RUNNING" ? "RUNNING" : run.status))} ${theme.fg("text", theme.bold(`${run.id} ${run.title}`))} ${theme.fg("dim", run.status)}`,
      );
      const meta: string[] = [`started ${run.started}`];
      if (run.finished) meta.push(`finished ${run.finished}`);
      if (run.node) meta.push(`node ${run.node}`);
      if (run.pid) meta.push(`pid ${run.pid}`);
      if (run.host) meta.push(`host ${run.host}`);
      lines.push(`    ${theme.fg("dim", meta.join(" · "))}`);
      if (run.command) lines.push(`    ${theme.fg("muted", `$ ${run.command}`)}`);
      for (const environment of run.environment) {
        lines.push(`    ${theme.fg("dim", `env ${environment.kind}: ${environment.target}${environment.note ? ` (${environment.note})` : ""}`)}`);
      }
      for (const entry of run.entries.slice(-3)) {
        lines.push(`    ${theme.fg("dim", `${entry.at.slice(11, 19)} [${entry.kind}]`)} ${theme.fg("muted", entry.text)}`);
      }
      for (const output of run.outputs.slice(-3)) {
        lines.push(`    ${theme.fg("success", "→")} ${theme.fg("muted", output.description)}`);
      }
    }
    return lines;
  },
};

const summaryView: ViewDefinition = {
  id: "summary",
  title: "Summary",
  render(project, theme, width) {
    const lines: string[] = [];
    lines.push(...heading(theme, "GOAL OUTCOMES", width));
    if (project.goals.length === 0) lines.push(theme.fg("dim", "no goals"));
    for (const goal of project.goals) {
      const glyph = statusGlyph(goal.status);
      const color = goal.status === "COMPLETED" ? "success" : goal.status === "FAILED" ? "error" : "muted";
      lines.push(`${theme.fg(color as "muted", glyph)} ${theme.fg("text", `${goal.id} ${goal.title}`)} ${theme.fg("dim", goal.status)}`);
    }

    lines.push(...heading(theme, "PLAN EVOLUTION", width));
    const evolution = planEvolution(project);
    if (evolution.length === 0) lines.push(theme.fg("dim", "no plans"));
    for (const entry of evolution) {
      lines.push(`${theme.fg("accent", "•")} ${theme.fg("text", `${entry.plan} v${entry.version} — ${entry.title}`)}`);
      if (entry.change) lines.push(`    ${theme.fg("muted", `why: ${entry.change.reason}`)}`);
      if (entry.supersededBy) lines.push(`    ${theme.fg("dim", `superseded by ${entry.supersededBy}`)}`);
    }

    lines.push(...heading(theme, "MAJOR DECISIONS", width));
    if (project.decisions.length === 0) lines.push(theme.fg("dim", "no decisions"));
    for (const decision of project.decisions) {
      lines.push(
        `${theme.fg("accent", "•")} ${theme.fg("text", `${decision.id} ${decision.title}`)} ${theme.fg("dim", `[${decision.authority}${decision.autoAccepted ? ", auto" : ""}]`)}`,
      );
    }

    lines.push(...heading(theme, "LESSONS / FINDINGS", width));
    const findings = [...project.state.discoveries, ...project.questions.filter((question) => question.status === "CONFIRMED").map((question) => question.answer)];
    if (findings.length === 0) lines.push(theme.fg("dim", "none recorded"));
    for (const finding of findings) lines.push(`${theme.fg("accent", "•")} ${theme.fg("muted", finding)}`);
    return lines;
  },
};

const RAW_VIEWS: ViewDefinition[] = [
  dashboardView,
  directionView,
  goalsView,
  stateView,
  intelligenceView,
  risksView,
  strategyView,
  planView,
  historyView,
  runsView,
  summaryView,
];

export const VIEWS: ViewDefinition[] = RAW_VIEWS.map((view) => ({
  ...view,
  render: (project, theme, width) => fitLines(view.render(project, theme, width), width),
}));

/** Guarantee the Component contract: no rendered line may exceed `width`. */
function fitLines(lines: string[], width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  return lines
    .flatMap((line) => wrapTextWithAnsi(line, safeWidth))
    .map((line) => truncateToWidth(line, safeWidth));
}

function computeDepths(nodes: { id: string; dependsOn: string[] }[]): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depths = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const node = byId.get(id);
    if (!node || node.dependsOn.length === 0) {
      depths.set(id, 0);
      return 0;
    }
    const depth = Math.max(...node.dependsOn.map((dep) => visit(dep, seen) + 1));
    depths.set(id, depth);
    return depth;
  };
  for (const node of nodes) visit(node.id, new Set());
  return depths;
}

/* ------------------------------------------------------------------ */
/* Browser component                                                  */
/* ------------------------------------------------------------------ */

export interface ProjectBrowserOptions {
  project: Project;
  theme: Theme;
  onClose: () => void;
  /** Reload the project from disk (used by the r key). */
  reload?: () => Promise<Project>;
  initialView?: string;
  /** Live terminal height in rows; used to size the scroll viewport. */
  getTerminalRows?: () => number;
  /** Called when the component's state changed and needs a repaint. */
  onChange?: () => void;
  /** Reference text shown when the user presses `?`. */
  helpText?: string;
  /** Dashboard views that can be edited with `e`. */
  editableViews?: string[];
  /** Called when the user presses `e` (form) or `E` (raw text) on an editable view. */
  onRequestEdit?: (view: string, raw?: boolean) => void;
  /** Called for plan-specific actions (edit/new/delete a node). */
  onPlanAction?: (action: { kind: "edit" | "new" | "delete"; id?: string }) => void;
  /** Node id to preselect when opening the plan view. */
  initialCursor?: string;
}

/** Minimum number of body rows (chrome is title + rail + footer). */
const MIN_VIEWPORT = 3;
const CHROME_LINES = 3;

export class ProjectBrowser {
  private project: Project;
  private theme: Theme;
  private onClose: () => void;
  private reload?: () => Promise<Project>;
  private getTerminalRows?: () => number;
  private onChange?: () => void;
  private helpText?: string;
  private helpVisible = false;
  private editableViews: Set<string>;
  private onRequestEdit?: (view: string, raw?: boolean) => void;
  private onPlanAction?: (action: { kind: "edit" | "new" | "delete"; id?: string }) => void;
  private planCursor: string | null;
  private viewIndex = 0;
  private scroll = 0;
  private cachedWidth = -1;
  private notice: string | null = null;

  constructor(options: ProjectBrowserOptions) {
    this.project = options.project;
    this.theme = options.theme;
    this.onClose = options.onClose;
    this.reload = options.reload;
    this.getTerminalRows = options.getTerminalRows;
    this.onChange = options.onChange;
    this.helpText = options.helpText;
    this.editableViews = new Set(options.editableViews ?? []);
    this.onRequestEdit = options.onRequestEdit;
    this.onPlanAction = options.onPlanAction;
    this.planCursor = options.initialCursor ?? null;
    const index = options.initialView ? VIEWS.findIndex((view) => view.id === options.initialView) : 0;
    this.viewIndex = index >= 0 ? index : 0;
  }

  get currentView(): string {
    return VIEWS[this.viewIndex]!.id;
  }

  /** How many body rows fit, leaving room for our chrome and Pi's own status rows. */
  private viewportHeight(): number {
    const rows = this.getTerminalRows?.() ?? 24;
    // Leave 3 rows for Pi's status/footer area so the dock never has to clip us.
    return Math.max(MIN_VIEWPORT, Math.min(60, rows - CHROME_LINES - 3));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      // Escape first leaves the help screen, so `?` is never a trap.
      if (matchesKey(data, "escape") && this.helpVisible) {
        this.helpVisible = false;
        this.onChange?.();
        return;
      }
      this.onClose();
      return;
    }
    if (matchesKey(data, "?") && this.helpText) {
      this.helpVisible = !this.helpVisible;
      this.scroll = 0;
      this.onChange?.();
      return;
    }
    if (!this.helpVisible && this.currentView === "plan" && this.onPlanAction) {
      const nodes = flatPlanNodes(this.project);
      const index = Math.max(0, nodes.findIndex((node) => node.id === this.planCursor));
      if (nodes.length > 0) this.planCursor = nodes[index]?.id ?? nodes[0]!.id;
      if (matchesKey(data, "down") || data === "j") {
        const next = nodes[Math.min(nodes.length - 1, index + 1)];
        if (next) this.planCursor = next.id;
        this.onChange?.();
        return;
      }
      if (matchesKey(data, "up") || data === "k") {
        const previous = nodes[Math.max(0, index - 1)];
        if (previous) this.planCursor = previous.id;
        this.onChange?.();
        return;
      }
      if (matchesKey(data, "enter") || matchesKey(data, "e")) {
        if (this.planCursor) this.onPlanAction({ kind: "edit", id: this.planCursor });
        return;
      }
      if (data === "a") {
        this.onPlanAction({ kind: "new" });
        return;
      }
      if (matchesKey(data, "shift+d")) {
        if (this.planCursor) this.onPlanAction({ kind: "delete", id: this.planCursor });
        return;
      }
    }

    if (
      !this.helpVisible &&
      this.onRequestEdit &&
      this.editableViews.has(this.currentView) &&
      (matchesKey(data, "e") || matchesKey(data, "shift+e"))
    ) {
      this.onRequestEdit(this.currentView, matchesKey(data, "shift+e"));
      return;
    }
    if (this.helpVisible) {
      // While help is open only the scroll keys below apply.
      if (matchesKey(data, "tab") || matchesKey(data, "left") || matchesKey(data, "right") || /^([1-9])$/.test(data)) {
        return;
      }
    } else if (matchesKey(data, "tab") || matchesKey(data, "right") || matchesKey(data, "l")) {
      this.viewIndex = (this.viewIndex + 1) % VIEWS.length;
      this.scroll = 0;
      return;
    } else if (matchesKey(data, "shift+tab") || matchesKey(data, "left") || matchesKey(data, "h")) {
      this.viewIndex = (this.viewIndex - 1 + VIEWS.length) % VIEWS.length;
      this.scroll = 0;
      return;
    } else {
      const digit = /^([1-9])$/.exec(data);
      if (digit) {
        const target = Number.parseInt(digit[1]!, 10) - 1;
        if (target < VIEWS.length) {
          this.viewIndex = target;
          this.scroll = 0;
        }
        return;
      }
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scroll += 1;
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scroll = Math.max(0, this.scroll - 1);
      return;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "space")) {
      this.scroll += 10;
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "b")) {
      this.scroll = Math.max(0, this.scroll - 10);
      return;
    }
    if (matchesKey(data, "g")) {
      this.scroll = 0;
      return;
    }
    if (matchesKey(data, "shift+g")) {
      this.scroll = Number.MAX_SAFE_INTEGER;
      return;
    }
    if (matchesKey(data, "r") && !this.helpVisible && this.reload) {
      void this.reload()
        .then((project) => {
          this.project = project;
          this.notice = `reloaded ${new Date().toISOString().slice(11, 19)}`;
        })
        .catch((error: unknown) => {
          this.notice = `reload failed: ${(error as Error).message}`;
        })
        .finally(() => this.onChange?.());
      return;
    }
  }

  /**
   * One-line view rail with a count badge per view, so the chrome shows where
   * the activity is without growing into a second line.
   */
  private tabLine(width: number): string {
    const theme = this.theme;
    const counts = viewCounts(this.project);
    const numbers = VIEWS.map((_, index) => {
      const label = String(index + 1);
      const count = counts[index] ?? 0;
      const badge = count > 0 ? `(${count})` : "";
      const text = `${label}${badge}`;
      return index === this.viewIndex ? theme.fg("accent", theme.bold(`[${text}]`)) : theme.fg("dim", ` ${text} `);
    }).join(theme.fg("borderMuted", "·"));
    const active = theme.fg("muted", VIEWS[this.viewIndex]!.title);
    const combined = `${numbers}  ${active}`;
    if (visibleWidth(combined) <= width) return combined;
    const activeText = theme.fg("accent", theme.bold(`[${VIEWS[this.viewIndex]!.title}]`));
    if (visibleWidth(numbers) + visibleWidth(activeText) + 4 <= width) return `${numbers}  ${activeText}`;
    return truncateToWidth(activeText, width);
  }

  render(width: number): string[] {
    const theme = this.theme;
    if (this.cachedWidth !== width) this.cachedWidth = width;

    const out: string[] = [];
    const view = VIEWS[this.viewIndex]!;
    const viewport = this.viewportHeight();
    const showingHelp = this.helpVisible && Boolean(this.helpText);

    // Title bar (single line): breadcrumb on the left, status on the right.
    const titleLabel = showingHelp ? "Help" : view.title;
    const breadcrumb = showingHelp ? `${this.project.meta.name} › Help` : `${this.project.meta.name} › ${view.title}`;
    const plan = activePlan(this.project);
    const status = this.project.meta.completed
      ? "COMPLETED"
      : `${this.project.meta.yolo ? "YOLO · " : ""}${plan ? `${plan.id} v${plan.version}` : "no plan"}`;
    const headerLeft = theme.fg("accent", theme.bold(` ${breadcrumb}`));
    const headerRight = theme.fg("dim", `${status} `);
    const headerGap = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight));
    out.push(truncateToWidth(theme.bg("customMessageBg", `${headerLeft}${" ".repeat(headerGap)}${headerRight}`), width));

    // Tab bar (single line, never wraps).
    out.push(showingHelp ? theme.fg("muted", " project commands and agent tools") : this.tabLine(width));

    // Content window.
    const content = showingHelp
      ? fitLines((this.helpText ?? "").split("\n"), width)
      : view.id === "plan"
        ? renderPlanInteractive(this.project, theme, width, this.planCursor).lines
        : view.render(this.project, theme, width);
    const maxScroll = Math.max(0, content.length - viewport);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const end = Math.min(content.length, this.scroll + viewport);
    const window = content.slice(this.scroll, end);
    out.push(...window);
    // Pad only while scrolling, so the panel height is stable mid-scroll but a
    // short view stays short (padding an empty view just wastes screen rows).
    if (content.length > viewport) {
      for (let i = window.length; i < viewport; i++) out.push("");
    }

    // Footer: contextual keys on the left, scroll position on the right.
    const scrollable = content.length > viewport;
    const range = content.length === 0 ? "0 lines" : scrollable ? `${this.scroll + 1}-${end}/${content.length} lines` : `all ${content.length} lines`;
    const scrollHint = scrollable && !showingHelp && this.currentView !== "plan" ? " · j/k scroll" : "";
    const keys = showingHelp
      ? "? or esc close help · j/k scroll · q close"
      : this.currentView === "plan"
        ? `↑↓ select · enter edit · a new · D delete · E raw · tab views${this.helpText ? " · ? help" : ""} · q close`
        : `tab views · 1-9 jump${this.editableViews.has(this.currentView) ? " · e edit · E raw" : ""}${scrollHint}${this.helpText ? " · ? help" : ""} · r reload · q close`;
    const left = theme.fg("dim", ` ${keys}`);
    const right = theme.fg("dim", `${scrollable ? "↕ " : ""}${range} `);
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    out.push(truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width));

    if (this.notice) out.push(truncateToWidth(theme.fg("dim", ` ${this.notice}`), width));
    return out.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {
    this.cachedWidth = -1;
  }
}

/* ------------------------------------------------------------------ */
/* Compact widget (shown above the editor)                            */
/* ------------------------------------------------------------------ */

export function widgetLines(project: Project, theme: Theme, maxLines = 6): string[] {
  const plan = activePlan(project);
  const lines: string[] = [];
  const stats = plan ? dagStats(plan.nodes) : null;
  const next = plan ? nextActionable(plan.nodes) : undefined;
  const goals = project.goals.filter((goal) => goal.status === "ACTIVE").length;
  const openQuestions = project.questions.filter((question) => question.status === "UNKNOWN" || question.status === "PARTIAL").length;

  lines.push(
    theme.fg("accent", `◈ ${project.meta.name}`) +
      theme.fg("dim", project.meta.yolo ? " [YOLO]" : "") +
      theme.fg("muted", `  ${goals} active goals · ${openQuestions} open questions · ${project.risks.length} risks`),
  );
  if (plan && stats) {
    lines.push(
      theme.fg("dim", `  ${plan.id} v${plan.version}: `) +
        theme.fg("muted", `${stats.byStatus.COMPLETED}/${stats.total} done, ${stats.byStatus.RUNNING} running, ${stats.ready} ready`),
    );
    if (next) lines.push(theme.fg("success", "  ▶ ") + theme.fg("text", `${next.id} ${next.title}`));
  } else {
    lines.push(theme.fg("dim", "  no active plan"));
  }
  const running = project.runs.filter((run) => run.status === "RUNNING" || run.status === "STARTED");
  if (running.length > 0) {
    lines.push(theme.fg("warning", `  ${running.length} run(s) in progress: ${running.map((run) => run.id).join(", ")}`));
  }
  return lines.slice(0, maxLines);
}

/** Plan progress used by the footer status. */
export function statusText(project: Project): string {
  const plan = activePlan(project);
  if (!plan) return project.meta.name;
  const stats = dagStats(plan.nodes);
  return `${project.meta.name}: ${stats.byStatus.COMPLETED}/${stats.total} · ${stats.ready} ready`;
}

/* Re-exported for tests. */
export const internals = { computeDepths, activePlan, statusGlyph };
