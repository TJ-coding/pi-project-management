/**
 * TUI: the mandatory project dashboard (spec 22).
 *
 * A single scrollable browser with views for Dashboard, Direction, Goals,
 * State, Intelligence, Risks, Strategy, Plan/DAG, History, Runs and Summary.
 * It is intentionally plain text so it stays usable inside Pi's terminal.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { dagStats, nextActionable, readyNodes, topoOrder } from "./dag.ts";
import { planEvolution } from "./history.ts";
import { byQuestionPriority, byRiskPriority, priorityBand, questionScore, riskExposure, scoreBand, riskScore } from "./scoring.ts";
import { PROJECT_DIR } from "./storage.ts";
import type { Project } from "./types.ts";

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

    lines.push(theme.fg("accent", theme.bold(project.meta.name)) + theme.fg("dim", project.meta.workspace ? `  (${project.meta.workspace})` : ""));
    lines.push(theme.fg("dim", `${project.root}/${PROJECT_DIR}${project.meta.completed ? "  — COMPLETED" : ""}${project.meta.yolo ? "  — YOLO" : ""}`));

    lines.push(...heading(theme, "VISION", width));
    lines.push(project.direction.vision ? theme.fg("text", project.direction.vision) : theme.fg("dim", "not defined"));
    if (project.direction.intent) lines.push(theme.fg("muted", `intent: ${project.direction.intent}`));

    lines.push(...heading(theme, "GOALS", width));
    if (project.goals.length === 0) lines.push(theme.fg("dim", "no goals"));
    for (const goal of project.goals) {
      const color = goal.status === "ACTIVE" ? "text" : goal.status === "COMPLETED" ? "success" : "muted";
      lines.push(
        `${theme.fg("accent", statusGlyph(goal.status))} ${theme.fg(color, goal.title)} ${theme.fg("dim", `[${goal.status}] P${goal.priority}`)}`,
      );
    }

    lines.push(...heading(theme, "STATE", width));
    lines.push(project.state.current ? theme.fg("text", project.state.current) : theme.fg("dim", "not recorded"));
    if (project.state.problems.length > 0) {
      lines.push(theme.fg("warning", `problems: ${project.state.problems.join("; ")}`));
    }

    lines.push(...heading(theme, "RISKS", width));
    if (project.risks.length === 0) lines.push(theme.fg("dim", "no risks"));
    for (const risk of byRiskPriority(project.risks).slice(0, 5)) {
      const band = scoreBand(riskScore(risk));
      lines.push(
        `${theme.fg("error", "!")} ${theme.fg("text", risk.title)} ${bandColor(theme, band)(band.padEnd(8))} ${theme.fg("dim", `exposure ${riskExposure(risk)}`)}`,
      );
    }

    lines.push(...heading(theme, "INTELLIGENCE", width));
    if (project.questions.length === 0) lines.push(theme.fg("dim", "no questions"));
    for (const question of byQuestionPriority(project.questions).slice(0, 5)) {
      const band = scoreBand(questionScore(question));
      lines.push(
        `${theme.fg("accent", "?")} ${theme.fg("text", question.question)} ${bandColor(theme, band)(band.padEnd(8))} ${theme.fg("dim", question.status)}`,
      );
    }

    lines.push(...heading(theme, "ACTIVE PLAN", width));
    if (!plan) {
      lines.push(theme.fg("dim", "no active plan"));
    } else {
      lines.push(theme.fg("muted", `${plan.id} v${plan.version} — ${plan.title}`));
      if (stats) {
        lines.push(
          theme.fg(
            "dim",
            `${stats.byStatus.COMPLETED}/${stats.total} done · ${stats.byStatus.RUNNING} running · ${stats.ready} ready · ${stats.byStatus.FAILED} failed`,
          ),
        );
      }
      const actionable = nextActionable(plan.nodes);
      for (const node of plan.nodes.filter((item) => item.status !== "PENDING").slice(0, 4)) {
        lines.push(`  ${theme.fg("accent", statusGlyph(node.status))} ${theme.fg("muted", `${node.id} ${node.title}`)}`);
      }
      if (actionable) {
        lines.push(`  ${theme.fg("success", "▶")} ${theme.fg("text", `${actionable.id} ${actionable.title}`)} ${theme.fg("dim", "(next)")}`);
      }
    }

    if (project.runs.length > 0) {
      lines.push(...heading(theme, "RUNS", width));
      for (const run of project.runs.slice(-3)) {
        lines.push(`  ${theme.fg("accent", statusGlyph(run.status === "RUNNING" ? "RUNNING" : run.status === "COMPLETED" ? "COMPLETED" : "PENDING"))} ${theme.fg("muted", `${run.id} ${run.title}`)} ${theme.fg("dim", run.status)}`);
      }
    }
    return lines;
  },
};

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

const goalsView: ViewDefinition = {
  id: "goals",
  title: "Goals",
  render(project, theme, width) {
    const lines: string[] = [];
    if (project.goals.length === 0) return [theme.fg("dim", "no goals yet")];
    const ordered = [...project.goals].sort((a, b) => (b.priority - a.priority) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    for (const goal of ordered) {
      const band = priorityBand(goal.priority);
      lines.push(
        `${theme.fg("accent", statusGlyph(goal.status))} ${theme.fg("text", theme.bold(`${goal.id} ${goal.title}`))} ${bandColor(theme, band)(band)} ${theme.fg("dim", goal.status)}`,
      );
      if (goal.description) lines.push(`    ${theme.fg("muted", goal.description)}`);
      if (goal.parent) lines.push(`    ${theme.fg("dim", `parent ${goal.parent}`)}`);
      for (const criterion of goal.successCriteria) lines.push(`    ${theme.fg("dim", "✓")} ${theme.fg("muted", criterion)}`);
      const links: string[] = [];
      if (goal.questions.length) links.push(`questions ${goal.questions.join(", ")}`);
      if (goal.risks.length) links.push(`risks ${goal.risks.join(", ")}`);
      if (goal.tasks.length) links.push(`tasks ${goal.tasks.join(", ")}`);
      if (goal.supersededBy) links.push(`superseded by ${goal.supersededBy}`);
      if (links.length) lines.push(`    ${theme.fg("dim", links.join(" · "))}`);
    }
    return lines;
  },
};

const stateView: ViewDefinition = {
  id: "state",
  title: "State",
  render(project, theme, width) {
    const lines: string[] = [];
    lines.push(...heading(theme, "INITIAL STATE", width));
    lines.push(theme.fg("muted", project.state.initial || "not recorded"));
    lines.push(...heading(theme, "CURRENT STATE", width));
    lines.push(theme.fg("text", project.state.current || "not recorded"));
    const list = (title: string, items: string[], color = "muted"): void => {
      if (items.length === 0) return;
      lines.push(...heading(theme, title.toUpperCase(), width));
      for (const item of items) lines.push(`${theme.fg("accent", "•")} ${theme.fg(color as "muted", item)}`);
    };
    list("Capabilities", project.state.capabilities);
    list("Known facts", project.state.facts);
    list("Active problems", project.state.problems, "warning");
    list("Constraints", project.state.constraints);
    list("Discoveries", project.state.discoveries, "success");
    lines.push(theme.fg("dim", `updated ${project.state.updated}`));
    return lines;
  },
};

const intelligenceView: ViewDefinition = {
  id: "intelligence",
  title: "Intelligence",
  render(project, theme, width) {
    if (project.questions.length === 0) return [theme.fg("dim", "no questions yet")];
    const lines: string[] = [];
    for (const question of byQuestionPriority(project.questions)) {
      const band = scoreBand(questionScore(question));
      lines.push(
        `${theme.fg("accent", "?")} ${theme.fg("text", theme.bold(`${question.id} ${question.question}`))} ${bandColor(theme, band)(band)}`,
      );
      lines.push(
        `    ${theme.fg("muted", question.answer || "unknown")} ${theme.fg("dim", `[${question.status}] conf ${question.confidence.toFixed(2)}`)}`,
      );
      lines.push(
        `    ${theme.fg("dim", `importance ${question.importance.toFixed(2)} · uncertainty ${question.uncertainty.toFixed(2)} · decision impact ${question.decisionImpact.toFixed(2)}`)}`,
      );
      for (const evidence of question.evidence.slice(0, 3)) {
        lines.push(`    ${theme.fg("dim", `evidence: ${evidence.description}${evidence.ref ? ` (${evidence.ref})` : ""}`)}`);
      }
      const links: string[] = [];
      if (question.goals.length) links.push(`goals ${question.goals.join(", ")}`);
      if (question.risks.length) links.push(`risks ${question.risks.join(", ")}`);
      if (question.tasks.length) links.push(`tasks ${question.tasks.join(", ")}`);
      if (links.length) lines.push(`    ${theme.fg("dim", links.join(" · "))}`);
    }
    return lines;
  },
};

const risksView: ViewDefinition = {
  id: "risks",
  title: "Risks",
  render(project, theme) {
    if (project.risks.length === 0) return [theme.fg("dim", "no risks yet")];
    const lines: string[] = [];
    for (const risk of byRiskPriority(project.risks)) {
      const band = scoreBand(riskScore(risk));
      lines.push(
        `${theme.fg("error", "!")} ${theme.fg("text", theme.bold(`${risk.id} ${risk.title}`))} ${bandColor(theme, band)(band)} ${theme.fg("dim", risk.status)}`,
      );
      if (risk.description) lines.push(`    ${theme.fg("muted", risk.description)}`);
      lines.push(
        `    ${theme.fg("dim", `probability ${risk.probability.toFixed(2)} × impact ${risk.impact.toFixed(2)} = exposure ${riskExposure(risk)}`)}`,
      );
      if (risk.mitigation) lines.push(`    ${theme.fg("muted", `mitigation: ${risk.mitigation}`)}`);
      if (risk.contingency) lines.push(`    ${theme.fg("muted", `contingency: ${risk.contingency}`)}`);
      const links: string[] = [];
      if (risk.questions.length) links.push(`questions ${risk.questions.join(", ")}`);
      if (risk.goals.length) links.push(`goals ${risk.goals.join(", ")}`);
      if (risk.tasks.length) links.push(`tasks ${risk.tasks.join(", ")}`);
      if (links.length) lines.push(`    ${theme.fg("dim", links.join(" · "))}`);
    }
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
  render(project, theme, width) {
    const lines: string[] = [];
    const plan = activePlan(project);
    if (!plan) return [theme.fg("dim", "no active plan")];
    lines.push(theme.fg("accent", theme.bold(`${plan.id} v${plan.version} — ${plan.title}`)));
    if (plan.rationale) lines.push(theme.fg("muted", plan.rationale));
    const stats = dagStats(plan.nodes);
    lines.push(
      theme.fg(
        "dim",
        `${stats.byStatus.COMPLETED} completed · ${stats.byStatus.RUNNING} running · ${stats.ready} ready · ${stats.blocked} blocked · ${stats.byStatus.FAILED} failed`,
      ),
    );
    lines.push("");

    const depth = computeDepths(plan.nodes);
    for (const node of topoOrder(plan.nodes)) {
      const indent = "  ".repeat(Math.min(3, depth.get(node.id) ?? 0));
      const color = node.status === "COMPLETED" ? "success" : node.status === "FAILED" ? "error" : node.status === "RUNNING" ? "accent" : "text";
      lines.push(
        `${indent}${theme.fg("accent", statusGlyph(node.status))} ${theme.fg(color, `${node.id} ${node.title}`)} ${theme.fg("dim", `[${node.type} ${node.status}]`)}`,
      );
      const meta: string[] = [];
      if (node.dependsOn.length) meta.push(`after ${node.dependsOn.join(", ")}`);
      if (node.goal) meta.push(`goal ${node.goal}`);
      if (node.question) meta.push(`question ${node.question}`);
      if (node.risk) meta.push(`risk ${node.risk}`);
      if (node.run) meta.push(`run ${node.run}`);
      if (meta.length) lines.push(`${indent}    ${theme.fg("dim", meta.join(" · "))}`);
      if (node.gate) lines.push(`${indent}    ${theme.fg("muted", `gate(${node.gate.type}): ${node.gate.criteria}`)}`);
      if (node.failureReason) lines.push(`${indent}    ${theme.fg("error", `failure: ${node.failureReason}`)}`);
      if (node.outputs.length) lines.push(`${indent}    ${theme.fg("dim", `outputs: ${node.outputs.join("; ")}`)}`);
    }

    const ready = readyNodes(plan.nodes);
    if (ready.length > 0) {
      lines.push("");
      lines.push(...heading(theme, "READY NOW", width));
      for (const node of ready) lines.push(`${theme.fg("success", "▶")} ${theme.fg("text", `${node.id} ${node.title}`)}`);
    }

    if (plan.gates.length > 0) {
      lines.push("");
      lines.push(...heading(theme, "GATE RESULTS", width));
      for (const gate of plan.gates) {
        const color = gate.outcome === "PASS" ? "success" : "warning";
        lines.push(`${theme.fg(color as "success", gate.outcome.padEnd(9))} ${theme.fg("muted", `${gate.node} ${gate.notes}`)}`);
      }
    }
    return lines;
  },
};

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
}

/** Minimum number of body rows (chrome is title + tabs + 2 footer lines). */
const MIN_VIEWPORT = 3;
const CHROME_LINES = 4;

export class ProjectBrowser {
  private project: Project;
  private theme: Theme;
  private onClose: () => void;
  private reload?: () => Promise<Project>;
  private getTerminalRows?: () => number;
  private onChange?: () => void;
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
      this.onClose();
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "right") || matchesKey(data, "l")) {
      this.viewIndex = (this.viewIndex + 1) % VIEWS.length;
      this.scroll = 0;
      return;
    }
    if (matchesKey(data, "shift+tab") || matchesKey(data, "left") || matchesKey(data, "h")) {
      this.viewIndex = (this.viewIndex - 1 + VIEWS.length) % VIEWS.length;
      this.scroll = 0;
      return;
    }
    const digit = /^([1-9])$/.exec(data);
    if (digit) {
      const target = Number.parseInt(digit[1]!, 10) - 1;
      if (target < VIEWS.length) {
        this.viewIndex = target;
        this.scroll = 0;
      }
      return;
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
    if (matchesKey(data, "r") && this.reload) {
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

  /** One-line, always-fitting tab strip so the chrome height never changes. */
  private tabLine(width: number): string {
    const theme = this.theme;
    const full = VIEWS.map((candidate, index) => {
      const label = `${index + 1}:${candidate.title}`;
      return index === this.viewIndex ? theme.fg("accent", theme.bold(`[${label}]`)) : theme.fg("dim", ` ${label} `);
    }).join(theme.fg("borderMuted", "|"));
    if (visibleWidth(full) <= width) return full;

    // Narrow terminal: numbers only, with the active view named at the end.
    const numbers = VIEWS.map((_, index) => {
      const label = String(index + 1);
      return index === this.viewIndex ? theme.fg("accent", theme.bold(`[${label}]`)) : theme.fg("dim", ` ${label} `);
    }).join(theme.fg("borderMuted", "·"));
    const active = theme.fg("accent", theme.bold(` ${VIEWS[this.viewIndex]!.title} `));
    const combined = `${numbers}  ${active}`;
    if (visibleWidth(combined) <= width) return combined;
    return truncateToWidth(theme.fg("accent", theme.bold(`[${VIEWS[this.viewIndex]!.title}]`)), width);
  }

  render(width: number): string[] {
    const theme = this.theme;
    if (this.cachedWidth !== width) this.cachedWidth = width;

    const out: string[] = [];
    const view = VIEWS[this.viewIndex]!;
    const viewport = this.viewportHeight();

    // Title bar (single line).
    const title = `${this.project.meta.name} — ${view.title} (${this.viewIndex + 1}/${VIEWS.length})`;
    out.push(truncateToWidth(theme.bg("customMessageBg", theme.fg("accent", theme.bold(` ${title} `))), width));

    // Tab bar (single line, never wraps).
    out.push(this.tabLine(width));

    // Content window.
    const content = view.render(this.project, theme, width);
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

    // Footer: position/scroll feedback + keys.
    const range = content.length === 0 ? "0 lines" : `Lines ${this.scroll + 1}-${end}/${content.length}`;
    const scrollable = content.length > viewport;
    const up = scrollable && this.scroll > 0 ? "↑" : " ";
    const down = scrollable && end < content.length ? "↓" : " ";
    const notice = this.notice ? `  ${this.notice}` : "";
    out.push(
      truncateToWidth(
        theme.fg("dim", `${up}${down} `) +
          theme.fg("muted", view.title) +
          theme.fg("dim", `  ${range}${scrollable ? " · j/k ↑↓ scroll · space page · g/G top/bottom" : " · nothing more to scroll"}${notice}`),
        width,
      ),
    );
    out.push(
      truncateToWidth(
        theme.fg("dim", "tab/←→ switch · 1-9 jump · r reload · q close"),
        width,
      ),
    );

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
