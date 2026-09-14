/**
 * TUI: the mandatory project dashboard (spec 22).
 *
 * A single scrollable browser with views for Dashboard, Direction, Goals,
 * State, Intelligence, Risks, Strategy, Plan/DAG, History, Runs and Summary.
 * It is intentionally plain text so it stays usable inside Pi's terminal.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { blockedByDependencies, dagStats, nextActionable, readyNodes, runningNodes, topoOrder } from "./dag.ts";
import { percentBadge, planBar, progressBar } from "./format.ts";
import { planEvolution } from "./history.ts";
import { byQuestionPriority, byRiskPriority, priorityBand, questionScore, riskExposure, scoreBand, riskScore } from "./scoring.ts";
import { PROJECT_DIR } from "./storage.ts";
import { overBudget, overBudgetByView, overBudgetEntityIds, type TextKind } from "./limits.ts";
import type { Goal, HistoryEvent, Plan, PlanNode, Project, Question, Risk } from "./types.ts";

export interface ViewDefinition {
  id: string;
  title: string;
  /**
   * Rows the user can select with ↑↓, in the order they appear. Views without
   * rows are plain documents: `enter` reads the whole section instead.
   */
  rows?: (project: Project) => string[];
  /**
   * True when the view already prints its own key hints at the bottom, so the
   * browser footer should not repeat them. Repeating wasted the width that the
   * quit key, the scroll position and the archived hint needed at 80 columns.
   */
  statesKeys?: boolean;
  /**
   * Render the view. With `focus` set, the matching row is highlighted and
   * `focusLine` reports which line it landed on, so the browser can keep the
   * selection on screen.
   */
  render: (project: Project, theme: Theme, width: number, focus?: string | null, options?: ViewOptions) => string[] | ViewRender;
  /** Everything there is to know about the focused row (or the whole section). */
  detail?: (project: Project, focus: string | null) => DetailDoc;
}

/** A rendered view, optionally reporting the line its focused row landed on. */
export interface ViewRender {
  lines: string[];
  focusLine?: number;
}

/** A labelled block of prose in the reading pane. */
export interface DetailField {
  label: string;
  text: string;
  tone?: "text" | "muted" | "dim" | "success" | "warning" | "error";
  /** Budget this text is held to, so a reader sees when it is over. */
  kind?: TextKind;
}

/** A labelled bullet list in the reading pane. */
export interface DetailList {
  label: string;
  items: string[];
  tone?: DetailField["tone"];
  /** Budget each item is held to. */
  kind?: TextKind;
}

/**
 * Full, untruncated view of one entity (or one section) for the reading pane.
 * Views describe their data; the renderer below owns the styling and the
 * wrapping, so long text is readable instead of clipped.
 */
export interface DetailDoc {
  title: string;
  meta?: string;
  fields: DetailField[];
  lists?: DetailList[];
}

/**
 * Visual hierarchy
 * ----------------
 * Terminal emphasis has three usable levels. Using them consistently is what
 * tells the eye where to land:
 *
 *   level 1  bold + accent   the one focal thing on screen (section titles, the
 *                            selected row, the primary call to action)
 *   level 2  text            content the user reads (titles, values)
 *   level 3  muted           secondary content (ids, labels, lists)
 *   level 4  dim             metadata and chrome (badges, counts, footer, hints)
 *
 * Status colour is reserved for status: success/error/warning. Accent means
 * "structure or focus", never decoration.
 */
export function strong(theme: Theme, text: string): string {
  return theme.fg("accent", theme.bold(text));
}

/**
 * `┏━ TITLE ━ meta ━┓` — starts a container. The corners plus the continuous `┃`
 * spine on the rows below (see `containerRow`) show exactly which information
 * belongs together.
 */
export function sectionHeader(
  theme: Theme,
  title: string,
  meta: string,
  width: number,
  tone: "accent" | "success" | "warning" | "muted" = "accent",
): string {
  const left = theme.fg(tone, "┏━ ") + theme.fg(tone, theme.bold(title));
  const right = meta ? theme.fg("dim", ` ${meta} `) : "";
  const used = visibleWidth(left) + visibleWidth(right);
  const rule = Math.max(0, width - used - 2);
  return truncateToWidth(`${left}${theme.fg("borderMuted", "━".repeat(rule))}${right}${theme.fg(tone, "━┓")}`, width, "…");
}

/**
 * A row inside a container. The spine is drawn on the left and the wall on the
 * right, padded to `width`, so the sides actually connect to the header's `┏`/`┓`
 * and the footer's `┗`/`┛`. A box open down one side reads as a render bug.
 */
export function containerRow(theme: Theme, content: string, width: number, selected = false): string {
  const spine = theme.fg("borderMuted", "┃ ");
  const wall = theme.fg("borderMuted", "┃");
  // Two columns are spent on the right wall; the spine is already inside content.
  const body = truncateToWidth(content, Math.max(1, width - 3), "…");
  const filled = padStyled(body, Math.max(1, width - 3));
  return selectionRow(theme, `${spine}${filled}${wall}`, width, selected);
}

/**
 * A continuation row inside a container. It carries both walls so the box reads as
 * a single closed rectangle, with the spine replaced by a space so continuation
 * text stays visually subordinate to the row above it.
 */
export function containerNote(theme: Theme, content: string, width: number): string {
  const gutter = theme.fg("borderMuted", "┃ ");
  const wall = theme.fg("borderMuted", "┃");
  const body = truncateToWidth(content, Math.max(1, width - 3), "…");
  return `${gutter}${padStyled(body, Math.max(1, width - 3))}${wall}`;
}

/**
 * Closes a container. The rule starts at column 0 and reaches the full width so
 * it lines up with the `┏`/`┓` corners the header drew.
 */
export function containerClose(theme: Theme, width: number): string {
  const rule = Math.max(2, width - 2);
  return truncateToWidth(`${theme.fg("borderMuted", "┗")}${theme.fg("borderMuted", "━".repeat(rule))}${theme.fg("borderMuted", "┛")}`, width, "…");
}

function padStyled(text: string, width: number): string {
  const visible = visibleWidth(text);
  if (visible >= width) return text;
  return text + " ".repeat(width - visible);
}

/** Full-width selection bar — the strongest affordance available in a terminal. */
export function selectionRow(theme: Theme, text: string, width: number, selected: boolean): string {
  // Clip first, then paint: an over-long selected row would otherwise escape its
  // container and wrap at column 0 (background highlight included).
  const clipped = truncateToWidth(text, width, "…");
  return selected ? theme.bg("selectedBg", padStyled(clipped, width)) : clipped;
}

/** A quiet panel used for the single primary block on a screen. */
export function panel(theme: Theme, lines: string[], width: number): string[] {
  return lines.map((line) => theme.bg("customMessageBg", truncateToWidth(padStyled(line, width), width, "…")));
}

/** `label   value` with an aligned, quiet label column. */
export function keyValue(theme: Theme, label: string, value: string, width: number, labelWidth = 8): string {
  return truncateToWidth(`${theme.fg("muted", label.padEnd(labelWidth))}${value}`, width, "…");
}

/**
 * A bullet whose continuation lines stay indented under its own text, so one
 * long value never reads as several separate items.
 */
export function bulletLines(theme: Theme, marker: string, styled: string, width: number): string[] {
  const prefix = theme.fg("accent", marker);
  const indent = " ".repeat(visibleWidth(marker));
  const safe = Math.max(8, width - visibleWidth(prefix));
  return wrapTextWithAnsi(styled, safe).map((line, index) => (index === 0 ? `${prefix}${line}` : `${indent}${line}`));
}

/** "3h ago" — ageing reads better than an ISO timestamp for entity metadata. */
export function relativeTime(at: string, now = Date.now()): string {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return at;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/** `N1 COMPLETED -> COMPLETED` says nothing; such events are dropped. */
function isNoopTransition(summary: string): boolean {
  const match = /\b([A-Z][A-Z_]{2,})\s*->\s*([A-Z][A-Z_]{2,})\b/.exec(summary);
  return Boolean(match && match[1] === match[2]);
}

/** History rows: newest first, no-op status transitions dropped. */
export function historyEvents(project: Project): HistoryEvent[] {
  return [...project.history].reverse().filter((event) => !isNoopTransition(event.summary)).slice(0, 200);
}

/** `23:14` for rows; a day change gets its own divider line instead. */
function eventClock(at: string): string {
  return at.slice(11, 16);
}

/**
 * Anything rendered as one row must be one line. Agents and hand edits can store
 * newlines or double-escaped quotes ("...\n..." / \"quoted\") in a summary or a
 * title, which would otherwise break the row out of its container at column 0.
 */
export function oneLine(text: string): string {
  return text
    .replace(/\\[nrt]/g, " ")
    .replace(/\\"/g, '"')
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const historyView: ViewDefinition = {
  id: "history",
  title: "History",
  rows: (project) => historyEvents(project).map((event) => String(event.seq)),
  detail: (project, focus) => {
    const event = project.history.find((candidate) => String(candidate.seq) === focus);
    return event ? detailForEvent(event) : emptyDetail("History", "no event selected");
  },
  render(project, theme, width, focus) {
    const events = historyEvents(project);
    if (events.length === 0) return [`  ${theme.fg("dim", "nothing recorded yet")}`];
    const lines: string[] = [];
    let focusLine: number | undefined;
    const dropped = project.history.length - events.length;
    lines.push(sectionHeader(theme, "EVENTS", dropped > 0 ? `${events.length} · ${dropped} no-op hidden` : `${events.length}`, width, "accent"));
    let previousDay: string | null = null;
    for (const event of events) {
      const color =
        event.kind.includes("fail") || event.kind.includes("abandon")
          ? "error"
          : event.kind.includes("completed") || event.kind.includes("passed") || event.kind.includes("answered")
            ? "success"
            : event.kind.includes("plan")
              ? "accent"
              : "muted";
      const refs = event.refs.length > 0 ? ` ${theme.fg("dim", `[${event.refs.join(", ")}]`)}` : "";
      // One HH:MM column, with a divider when the day changes: seconds are noise
      // (row order already encodes sequence) and a per-row date breaks the grid.
      const day = event.at.slice(0, 10);
      if (day !== previousDay) {
        lines.push(containerNote(theme, theme.fg("dim", `── ${day} ──`), width));
        previousDay = day;
      }
      const selected = String(event.seq) === focus;
      if (selected) focusLine = lines.length;
      lines.push(
        containerRow(
          theme,
          `${theme.fg("dim", eventClock(event.at))} ${theme.fg(color, event.kind.padEnd(18))} ${theme.fg("text", oneLine(event.summary))}${refs}`,
          width,
          selected,
        ),
      );
    }
    lines.push(containerClose(theme, width));
    lines.push(`  ${theme.fg("dim", "↑↓ select · enter read the whole event")}`);
    return { lines, focusLine };
  },
};

const runsView: ViewDefinition = {
  id: "runs",
  title: "Runs",
  render(project, theme, width) {
    if (project.runs.length === 0) return [`  ${theme.fg("dim", "no runs recorded")}`];
    const lines: string[] = [];
    for (const run of [...project.runs].reverse()) {
      lines.push(sectionHeader(theme, `${run.id}`, `${run.status} · ${run.title}`, width, run.status === "FAILED" ? "warning" : "accent"));
      lines.push(containerRow(theme, `${theme.fg("accent", statusGlyph(run.status === "RUNNING" ? "RUNNING" : run.status))} ${theme.fg("text", run.title)} ${theme.fg("dim", run.status)}`, width));
      const meta: string[] = [`started ${run.started}`];
      if (run.finished) meta.push(`finished ${run.finished}`);
      if (run.node) meta.push(`node ${run.node}`);
      if (run.pid) meta.push(`pid ${run.pid}`);
      if (run.host) meta.push(`host ${run.host}`);
      lines.push(containerNote(theme, theme.fg("dim", meta.join(" · ")), width));
      if (run.command) lines.push(containerNote(theme, theme.fg("muted", `$ ${run.command}`), width));
      for (const environment of run.environment) {
        // The host is already above; repeating it as an env line wastes a row.
        if (environment.kind === "ssh" && environment.target === run.host) continue;
        lines.push(containerNote(theme, theme.fg("dim", `env ${environment.kind}: ${environment.target}${environment.note ? ` (${environment.note})` : ""}`), width));
      }
      for (const entry of run.entries.slice(-3)) {
        lines.push(containerNote(theme, `${theme.fg("dim", `${entry.at.slice(11, 19)} [${entry.kind}]`)} ${theme.fg("muted", entry.text)}`, width));
      }
      if (run.entries.length === 0 && run.status === "RUNNING") {
        lines.push(containerNote(theme, theme.fg("dim", "no progress logged yet — ask the agent to log the latest line"), width));
      }
      for (const output of run.outputs.slice(-3)) {
        lines.push(containerNote(theme, `${theme.fg("success", "→")} ${theme.fg("muted", output.description)}`, width));
      }
      lines.push(containerClose(theme, width));
      lines.push("");
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
      // Archived replaces the status, it does not join it: "ACTIVE · archived"
      // asserts active while calling it archived, and everywhere else in the UI
      // archived means *not* active (k3 rounds 2 and 3).
      const state = goal.archived ? "ARCHIVED" : goal.status;
      lines.push(...bulletLines(theme, "• ", `${theme.fg(color, glyph)} ${theme.fg("text", `${goal.id} ${goal.title}`)} ${theme.fg("dim", state)}`, width));
    }

    lines.push(...heading(theme, "PLAN EVOLUTION", width));
    const evolution = planEvolution(project);
    if (evolution.length === 0) lines.push(theme.fg("dim", "no plans"));
    for (const entry of evolution) {
      // One line per plan. The reason and trigger live in History, which records
      // every plan.changed event with a timestamp — repeating them here was the
      // one real duplication between two panels.
      const superseded = entry.supersededBy ? theme.fg("dim", ` → ${entry.supersededBy}`) : "";
      lines.push(
        ...bulletLines(
          theme,
          "• ",
          `${theme.fg("text", `${entry.plan} v${entry.version}`)} ${theme.fg("muted", entry.title)} ${theme.fg("dim", entry.change ? entry.change.at.slice(0, 10) : entry.createdAt.slice(0, 10))}${superseded}`,
          width,
        ),
      );
    }
    if (evolution.some((entry) => entry.change)) {
      lines.push(`  ${theme.fg("dim", "reasons and triggers: History")}`);
    }

    lines.push(...heading(theme, "MAJOR DECISIONS", width));
    if (project.decisions.length === 0) lines.push(theme.fg("dim", "no decisions"));
    for (const decision of project.decisions) {
      lines.push(
        ...bulletLines(
          theme,
          "• ",
          `${theme.fg("text", `${decision.id} ${decision.title}`)} ${theme.fg("dim", `[${decision.authority}${decision.autoAccepted ? ", auto" : ""}]`)}`,
          width,
        ),
      );
    }

    lines.push(...heading(theme, "LESSONS / FINDINGS", width));
    const findings = [...project.state.discoveries, ...live(project.questions).filter((question) => question.status === "CONFIRMED").map((question) => question.answer)];
    if (findings.length === 0) lines.push(theme.fg("dim", "none recorded"));
    for (const finding of findings) lines.push(...bulletLines(theme, "• ", theme.fg("muted", finding), width));
    return lines;
  },
};

/* ------------------------------------------------------------------ */
/* Plan browser (master / detail)                                     */
/* ------------------------------------------------------------------ */

const NODE_TYPE_ABBREVIATIONS: Record<string, string> = {
  TASK: "TASK",
  INVESTIGATION: "INV",
  EXPERIMENT: "EXP",
  DECISION: "DEC",
  REVIEW: "REV",
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
export function planGroups(project: Project, cap = 6, showArchived = false): PlanGroup[] {
  const plan = activePlan(project);
  if (!plan) return [];
  // Ready/blocked are computed from the full node set so an archived node still
  // satisfies its dependants: archiving hides work, it does not rewire the DAG.
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
    // Archived nodes leave the DAG's working groups: an archived task is not
    // ready, not blocked and not running, whatever its status still says. It is
    // not dropped either, so the DAG still validates against its dependencies.
    if (isArchived(node) && !showArchived) continue;
    if (node.status === "RUNNING") byKey.get("running")!.nodes.push(node);
    else if (readyIds.has(node.id)) byKey.get("ready")!.nodes.push(node);
    else if (node.status === "PENDING" || node.status === "BLOCKED" || node.status === "INTERRUPTED") {
      byKey.get("blocked")!.nodes.push(node);
    } else byKey.get("finished")!.nodes.push(node);
  }
  void blocked;

  for (const group of groups) {
    // The "… +N more" note costs one line. Showing one extra node in that same
    // line is strictly more information, so only cap when it saves ≥2 lines.
    if (group.nodes.length > cap + 1) {
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
  showArchived = false,
): PlanRender {  const plan = activePlan(project);
  if (!plan) {
    return { lines: [theme.fg("dim", "no active plan yet"), "", theme.fg("dim", "the agent can create one when you ask for a plan")], ids: [] };
  }
  const groups = planGroups(project, 6, showArchived);
  const ids = groups.flatMap((group) => group.nodes.map((node) => node.id));
  const activeId = cursor && ids.includes(cursor) ? cursor : ids[0] ?? null;
  const stats = dagStats(plan.nodes);
  const bloated = overBudgetEntityIds(project);

  const lines: string[] = [];
  const done = stats.byStatus.COMPLETED;
  const barWidth = Math.max(8, Math.min(24, width - 34));
  // Same glyphs as an entity's own bar, but this one measures the whole plan, so
  // it fills the width it is given (see planBar in format.ts).
  lines.push(
    theme.fg("accent", theme.bold(`${plan.id} v${plan.version}`)) +
      theme.fg("muted", `  ${plan.title}`) +
      theme.fg("success", `  ${planBar(done, stats.total, barWidth)}`) +
      theme.fg("dim", ` ${done}/${stats.total}`),
  );
  lines.push(theme.fg("dim", `${stats.ready} ready · ${stats.byStatus.RUNNING} running · ${stats.blocked} blocked · ${stats.byStatus.COMPLETED} done · ${stats.byStatus.FAILED} failed`));
  // An archived node is hidden from the groups, so the view must say how many,
  // or the DAG silently looks smaller than it is.
  const hiddenNodes = plan.nodes.filter(isArchived).length;
  if (hiddenNodes > 0) {
    lines.push(
      theme.fg("dim", `${hiddenNodes} archived ${hiddenNodes === 1 ? "node" : "nodes"} ${showArchived ? "shown" : "hidden"} · press v to ${showArchived ? "hide" : "show"}`),
    );
  }
  lines.push("");

  for (const group of groups) {
    lines.push(sectionHeader(theme, group.label, `${group.nodes.length + group.hidden}`, width, group.tone));
    for (const node of group.nodes) {
      const markable = node.status !== "COMPLETED" && node.status !== "ABANDONED" && node.status !== "SUPERSEDED";
      const content = planNodeContent(theme, node, bloated.has(`plan:${plan.id}/${node.id}`) && markable, parentBadge(plan, node));
      lines.push(containerRow(theme, content, width, node.id === activeId));
    }
    if (group.hidden > 0) {
      lines.push(containerNote(theme, theme.fg("dim", `… +${group.hidden} more`), width));
    }
    lines.push(containerClose(theme, width));
  }

  const selected = activeId ? plan.nodes.find((node) => node.id === activeId) : undefined;
  if (selected) lines.push("", ...renderPlanDetail(theme, project, selected, width));

  return { lines, ids };
}

/** Row content for a node; the container adds the gutter and the selection bar. */
function planNodeContent(theme: Theme, node: PlanNode, bloated = false, parents = ""): string {
  const glyphColor = node.status === "COMPLETED" ? "success" : node.status === "FAILED" ? "error" : node.status === "RUNNING" ? "accent" : "dim";
  const glyph = `${bloated ? theme.fg("warning", "⚠ ") : ""}${theme.fg(glyphColor, statusGlyph(node.status))}`;
  const id = theme.fg("muted", node.id.padEnd(4));
  const type = theme.fg("dim", (NODE_TYPE_ABBREVIATIONS[node.type] ?? node.type).padEnd(5));

  const badges: string[] = [];
  if (node.question) badges.push(node.question);
  if (node.risk) badges.push(node.risk);
  if (node.goal) badges.push(node.goal);

  // Fixed columns: identity, then links, then the title; parents live on the
  // right edge and nothing ever displaces them. A shared column that changes
  // meaning per row forces the reader to decode every line.
  //
  // The percent gets its own fixed 4-wide column rather than joining the badges:
  // k3 found `60% G2` crowding two short tokens while unestimated rows shifted
  // the goal column left. Blank stays blank, so the column is stable either way.
  const head = `${glyph} ${id}${type}`;
  // Exactly 6 cells either way: 1 + 4 + 1 when there is a percent, 6 blanks when
  // there is not. Anything else shifts the link column between rows.
  const percentCell = node.percent === null ? "      " : ` ${percentBadge(node.percent).padStart(4)} `;
  // The trailing space after the links is what separates them from the title.
  const links = badges.length > 0 ? `${theme.fg("muted", badges.join(" "))} ` : "";
  const parentText = parents ? ` ${theme.fg("dim", parents)}` : "";
  const start = `${head}${theme.fg("accent", percentCell)}${links}`;
  const titleRoom = Math.max(8, 68 - visibleWidth(head) - visibleWidth(links) - visibleWidth(percentCell));
  const parentRoom = visibleWidth(parentText);
  const available = Math.max(8, titleRoom - (parentRoom > 0 && titleRoom - parentRoom > 20 ? parentRoom : 0));
  const flat = oneLine(node.title);
  const title = flat.length > available ? `${flat.slice(0, available - 1)}…` : flat;
  const fill = " ".repeat(Math.max(1, 68 - visibleWidth(start) - visibleWidth(title) - parentRoom));
  return `${start}${theme.fg("text", title)}${parents ? `${fill}${theme.fg("dim", parents)}` : ""}`;
}

/**
 * `←N1✓` — the parent ids, marking one that is already done. This is what makes
 * a node's place in the DAG readable: a tree glyph only works when parent and
 * child share a group, and grouping by status guarantees they often do not.
 */
function parentBadge(plan: Plan, node: PlanNode): string {
  if (node.dependsOn.length === 0) return "";
  // One formatter for every arity: `←N1✓` or `←N1✓ N2 N3`. A tick after its own
  // id always means "that parent is done", so it reads the same in a one-parent
  // row and a four-parent row instead of flipping notation between boxes.
  return `←${node.dependsOn
    .map((dep) => {
      const parent = plan.nodes.find((candidate) => candidate.id === dep);
      if (!parent) return `${dep}?`;
      return parent.status === "COMPLETED" ? `${dep}✓` : dep;
    })
    .join(" ")}`;
}

function renderPlanDetail(theme: Theme, project: Project, node: PlanNode, width: number): string[] {
  const lines: string[] = [];
  lines.push(sectionHeader(theme, "SELECTED", `${node.id} · ${node.type} · ${node.status}`, width, "accent"));
  lines.push(containerRow(theme, theme.bold(theme.fg("text", truncateToWidth(node.title, width - 8, "…"))), width));
  if (node.description) {
    lines.push(containerNote(theme, theme.fg("muted", truncateToWidth(node.description.replace(/\s+/g, " "), width - 8, "…")), width));
  }
  const meta: string[] = [];
  // The full bar belongs here rather than in the row: the row has room for the
  // number, and this pane is where a reader asks "how far along is it really".
  if (node.percent !== null) meta.push(progressBar(node.percent));
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
  lines.push(containerNote(theme, theme.fg("dim", meta.join("  ·  ")), width));
  // Depth is only useful next to the ancestors that produce it, so name them.
  // At depth 1 the chain restates the row badge, so it is suppressed there.
  if (node.dependsOn.length > 0) {
    const plan = activePlan(project);
    const depth = computeDepths(plan?.nodes ?? []).get(node.id) ?? 0;
    const chain = plan && depth > 1 ? longestChain(plan.nodes, node.id) : [];
    lines.push(
      containerNote(
        theme,
        theme.fg("muted", depth > 1 ? `depth ${depth}  ·  ${chain.join(" → ")}` : `depth ${depth}`),
        width,
      ),
    );
  }
  const links: string[] = [];
  if (node.question) links.push(`question ${node.question}`);
  if (node.risk) links.push(`risk ${node.risk}`);
  if (node.goal) links.push(`goal ${node.goal}`);
  if (node.run) links.push(`run ${node.run}`);
  if (node.gate) links.push(`gate ${node.gate.type}`);
  if (links.length > 0) lines.push(containerNote(theme, theme.fg("muted", links.join("  ·  ")), width));
  if (node.gate?.criteria) lines.push(containerNote(theme, theme.fg("muted", `criteria: ${truncateToWidth(node.gate.criteria, width - 18, "…")}`), width));
  if (node.failureReason) lines.push(containerNote(theme, theme.fg("error", `failure: ${truncateToWidth(node.failureReason, width - 16, "…")}`), width));
  if (node.outputs.length > 0) lines.push(containerNote(theme, theme.fg("success", `outputs: ${truncateToWidth(node.outputs.join("; "), width - 16, "…")}`), width));
  lines.push(containerNote(theme, theme.fg("dim", "↑↓ select · enter read · e edit · a new · D delete · E raw"), width));
  lines.push(containerClose(theme, width));
  return lines;
}


/** Guarantee the Component contract: no rendered line may exceed `width`. */
function fitLines(lines: string[], width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  return lines
    .flatMap((line) => wrapTextWithAnsi(line, safeWidth))
    .map((line) => truncateToWidth(line, safeWidth, "…"));
}

/** `N1 → N6 → N7`: the longest dependency path ending at `id`, roots first. */
function longestChain(nodes: PlanNode[], id: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const walk = (current: string, seen: Set<string>): string[] => {
    if (seen.has(current)) return [current];
    const node = byId.get(current);
    if (!node || node.dependsOn.length === 0) return [current];
    const next = new Set(seen).add(current);
    let best: string[] = [];
    for (const dep of node.dependsOn) {
      const chain = walk(dep, next);
      if (chain.length > best.length) best = chain;
    }
    return [...best, current];
  };
  return walk(id, new Set());
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

/**
 * Per-view count badges for the rail, keyed by view id.
 *
 * Keyed rather than positional: an array indexed by rail position silently lied
 * about every view the moment the rail was reordered. A badge means "things here
 * that want attention", which is why risks counts open ones and history counts
 * days with activity.
 */
/** Archived things stay readable but never count as active work. */
export function isArchived(entity: { archived?: boolean }): boolean {
  return entity.archived === true;
}

/**
 * The active subset every surface must agree on.
 *
 * k3's frame review caught the panels contradicting each other — the goals panel
 * listed 2 while the widget said 3 and the summary called the third ACTIVE. Each
 * surface had grown its own filter, so one shared definition is the fix: any
 * count a reader can compare must come from here.
 */
export function live<T extends { archived?: boolean }>(items: readonly T[]): T[] {
  return items.filter((item) => !isArchived(item));
}

/** How many archived items exist per kind, for the "N archived" note. */
export function archivedCounts(project: Project): { goals: number; questions: number; risks: number; nodes: number; total: number } {
  const nodes = (activePlan(project)?.nodes ?? []).filter(isArchived).length;
  const goals = project.goals.filter(isArchived).length;
  const questions = project.questions.filter(isArchived).length;
  const risks = project.risks.filter(isArchived).length;
  return { goals, questions, risks, nodes, total: goals + questions + risks + nodes };
}

export function viewCounts(project: Project): Map<string, number> {
  const openQuestions = project.questions.filter((question) => !isArchived(question) && (question.status === "UNKNOWN" || question.status === "PARTIAL")).length;
  const openRisks = project.risks.filter((risk) => !isArchived(risk) && (risk.status === "OPEN" || risk.status === "MITIGATING")).length;
  const plan = activePlan(project);
  const runningRuns = project.runs.filter((run) => run.status === "RUNNING" || run.status === "STARTED").length;
  const activeGoals = project.goals.filter((goal) => !isArchived(goal) && goal.status === "ACTIVE").length;
  const problems = project.state.problems.length;
  const counts = new Map<string, number>([
    ["goals", activeGoals],
    ["state", problems],
    ["intelligence", openQuestions],
    ["risks", openRisks],
    ["plan", plan ? plan.nodes.filter((node) => !isArchived(node)).length : 0],
    ["history", project.history.length],
    ["runs", runningRuns || project.runs.length],
  ]);
  return counts;
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
    const openQuestions = byQuestionPriority(live(project.questions).filter((q) => q.status === "UNKNOWN" || q.status === "PARTIAL"));
    const openRisks = byRiskPriority(live(project.risks)).filter((risk) => risk.status === "OPEN" || risk.status === "MITIGATING");
    const bloatedIds = overBudgetEntityIds(project);
    const activeGoals = live(project.goals).filter((goal) => goal.status === "ACTIVE");
    const doneGoals = live(project.goals).filter((goal) => goal.status === "COMPLETED");
    // Archived goals are out of the active set, so they are out of the total too.
    // Counting them here made this line disagree with the goals panel, which is
    // the panel a reader would check it against.
    const liveGoals = project.goals.filter((goal) => !isArchived(goal));
    const runningRuns = project.runs.filter((run) => run.status === "RUNNING" || run.status === "STARTED");

    // Quiet context first: what this project is. The objective leads the vision
    // because it is the more specific statement of what we are doing now, and it
    // is labelled and bold: k3 found an unmarked ◆ line shared the grammar of the
    // hint lines, so the sentence meant to orient the reader was the easiest to
    // skip.
    if (project.meta.objective) {
      lines.push(
        `  ${theme.fg("accent", "◆ OBJECTIVE  ")}${theme.bold(theme.fg("text", truncateToWidth(project.meta.objective, Math.max(10, width - 18), "…")))}`,
      );
      lines.push("");
    }
    if (project.direction.vision) {
      lines.push(...truncateWrapped(project.direction.vision, width, 2).map((line) => `  ${theme.fg("muted", line)}`));
      lines.push("");
    }

    // ── The single focal point: the one thing to act on now. ──────────────
    // The header says whether this is already running or merely the top-ranked
    // next pick, so "NOW" never implies work that has not started.
    const running = plan ? runningNodes(plan.nodes) : [];
    const nowLabel = running.length > 0 ? "RUNNING" : "NEXT UP";
    const nowTone: "accent" | "success" = running.length > 0 ? "accent" : "success";
    // The header's right slot is a count everywhere else, so the plan version goes
    // in the body instead of colliding with that convention.
    lines.push(sectionHeader(theme, nowLabel, "", width, nowTone));
    const focal = running[0] ?? next;
    if (focal) {
      lines.push(containerRow(theme, strong(theme, `${focal.id} ${focal.title}`), width));
      const rationale = [
        running.length > 0 ? "in progress" : "top-ranked ready work",
        focal.type,
        // A running item's progress matters most right here.
        focal.percent !== null ? `${focal.percent}%` : null,
        focal.question ? `answers ${focal.question}` : null,
        focal.risk ? `reduces ${focal.risk}` : null,
        plan ? `${plan.id} v${plan.version}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(containerNote(theme, theme.fg("dim", rationale), width));
    } else {
      lines.push(containerRow(theme, theme.fg("warning", "nothing actionable — ask the agent to replan"), width));
    }
    lines.push(containerClose(theme, width));
    lines.push("");

    // Support: state and running work, de-emphasised. The headline sentence is
    // wrapped, never ellipsised — truncating it is what makes the view useless.
    const problems = project.state.problems.length;
    lines.push(sectionHeader(theme, "STATE", problems > 0 ? `${problems} problem${problems === 1 ? "" : "s"}` : "", width, "muted"));
    const stateLines = wrapTextWithAnsi(theme.fg("text", project.state.current || "not recorded"), Math.max(12, width - 8));
    const stateShown = stateLines.slice(0, 3);
    stateShown.forEach((line, index) => lines.push(index === 0 ? containerRow(theme, line, width) : containerNote(theme, line, width)));
    if (stateLines.length > stateShown.length) {
      lines.push(containerNote(theme, theme.fg("dim", `… ${stateLines.length - stateShown.length} more line(s) — enter on State to read it all`), width));
    }
    lines.push(containerClose(theme, width));
    if (runningRuns.length > 0) {
      lines.push(
        sectionHeader(theme, "RUNS", `${runningRuns.length} in progress`, width, "warning"),
        containerRow(theme, theme.fg("text", runningRuns.map((run) => `${run.id} ${run.title}`).join(" · ")), width),
        containerClose(theme, width),
      );
    }
    lines.push("");

    // Progress: numbers, aligned, no prose.
    lines.push(sectionHeader(theme, "PROGRESS", "", width, "muted"));
    if (plan && stats) {
      const barWidth = Math.max(8, Math.min(18, width - 48));
      lines.push(
        containerRow(
          theme,
          keyValue(
            theme,
            "plan",
          theme.fg("success", planBar(stats.byStatus.COMPLETED, stats.total, barWidth)) +
            theme.fg("muted", `  ${stats.byStatus.COMPLETED}/${stats.total}`) +
            theme.fg("dim", `   ${stats.ready} ready · ${stats.byStatus.RUNNING} running · ${stats.blocked} blocked`),
            width - 4,
            7,
          ),
          width,
        ),
      );
    }
    lines.push(
      containerRow(
        theme,
        keyValue(
          theme,
          "goals",
        theme.fg("text", `${doneGoals.length}/${liveGoals.length} done`) +
          theme.fg("dim", "   ") +
          theme.fg("text", `${openQuestions.length}`) +
          theme.fg("dim", " open questions") +
          theme.fg("dim", " · ") +
          theme.fg("text", `${openRisks.length}`) +
          theme.fg("dim", " open risks"),
          width - 4,
          7,
        ),
        width,
      ),
      containerClose(theme, width),
    );
    lines.push("");

    // Signals: top one of each, strongest first. Everything else is one key away.
    lines.push(sectionHeader(theme, "SIGNALS", "top of each list", width, "muted"));
    const signals: string[] = [];
    if (openQuestions[0]) {
      const question = openQuestions[0];
      signals.push(
        metricLine(theme, "?", "warning", question.id, question.question, scoreBand(questionScore(question)), width, bloatedIds.has(`question:${question.id}`)),
      );
    }
    if (openRisks[0]) {
      const risk = openRisks[0];
      signals.push(metricLine(theme, "!", "error", risk.id, risk.title, `exp ${riskExposure(risk).toFixed(2)}`, width, bloatedIds.has(`risk:${risk.id}`)));
    }
    if (activeGoals[0]) {
      const goal = activeGoals[0];
      signals.push(metricLine(theme, "●", "accent", goal.id, goal.title, priorityBand(goal.priority), width, bloatedIds.has(`goal:${goal.id}`)));
    }
    if (signals.length === 0) lines.push(containerNote(theme, theme.fg("dim", "nothing recorded yet"), width));
    lines.push(...signals);
    lines.push(containerClose(theme, width));

    const full: string[] = [];
    // These counts say how many rows the full views hold, so an archived item
    // still counts — but it is named, or the number contradicts the live count
    // three lines above (k3 round 2).
    const withArchived = (total: number, shown: number): string =>
      total === shown ? `${total}` : `${total} (${total - shown} archived)`;
    if (project.goals.length > 0) full.push(`${withArchived(project.goals.length, live(project.goals).length)} goals`);
    if (project.questions.length > 0) full.push(`${withArchived(project.questions.length, live(project.questions).length)} questions`);
    if (project.risks.length > 0) full.push(`${withArchived(project.risks.length, live(project.risks).length)} risks`);
    if (plan) full.push(`${withArchived(plan.nodes.length, live(plan.nodes).length)} nodes`);
    if (full.length > 0) lines.push(`  ${theme.fg("dim", `full lists: ${full.join(" · ")}`)}`);
    // One number, not a wall of warnings: the exact list is in /project review.
    const bloated = overBudgetByView(project);
    if (bloated.total > 0) {
      // Per-view counts that add up, so the number is actionable.
      const ranked = [...bloated.byView.entries()].sort((a, b) => b[1] - a[1]);
      const head = ranked.slice(0, 3).map(([view, count]) => `${view} ${count}`).join(" · ");
      const rest = bloated.total - ranked.slice(0, 3).reduce((sum, [, count]) => sum + count, 0);
      const tail = rest > 0 ? ` · +${rest} elsewhere` : "";
      lines.push(`  ${theme.fg("warning", `${bloated.total} over budget`)}${theme.fg("dim", ` — ${head}${tail}`)}`);
    }
    return lines;
  },
};

/** `glyph  ID  title .......... metric` — aligned columns, metric semantically coloured. */
function metricLine(
  theme: Theme,
  glyph: string,
  tone: "accent" | "success" | "warning" | "error",
  id: string,
  title: string,
  metric: string,
  width: number,
  bloated = false,
): string {
  const head = `${bloated ? theme.fg("warning", "⚠ ") : ""}${theme.fg(tone, glyph)} ${theme.fg("muted", id.padEnd(4))}`;
  const headWidth = visibleWidth(head);
  const tailWidth = visibleWidth(metric);
  // The container row spends 4 columns on its gutter; fill only what is left or the
  // metric is clipped to "MEDI…" by the outer truncation.
  const inner = Math.max(10, width - 4);
  const room = Math.max(10, inner - headWidth - 3);
  // A metric clipped to "M..." is worse than no metric: drop the column instead.
  const showMetric = tailWidth + 12 <= room;
  const available = Math.max(10, showMetric ? room - tailWidth - 1 : room);
  const flat = oneLine(title);
  const text = flat.length > available ? `${flat.slice(0, Math.max(0, available - 1))}…` : flat;
  const tail = showMetric ? theme.fg(tone === "accent" ? "dim" : tone, metric) : "";
  const gap = Math.max(1, inner - headWidth - visibleWidth(text) - tailWidth - 6);
  return containerRow(theme, `${head}${theme.fg("text", text)}${" ".repeat(gap)}${tail}`, width);
}

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
  detail: (project) => detailForDirection(project),
  render(project, theme, width) {
    const lines: string[] = [];
    lines.push(...heading(theme, "VISION", width));
    lines.push(theme.fg("text", project.direction.vision || "not defined"));
    lines.push(...heading(theme, "INTENT", width));
    lines.push(theme.fg("text", project.direction.intent || "not defined"));
    lines.push(...heading(theme, "VALUES", width));
    if (project.direction.values.length === 0) lines.push(theme.fg("dim", "none"));
    for (const value of project.direction.values) lines.push(...bulletLines(theme, "• ", theme.fg("text", value), width));
    lines.push(...heading(theme, "CONCEPTS", width));
    if (project.direction.concepts.length === 0) lines.push(theme.fg("dim", "none"));
    for (const concept of project.direction.concepts) {
      lines.push(...bulletLines(theme, "• ", `${theme.fg("muted", `[${concept.type}]`)} ${theme.fg("text", concept.text)}`, width));
    }
    return lines;
  },
};

const GOAL_GROUPS: Array<{ label: string; statuses: string[]; tone: "accent" | "success" | "muted" }> = [
  { label: "ACTIVE", statuses: ["ACTIVE"], tone: "accent" },
  { label: "COMPLETED", statuses: ["COMPLETED"], tone: "success" },
  { label: "NOT PURSUED", statuses: ["FAILED", "ABANDONED", "SUPERSEDED"], tone: "muted" },
];

/** Goals in visual order — the same order the goals view draws and ↑↓ walks. */
export function orderedGoalIds(project: Project): string[] {
  return GOAL_GROUPS.flatMap((group) =>
    project.goals
      .filter((goal) => group.statuses.includes(goal.status))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id, undefined, { numeric: true }))
      .map((goal) => goal.id),
  );
}

const goalsView: ViewDefinition = {
  id: "goals",
  statesKeys: true,
  title: "Goals",
  rows: (project) => orderedGoalIds(project),
  detail: (project, focus) => {
    const goal = project.goals.find((candidate) => candidate.id === focus);
    return goal ? detailForGoal(goal) : emptyDetail("Goals", "no goal selected");
  },
  render(project, theme, width, focus, options) {
    if (project.goals.length === 0) {
      return [`  ${theme.fg("dim", "no goals yet")}`, `  ${theme.fg("dim", "press e to add one, or ask the agent")}`];
    }
    const lines: string[] = [];
    let focusLine: number | undefined;
    const bloatedIds = overBudgetEntityIds(project);
    // Archived goals leave the active groups but are never deleted, so the view
    // states how many it is hiding rather than silently showing fewer rows.
    const hidden = project.goals.filter(isArchived).length;
    const visible = options?.showArchived ? project.goals : project.goals.filter((goal) => !isArchived(goal));
    // The archived count rides in the first group header rather than its own line:
    // k3 found a full line of chrome per panel for state that fits in the header.
    const archiveNote =
      hidden > 0
        ? `${options?.showArchived ? "showing " : ""}${hidden} archived · v`
        : "";
    let archiveNoteUsed = false;
    for (const group of GOAL_GROUPS) {
      const goals = visible
        .filter((goal) => group.statuses.includes(goal.status))
        .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id, undefined, { numeric: true }));
      if (goals.length === 0) continue;
      const meta = `${goals.length}${archiveNote && !archiveNoteUsed ? ` · ${archiveNote}` : ""}`;
      if (archiveNote && !archiveNoteUsed) archiveNoteUsed = true;
      lines.push(sectionHeader(theme, group.label, meta, width, group.tone));
      for (const goal of goals) {
        const band = priorityBand(goal.priority);
        const head = `${bloatedIds.has(`goal:${goal.id}`) && goal.status === "ACTIVE" ? theme.fg("warning", "⚠ ") : ""}${theme.fg(group.tone === "muted" ? "dim" : group.tone, statusGlyph(goal.status))} ${theme.fg("muted", goal.id.padEnd(4))}`;
        // An archived row that looked identical to an active one would be a trap.
        // The word, not ⌫: that glyph means delete/backspace, and D really does
        // delete here, so a ⌫ beside a row reads as "marked for deletion".
        const archivedMark = isArchived(goal) ? theme.fg("dim", "archived ") : "";
        // A goal at 100% but still ACTIVE is not closed, and the plan panel spends
        // the ✓ glyph on a *done* node, so reusing it here for an open goal taught
        // the reader that ✓100% means done while the counter said 0/1 (k3). The
        // word does the work instead: the tick stays a completion mark.
        const percent =
          goal.percent === null
            ? ""
            : `${theme.fg("accent", percentBadge(goal.percent).padStart(4))}${goal.percent === 100 && goal.status === "ACTIVE" ? theme.fg("dim", " finished?") : ""} `;
        const extra = goal.successCriteria.length > 0 ? `${goal.successCriteria.length} ${goal.successCriteria.length === 1 ? "criterion" : "criteria"}` : "no criteria";
        const tail = `${percent}${bandColor(theme, band)(band.padEnd(8))} ${theme.fg("dim", extra)}`;
        const available = Math.max(10, 66 - visibleWidth(head) - visibleWidth(tail) - 2);
        const flat = oneLine(goal.title);
        const title = flat.length > available ? `${flat.slice(0, available - 1)}…` : flat;
        const selected = goal.id === focus;
        if (selected) focusLine = lines.length;
        lines.push(containerRow(theme, `${head}${theme.fg("text", title)}${" ".repeat(Math.max(1, available - visibleWidth(title) + 1))}${archivedMark}${tail}`, width, selected));
        if (goal.supersededBy) lines.push(containerNote(theme, theme.fg("dim", `superseded by ${goal.supersededBy}`), width));
      }
      lines.push(containerClose(theme, width));
      lines.push("");
    }
    lines.push(`  ${theme.fg("dim", "↑↓ select · enter read in full · e edit the whole list")}`);
    return { lines, focusLine };
  },
};
const riskGroups: Array<{ label: string; statuses: string[]; tone: "warning" | "success" | "muted" }> = [
  { label: "OPEN", statuses: ["OPEN", "MITIGATING"], tone: "warning" },
  { label: "OCCURRED", statuses: ["OCCURRED"], tone: "warning" },
  { label: "CLOSED", statuses: ["RESOLVED", "ACCEPTED", "CLOSED"], tone: "muted" },
];

/** Rows nobody can act on any more: no point flagging them as over budget. */
const TERMINAL_RISK_STATUSES = new Set(["CLOSED", "RESOLVED", "ACCEPTED"]);

/** Risks in visual order — the same order the risks view draws and ↑↓ walks. */
export function orderedRiskIds(project: Project): string[] {
  return riskGroups.flatMap((group) =>
    byRiskPriority(live(project.risks).filter((risk) => group.statuses.includes(risk.status))).map((risk) => risk.id),
  );
}

const stateView: ViewDefinition = {
  id: "state",
  title: "State",
  detail: (project) => detailForState(project),
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
        // Long items wrap under themselves instead of being cut mid-word.
        const wrapped = wrapTextWithAnsi(theme.fg("muted", item), Math.max(8, width - 8));
        wrapped.forEach((line, index) => lines.push(index === 0 ? containerRow(theme, line, width) : containerNote(theme, line, width)));
      }
      if (items.length > cap) lines.push(containerNote(theme, theme.fg("dim", `… +${items.length - cap} more`), width));
      lines.push(containerClose(theme, width));
    };

    // The headline sentence is never ellipsised: it is why the view is opened.
    // No badge here: every sibling puts a *count of its own items* in that slot,
    // so "1 problem" would read as "one current state" and break the column.
    lines.push(sectionHeader(theme, "CURRENT", "", width, "accent"));
    const current = wrapTextWithAnsi(theme.fg("text", project.state.current || "not recorded"), Math.max(8, width - 8));
    const currentShown = current.slice(0, 10);
    currentShown.forEach((line, index) => lines.push(index === 0 ? containerRow(theme, line, width) : containerNote(theme, line, width)));
    if (current.length > currentShown.length) lines.push(containerNote(theme, theme.fg("dim", `… ${current.length - currentShown.length} more line(s) — enter to read the rest`), width));
    lines.push(containerClose(theme, width));
    list("PROBLEMS", project.state.problems, "warning");
    list("CAPABILITIES", project.state.capabilities, "success");
    list("KNOWN FACTS", project.state.facts, "muted");
    list("CONSTRAINTS", project.state.constraints, "muted");
    list("DISCOVERIES", project.state.discoveries, "success");
    lines.push(sectionHeader(theme, "INITIAL", "", width, "muted"));
    const initial = wrapTextWithAnsi(theme.fg("dim", project.state.initial || "not recorded"), Math.max(8, width - 8));
    initial.slice(0, 4).forEach((line, index) => lines.push(index === 0 ? containerRow(theme, line, width) : containerNote(theme, line, width)));
    lines.push(containerClose(theme, width));
    lines.push(`  ${theme.fg("dim", "enter read every list in full · e edit the state")}`);
    return lines;
  },
};

/** Questions in visual order — open first, then answered, then settled. */
export function orderedQuestionIds(project: Project): string[] {
  const groups = [
    live(project.questions).filter((question) => question.status === "UNKNOWN" || question.status === "PARTIAL"),
    live(project.questions).filter((question) => question.status === "ANSWERED"),
    live(project.questions).filter((question) => question.status === "CONFIRMED" || question.status === "INVALIDATED"),
  ];
  return groups.flatMap((questions) => byQuestionPriority(questions).map((question) => question.id));
}

const intelligenceView: ViewDefinition = {
  id: "intelligence",
  statesKeys: true,
  title: "Intelligence",
  rows: (project) => orderedQuestionIds(project),
  detail: (project, focus) => {
    const question = project.questions.find((candidate) => candidate.id === focus);
    return question ? detailForQuestion(question) : emptyDetail("Intelligence", "no question selected");
  },
  render(project, theme, width, focus) {
    if (project.questions.length === 0) {
      return [`  ${theme.fg("dim", "no questions yet")}`, `  ${theme.fg("dim", "press e to add one, or ask the agent what we don't know")}`];
    }
    const lines: string[] = [];
    let focusLine: number | undefined;
    const bloatedIds = overBudgetEntityIds(project);
    const open = byQuestionPriority(live(project.questions).filter((q) => q.status === "UNKNOWN" || q.status === "PARTIAL"));
    const answered = byQuestionPriority(live(project.questions).filter((q) => q.status === "ANSWERED"));
    const settled = byQuestionPriority(live(project.questions).filter((q) => q.status === "CONFIRMED" || q.status === "INVALIDATED"));

    const group = (label: string, questions: typeof open, tone: "warning" | "success" | "muted"): void => {
      if (questions.length === 0) return;
      lines.push(sectionHeader(theme, label, `${questions.length}`, width, tone));
      for (const question of questions) {
        const band = scoreBand(questionScore(question));
        const open = question.status === "UNKNOWN" || question.status === "PARTIAL";
        const head = `${bloatedIds.has(`question:${question.id}`) && open ? theme.fg("warning", "⚠ ") : ""}${bandColor(theme, band)("?")} ${theme.fg("muted", question.id.padEnd(4))}`;
        const tail = `${bandColor(theme, band)(band.padEnd(8))} ${theme.fg("dim", question.status)}`;
        const available = Math.max(10, 66 - visibleWidth(head) - visibleWidth(tail) - 2);
        const flat = oneLine(question.question);
        const title = flat.length > available ? `${flat.slice(0, available - 1)}…` : flat;
        const selected = question.id === focus;
        if (selected) focusLine = lines.length;
        lines.push(containerRow(theme, `${head}${theme.fg("text", title)}${" ".repeat(Math.max(1, available - visibleWidth(title) + 1))}${tail}`, width, selected));
      }
      lines.push(containerClose(theme, width));
      lines.push("");
    };
    group("OPEN", open, "warning");
    group("ANSWERED", answered, "success");
    group("SETTLED", settled, "muted");
    lines.push(`  ${theme.fg("dim", "↑↓ select · enter read in full · e edit the whole list")}`);
    return { lines, focusLine };
  },
};

const risksView: ViewDefinition = {
  id: "risks",
  statesKeys: true,
  title: "Risks",
  rows: (project) => orderedRiskIds(project),
  detail: (project, focus) => {
    const risk = project.risks.find((candidate) => candidate.id === focus);
    return risk ? detailForRisk(risk) : emptyDetail("Risks", "no risk selected");
  },
  render(project, theme, width, focus, options) {
    if (project.risks.length === 0) {
      return [`  ${theme.fg("dim", "no risks yet")}`, `  ${theme.fg("dim", "press e to add one, or ask the agent how this could fail")}`];
    }
    const lines: string[] = [];
    let focusLine: number | undefined;
    const bloatedIds = overBudgetEntityIds(project);
    const hidden = project.risks.filter(isArchived).length;
    const visible = options?.showArchived ? project.risks : project.risks.filter((risk) => !isArchived(risk));
    const archiveNote = hidden > 0 ? `${options?.showArchived ? "showing " : ""}${hidden} archived · v` : "";
    let archiveNoteUsed = false;
    for (const group of riskGroups) {
      const risks = byRiskPriority(visible.filter((risk) => group.statuses.includes(risk.status)));
      if (risks.length === 0) continue;
      const meta = `${risks.length}${archiveNote && !archiveNoteUsed ? ` · ${archiveNote}` : ""}`;
      if (archiveNote && !archiveNoteUsed) archiveNoteUsed = true;
      lines.push(sectionHeader(theme, group.label, meta, width, group.tone));
      for (const risk of risks) {
        const band = scoreBand(riskScore(risk));
        const mark = bloatedIds.has(`risk:${risk.id}`) && !TERMINAL_RISK_STATUSES.has(risk.status) ? theme.fg("warning", "⚠ ") : "";
        const archivedMark = isArchived(risk) ? theme.fg("dim", "archived ") : "";
        const head = `${mark}${group.tone === "warning" ? bandColor(theme, band)("!") : theme.fg("dim", "·")} ${theme.fg("muted", risk.id.padEnd(4))}`;
        const tail = `${bandColor(theme, band)(band.padEnd(8))} ${theme.fg("dim", `${risk.status === "MITIGATING" ? "MITIGATING · " : ""}exp ${riskExposure(risk).toFixed(2)}`)}`;
        const available = Math.max(10, 66 - visibleWidth(head) - visibleWidth(tail) - 2);
        const flat = oneLine(risk.title);
        const title = flat.length > available ? `${flat.slice(0, available - 1)}…` : flat;
        const selected = risk.id === focus;
        if (selected) focusLine = lines.length;
        lines.push(containerRow(theme, `${head}${theme.fg("text", title)}${" ".repeat(Math.max(1, available - visibleWidth(title) + 1))}${archivedMark}${tail}`, width, selected));
      }
      lines.push(containerClose(theme, width));
      lines.push("");
    }
    lines.push(`  ${theme.fg("dim", "↑↓ select · enter read in full · e edit the whole list")}`);
    return { lines, focusLine };
  },
};

const strategyView: ViewDefinition = {
  id: "strategy",
  title: "Strategy",
  detail: (project) => detailForStrategy(project),
  render(project, theme, width) {
    const lines: string[] = [];
    lines.push(...heading(theme, "CURRENT APPROACH", width));
    lines.push(theme.fg("text", project.strategy.approach || "not defined"));
    const list = (title: string, items: string[]): void => {
      if (items.length === 0) return;
      lines.push(...heading(theme, title.toUpperCase(), width));
      for (const item of items) {
        // Stored priorities are already numbered ("1. …"); one marker is enough.
        lines.push(...bulletLines(theme, "• ", theme.fg("muted", item.replace(/^\s*\d+[.)]\s*/, "")), width));
      }
    };
    list("Strategic hypotheses", project.strategy.hypotheses);
    list("Priorities", project.strategy.priorities);
    list("Alternatives considered", project.strategy.alternatives);
    if (project.strategy.rationale) {
      lines.push(...heading(theme, "RATIONALE", width));
      lines.push(theme.fg("muted", project.strategy.rationale));
    }
    lines.push(`  ${theme.fg("dim", "enter read in full · e edit the strategy")}`);
    return lines;
  },
};

/* ------------------------------------------------------------------ */
/* Reading pane: full, untruncated entity text                        */
/* ------------------------------------------------------------------ */

function emptyDetail(title: string, note: string): DetailDoc {
  return { title, fields: [{ label: "Note", text: note, tone: "dim" }] };
}

function linkList(ids: string[]): string {
  return ids.length > 0 ? ids.join(", ") : "none";
}

/** `goals G1, G2 · risks R1` with empty groups dropped. */
function linkText(groups: Array<[string, string[]]>): string {
  return groups
    .filter(([, ids]) => ids.length > 0)
    .map(([label, ids]) => `${label} ${ids.join(", ")}`)
    .join(" · ");
}

/** `3h ago · 2026-09-13 14:32Z` — relative first, absolute for the record. */
function ageText(at: string): string {
  return `${relativeTime(at)} · ${at.slice(0, 16).replace("T", " ")}Z`;
}

function detailForGoal(goal: Goal): DetailDoc {
  const band = priorityBand(goal.priority);
  const fields: DetailField[] = [{ label: "Description", text: goal.description, kind: "prose" }];
  if (goal.percent !== null) fields.push({ label: "Progress", text: progressBar(goal.percent), tone: "success" });
  if (goal.parent) fields.push({ label: "Parent", text: goal.parent, tone: "dim" });
  const links = linkText([
    ["questions", goal.questions],
    ["risks", goal.risks],
    ["tasks", goal.tasks],
  ]);
  if (links) fields.push({ label: "Links", text: links, tone: "muted" });
  if (goal.supersededBy) fields.push({ label: "Superseded by", text: goal.supersededBy, tone: "dim" });
  fields.push({ label: "Updated", text: ageText(goal.updated), tone: "dim" });
  return {
    title: `${goal.id} · ${goal.title}`,
    // Band word first: "HIGH (P4/5)" cannot be misread the way a bare "P4" can,
  // since P-numbering elsewhere commonly runs the other way (P1 = most urgent).
  meta: `${goal.status} · priority ${band} (P${goal.priority}/5)`,
    fields,
    lists: goal.successCriteria.length > 0 ? [{ label: `Success criteria (${goal.successCriteria.length})`, items: goal.successCriteria, kind: "line" as const }] : [],
  };
}

function detailForQuestion(question: Question): DetailDoc {
  const evidence = question.evidence.map((item) => {
    const where = [item.kind, item.ref].filter(Boolean).join(" — ");
    return where ? `${where}: ${item.description}` : item.description;
  });
  const links = linkText([
    ["goals", question.goals],
    ["risks", question.risks],
    ["tasks", question.tasks],
    ["decisions", question.decisions],
  ]);
  const fields: DetailField[] = [
    { label: "Answer", text: question.answer || "not answered yet", tone: question.answer ? "text" : "dim", kind: "prose" },
    {
      label: "Scores",
      text: `importance ${question.importance.toFixed(2)} · uncertainty ${question.uncertainty.toFixed(2)} · decision impact ${question.decisionImpact.toFixed(2)}`,
      tone: "muted",
    },
  ];
  if (links) fields.push({ label: "Links", text: links, tone: "muted" });
  fields.push({ label: "Updated", text: ageText(question.updated), tone: "dim" });
  return {
    title: `${question.id} · ${question.question}`,
    meta: `${question.status} · ${scoreBand(questionScore(question))} · confidence ${question.confidence.toFixed(2)}`,
    fields,
    lists: [{ label: `Evidence (${evidence.length})`, items: evidence, tone: "muted", kind: "line" }],
  };
}

function detailForRisk(risk: Risk): DetailDoc {
  const owner = risk.owner ? ` · owner ${risk.owner}` : "";
  const links = linkText([
    ["goals", risk.goals],
    ["questions", risk.questions],
    ["tasks", risk.tasks],
  ]);
  const fields: DetailField[] = [{ label: "Description", text: risk.description, kind: "line" }];
  if (risk.mitigation) fields.push({ label: "Mitigation", text: risk.mitigation, tone: "success", kind: "line" });
  if (risk.contingency) fields.push({ label: "Contingency", text: risk.contingency, tone: "warning", kind: "line" });
  if (links) fields.push({ label: "Links", text: links, tone: "muted" });
  fields.push({ label: "Updated", text: ageText(risk.updated), tone: "dim" });
  return {
    title: `${risk.id} · ${risk.title}`,
    meta: `${risk.status} · exposure ${riskExposure(risk).toFixed(2)} (${risk.probability.toFixed(2)} × ${risk.impact.toFixed(2)})${owner}`,
    fields,
  };
}

function detailForEvent(event: HistoryEvent): DetailDoc {
  const fields: DetailField[] = [
    { label: "What happened", text: oneLine(event.summary), kind: "line" },
    { label: "Kind", text: `${event.kind} · by ${event.by}`, tone: "muted" },
    { label: "When", text: ageText(event.at), tone: "dim" },
  ];
  if (event.refs.length > 0) fields.push({ label: "References", text: event.refs.join(", "), tone: "muted" });
  const details: string[] = [];
  for (const [key, value] of Object.entries(event.details ?? {})) details.push(`${humanizeKey(key)}: ${humanizeValue(value)}`);
  return { title: `#${event.seq} · ${event.kind}`, fields, lists: details.length > 0 ? [{ label: `Details (${details.length})`, items: details, tone: "muted" }] : [] };
}

/** `answerStatus` / `answer_status` -> `answer status`, so details read as text. */
function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

/** Flatten nested values into something readable instead of raw JSON. */
function humanizeValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => humanizeValue(item)).join(", ");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => `${humanizeKey(key)} ${humanizeValue(nested)}`)
      .join(", ");
  }
  return String(value);
}

function detailForState(project: Project): DetailDoc {
  const state = project.state;
  return {
    title: "State — full text",
    fields: [
      { label: "Current", text: state.current || "not recorded", kind: "prose" },
      { label: "Initial", text: state.initial || "not recorded", tone: "dim", kind: "prose" },
    ],
    lists: [
      { label: `Problems (${state.problems.length})`, items: state.problems, tone: "warning", kind: "line" },
      { label: `Capabilities (${state.capabilities.length})`, items: state.capabilities, tone: "success", kind: "line" },
      { label: `Known facts (${state.facts.length})`, items: state.facts, tone: "muted", kind: "line" },
      { label: `Constraints (${state.constraints.length})`, items: state.constraints, tone: "muted", kind: "line" },
      { label: `Discoveries (${state.discoveries.length})`, items: state.discoveries, tone: "success", kind: "line" },
    ],
  };
}

function detailForStrategy(project: Project): DetailDoc {
  const strategy = project.strategy;
  return {
    title: "Strategy — full text",
    fields: [
      { label: "Current approach", text: strategy.approach || "not defined", kind: "prose" },
      ...(strategy.rationale ? [{ label: "Rationale", text: strategy.rationale, tone: "muted" as const, kind: "prose" as const }] : []),
    ],
    lists: [
      { label: `Hypotheses (${strategy.hypotheses.length})`, items: strategy.hypotheses.map(stripNumbering), kind: "line" as const },
      { label: `Priorities (${strategy.priorities.length})`, items: strategy.priorities.map(stripNumbering), tone: "success" as const, kind: "line" as const },
      { label: `Alternatives considered (${strategy.alternatives.length})`, items: strategy.alternatives.map(stripNumbering), tone: "muted" as const, kind: "line" as const },
    ],
  };
}

/** Stored list items are often already numbered ("1. …"); the pane adds its own marker. */
function stripNumbering(item: string): string {
  return item.replace(/^\s*\d+[.)]\s*/, "");
}

function detailForDirection(project: Project): DetailDoc {
  const direction = project.direction;
  return {
    title: "Direction — full text",
    fields: [
      { label: "Vision", text: direction.vision || "not defined", kind: "prose" },
      { label: "Intent", text: direction.intent || "not defined", kind: "prose" },
    ],
    lists: [
      { label: `Values (${direction.values.length})`, items: direction.values, kind: "value" },
      { label: `Concepts (${direction.concepts.length})`, items: direction.concepts.map((concept) => `[${concept.type}] ${concept.text}`), tone: "muted", kind: "value" },
    ],
  };
}

function detailForNode(project: Project, node: PlanNode): DetailDoc {
  const plan = activePlan(project);
  const fields: DetailField[] = [
    { label: "Description", text: node.description || "not recorded", kind: "line" },
    { label: "Kind", text: `${node.type} · ${node.status}${node.assignee ? ` · assignee ${node.assignee}` : ""}`, tone: "muted" },
  ];
  if (node.dependsOn.length > 0) {
    const described = node.dependsOn.map((dep) => {
      const target = plan?.nodes.find((candidate) => candidate.id === dep);
      return `${dep} (${target ? target.status : "missing"})`;
    });
    fields.push({ label: "After", text: described.join(", "), tone: "muted" });
  }
  const links: string[] = [];
  if (node.question) links.push(`question ${node.question}`);
  if (node.risk) links.push(`risk ${node.risk}`);
  if (node.goal) links.push(`goal ${node.goal}`);
  if (node.run) links.push(`run ${node.run}`);
  if (links.length > 0) fields.push({ label: "Links", text: links.join(" · "), tone: "muted" });
  if (node.gate) fields.push({ label: "Gate", text: `${node.gate.type}${node.gate.criteria ? ` — ${node.gate.criteria}` : ""}`, tone: "warning", kind: "line" });
  if (node.failureReason) fields.push({ label: "Failure", text: node.failureReason, tone: "error", kind: "line" });
  return {
    title: `${node.id} · ${node.title}`,
    // The meta line carries what the SELECTED box shows, so opening the reading
    // pane never shows less than the row summary it replaced: type, status,
    // readiness, links and dependency count.
    meta: nodeMetaLine(project, node, plan),
    fields,
    lists: node.outputs.length > 0 ? [{ label: `Outputs (${node.outputs.length})`, items: node.outputs, tone: "success" as const, kind: "line" as const }] : [],
  };
}

/** `P2 v2 · TASK · PENDING (ready) · Q2 · no deps` for the reading-pane header. */
function nodeMetaLine(project: Project, node: PlanNode, plan: ReturnType<typeof activePlan>): string {
  const parts: string[] = [];
  if (plan) parts.push(`${plan.id} v${plan.version}`);
  parts.push(node.type, node.status);
  // "ready" and "pending" are different facts, so both are shown: pending is the
  // stored status, ready is the derived one a reader cares about.
  if (plan && readyNodes(plan.nodes).some((candidate) => candidate.id === node.id)) parts.push("ready");
  const links = [node.question, node.risk, node.goal].filter(Boolean);
  if (links.length > 0) parts.push(links.join(" "));
  parts.push(node.dependsOn.length === 0 ? "no deps" : `${node.dependsOn.length} dep${node.dependsOn.length === 1 ? "" : "s"}`);
  void project;
  return parts.join(" · ");
}

/**
 * Render a DetailDoc for the reading pane: headings, wrapped prose and bullet
 * lists, every line inside `width`. Nothing is truncated — the pane scrolls.
 */
export function renderDetailDoc(theme: Theme, doc: DetailDoc, width: number): string[] {
  const lines: string[] = [];
  // The title and its meta line live inside the READING box, so the box is opened
  // by the header and closed only after them. Closing it first left the title
  // floating outside its own container, which reads as a render bug.
  lines.push(sectionHeader(theme, "READING", "esc back · j/k scroll", width, "accent"));
  const rowWidth = Math.max(8, width - 4);
  for (const line of wrapTextWithAnsi(theme.bold(theme.fg("text", doc.title)), rowWidth)) lines.push(containerRow(theme, line, width));
  if (doc.meta) {
    for (const line of wrapTextWithAnsi(theme.fg("dim", doc.meta), rowWidth)) lines.push(containerNote(theme, line, width));
  }
  lines.push(containerClose(theme, width));
  lines.push("");
  // Empty fields say nothing; a reader should not scroll past "none".
  const placeholders = new Set(["not recorded", "none", "none recorded", "not defined", "not answered yet", "no dependencies"]);
  for (const field of doc.fields) {
    const text = field.text.trim();
    if (text === "" || (placeholders.has(text) && field.tone !== "text")) continue;
    // Twitter-style counter, but only when it has something to say.
    const over = field.kind ? overBudget(field.text, field.kind) : null;
    lines.push(...heading(theme, over ? `${field.label.toUpperCase()} — ${over.exceeded.join(" and ")}, may only shrink` : field.label.toUpperCase(), width));
    for (const line of wrapTextWithAnsi(theme.fg(field.tone ?? "text", field.text), width)) lines.push(line);
    lines.push("");
  }
  for (const list of doc.lists ?? []) {
    if (list.items.length === 0) continue;
    const overCount = list.kind ? list.items.filter((item) => overBudget(item, list.kind!)).length : 0;
    lines.push(...heading(theme, overCount > 0 ? `${list.label.toUpperCase()} — ${overCount} over budget` : list.label.toUpperCase(), width));
    for (const item of list.items) {
      const wrapped = wrapTextWithAnsi(theme.fg(list.tone ?? "text", item), Math.max(4, width - 4));
      wrapped.forEach((line, index) => lines.push(index === 0 ? `  ${theme.fg("accent", "• ")}${line}` : `    ${line}`));
    }
    lines.push("");
  }
  return lines;
}

const planView: ViewDefinition = {
  id: "plan",
  title: "Plan / DAG",
  rows: (project) => flatPlanNodes(project).map((node) => node.id),
  detail: (project, focus) => {
    const node = activePlan(project)?.nodes.find((candidate) => candidate.id === focus);
    return node ? detailForNode(project, node) : emptyDetail("Plan", "no node selected");
  },
  render: (project, theme, width, _focus, options) =>
    renderPlanInteractive(project, theme, width, null, options?.showArchived ?? false).lines,
};

/**
 * Rail order is hierarchical, not alphabetical or by guessed frequency: what the
 * project is (direction, goals, state), what we believe (intelligence, risks,
 * strategy), what we are doing (dashboard, plan, runs), then the record
 * (history, summary). Dashboard leads the execution block because it is the
 * entry point `/project` opens; it is not first overall, because the durable
 * definition of the project outranks a snapshot of today.
 */
const RAW_VIEWS: ViewDefinition[] = [
  directionView,
  goalsView,
  stateView,
  intelligenceView,
  risksView,
  strategyView,
  dashboardView,
  planView,
  runsView,
  historyView,
  summaryView,
];

/**
 * Display options that change what a view shows without changing the project.
 * `showArchived` is per-render rather than per-project: archived items are
 * hidden by default but one keypress brings them back, and nothing is written.
 */
export interface ViewOptions {
  showArchived?: boolean;
}

/**
 * Render a view to width-safe lines and, when the view reports one, the line its
 * focused row landed on. Wrapping happens before the index is resolved, so the
 * browser can scroll the selection into view.
 */
export function renderViewLines(
  view: ViewDefinition,
  project: Project,
  theme: Theme,
  width: number,
  focus: string | null,
  options?: ViewOptions,
): ViewRender {
  const raw = view.render(project, theme, width, focus, options);
  const rawLines = Array.isArray(raw) ? raw : raw.lines;
  const rawFocus = Array.isArray(raw) ? undefined : raw.focusLine;
  const safeWidth = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  let focusLine: number | undefined;
  rawLines.forEach((line, index) => {
    if (rawFocus !== undefined && index === rawFocus) focusLine = lines.length;
    for (const wrapped of wrapTextWithAnsi(line, safeWidth)) lines.push(truncateToWidth(wrapped, safeWidth, "…"));
  });
  return { lines, focusLine };
}

/** Focus-aware definitions used by the browser (row cursor + reading pane). */
export const VIEW_DEFS: ViewDefinition[] = RAW_VIEWS;

/**
 * Public views keep a plain `string[]` render, so callers that only want text
 * (tests, exports) are unaffected by the focus-aware contract above.
 */
export interface PublicView {
  id: string;
  title: string;
  render: (project: Project, theme: Theme, width: number, options?: ViewOptions) => string[];
}

export const VIEWS: PublicView[] = RAW_VIEWS.map((view) => ({
  ...view,
  render: (project: Project, theme: Theme, width: number, options?: ViewOptions) =>
    renderViewLines(view, project, theme, width, null, options).lines,
}));

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
  /** Selected row per view (goals, intelligence, risks...). */
  private cursors = new Map<string, string | null>();
  /** The reading pane is open for the focused row (or the whole section). */
  private detailOpen = false;
  /** List scroll position saved while the reading pane is open. */
  private listScroll = 0;
  private viewIndex = 0;
  private scroll = 0;
  private cachedWidth = -1;
  private notice: string | null = null;
  /** Archived entities are hidden by default; `v` shows them without saving. */
  private showArchived = false;

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
    return VIEW_DEFS[this.viewIndex]!.id;
  }

  private viewDef(): ViewDefinition {
    return VIEW_DEFS[this.viewIndex]!;
  }

  /** Selectable rows of the current view, in visual order. */
  private rowIds(): string[] {
    return this.viewDef().rows?.(this.project) ?? [];
  }

  /** The row `enter` opens: the cursor if it still exists, else the first row. */
  private focusId(): string | null {
    if (this.currentView === "plan") return this.planCursor;
    const rows = this.rowIds();
    if (rows.length === 0) return null;
    const cursor = this.cursors.get(this.currentView) ?? null;
    return cursor && rows.includes(cursor) ? cursor : rows[0]!;
  }

  /** Move the row cursor, keeping the plan's own cursor in step. */
  private setRowCursor(id: string): void {
    this.cursors.set(this.currentView, id);
    if (this.currentView === "plan") this.planCursor = id;
  }

  /** Open the reading pane for the focused row (or the whole section). */
  private openDetail(): void {
    this.listScroll = this.scroll;
    this.detailOpen = true;
    this.scroll = 0;
    this.onChange?.();
  }

  /** Leaving a view forgets its reading pane and scroll position. */
  private resetView(): void {
    this.detailOpen = false;
    this.scroll = 0;
  }

  /** Scroll keys, shared by the list and the reading pane. */
  private scrollBy(data: string, page: number): boolean {
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scroll += 1;
      return true;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scroll = Math.max(0, this.scroll - 1);
      return true;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "space")) {
      this.scroll += page;
      return true;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "b")) {
      this.scroll = Math.max(0, this.scroll - page);
      return true;
    }
    if (matchesKey(data, "g")) {
      this.scroll = 0;
      return true;
    }
    if (matchesKey(data, "shift+g")) {
      this.scroll = Number.MAX_SAFE_INTEGER;
      return true;
    }
    return false;
  }

  /** How many body rows fit, leaving room for our chrome and Pi's own status rows. */
  private viewportHeight(): number {
    const rows = this.getTerminalRows?.() ?? 24;
    // Leave 3 rows for Pi's status/footer area so the dock never has to clip us.
    return Math.max(MIN_VIEWPORT, Math.min(60, rows - CHROME_LINES - 3));
  }

  handleInput(data: string): void {
    // The reading pane is its own mode: escape goes back to the list instead of
    // closing the browser, so reading a long answer is never a trap.
    if (this.detailOpen) {
      if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "enter") || matchesKey(data, "left")) {
        this.detailOpen = false;
        this.scroll = this.listScroll;
        this.onChange?.();
        return;
      }
      if (matchesKey(data, "ctrl+c")) {
        this.onClose();
        return;
      }
      this.scrollBy(data, 10);
      return;
    }
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
      if (matchesKey(data, "enter") || data === "d") {
        this.openDetail();
        return;
      }
      if (matchesKey(data, "e")) {
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
      if (matchesKey(data, "tab") || matchesKey(data, "left") || matchesKey(data, "right") || /^([0-9])$/.test(data)) {
        return;
      }
    } else if (matchesKey(data, "tab") || matchesKey(data, "right") || matchesKey(data, "l")) {
      this.viewIndex = (this.viewIndex + 1) % VIEWS.length;
      this.resetView();
      return;
    } else if (matchesKey(data, "shift+tab") || matchesKey(data, "left") || matchesKey(data, "h")) {
      this.viewIndex = (this.viewIndex - 1 + VIEWS.length) % VIEWS.length;
      this.resetView();
      return;
    } else {
      // 1-9 then 0 covers ten of the eleven views; tab reaches the rest. Two
      // views used to be unreachable by number with no hint that they were.
      const digit = /^([0-9])$/.exec(data);
      if (digit) {
        const value = Number.parseInt(digit[1]!, 10);
        const target = value === 0 ? 9 : value - 1;
        if (target < VIEWS.length) {
          this.viewIndex = target;
          this.resetView();
        }
        return;
      }
    }
    // Rows: ↑↓ move the selection, enter opens the full text.
    const rows = this.rowIds();
    if (rows.length > 0) {
      const index = Math.max(0, rows.indexOf(this.focusId() ?? rows[0]!));
      if (matchesKey(data, "down") || matchesKey(data, "j")) {
        const next = rows[Math.min(rows.length - 1, index + 1)];
        if (next) this.setRowCursor(next);
        this.onChange?.();
        return;
      }
      if (matchesKey(data, "up") || matchesKey(data, "k")) {
        const previous = rows[Math.max(0, index - 1)];
        if (previous) this.setRowCursor(previous);
        this.onChange?.();
        return;
      }
      if (matchesKey(data, "home")) {
        this.setRowCursor(rows[0]!);
        this.onChange?.();
        return;
      }
      if (matchesKey(data, "end")) {
        this.setRowCursor(rows[rows.length - 1]!);
        this.onChange?.();
        return;
      }
    }
    if (matchesKey(data, "enter") && this.viewDef().detail) {
      this.openDetail();
      return;
    }
    // `v` toggles archived rows. It is a view toggle, not a write: showing an
    // archived goal must never change the project.
    if (data === "v" && !this.helpVisible) {
      this.showArchived = !this.showArchived;
      this.notice = this.showArchived ? "showing archived · v to hide" : null;
      this.onChange?.();
      return;
    }
    if (this.scrollBy(data, 10)) return;
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
    const badge = (view: { id: string }): string => {
      const count = counts.get(view.id) ?? 0;
      return count > 0 ? `(${count})` : "";
    };
    // The label is the key that actually reaches the view: 1-9, then 0 for the
    // tenth. The eleventh has no single key, so it names the route that does work.
    const keyFor = (index: number): string => (index === 9 ? "0" : index === 10 ? "tab" : String(index + 1));

    // Wide: every tab keeps its name.
    const named = VIEWS.map((view, index) => {
      const text = `${keyFor(index)}:${view.title}${badge(view)}`;
      return index === this.viewIndex ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text);
    }).join(theme.fg("dim", " · "));
    if (visibleWidth(named) <= width) return named;

    // Medium: numbered tabs plus the active view's name, so any tab can still be
    // identified by running the cursor over it.
    const numbers = VIEWS.map((view, index) => {
      const text = `${keyFor(index)}${badge(view)}`;
      return index === this.viewIndex ? theme.fg("accent", theme.bold(`[${text}]`)) : theme.fg("dim", text);
    }).join(theme.fg("borderMuted", "·"));
    const active = theme.fg("accent", theme.bold(VIEWS[this.viewIndex]!.title));
    const combined = `${numbers}  ${active}`;
    if (visibleWidth(combined) <= width) return combined;

    // Narrow: at least the active name survives.
    if (visibleWidth(numbers) + visibleWidth(active) + 1 <= width) return `${numbers} ${active}`;
    return truncateToWidth(active, width, "…");
  }

  /**
   * Advertises `v` only when the project actually has archived items on a view
   * that can show them: a key that does nothing is worse than no hint. `compact`
   * is used when the footer is tight, because the hint must not push `q` off the
   * edge — a hidden key is worse than a terse one.
   */
  private archivedHint(compact = false): string {
    if (!["goals", "risks", "plan"].includes(this.currentView)) return "";
    if (archivedCounts(this.project).total === 0) return "";
    const verb = this.showArchived ? "hide" : "show";
    return compact ? ` · v ${verb}` : ` · v ${verb} archived`;
  }

  render(width: number): string[] {
    const theme = this.theme;
    if (this.cachedWidth !== width) this.cachedWidth = width;

    const out: string[] = [];
    const view = VIEW_DEFS[this.viewIndex]!;
    const viewport = this.viewportHeight();
    const showingHelp = this.helpVisible && Boolean(this.helpText);

    // Title bar (single line): breadcrumb on the left, status on the right.
    const breadcrumb = showingHelp
      ? `${this.project.meta.name} › Help`
      : `${this.project.meta.name} › ${view.title}${this.detailOpen ? " › reading" : ""}`;
    const plan = activePlan(this.project);
    const status = this.project.meta.completed
      ? "COMPLETED"
      : `${this.project.meta.yolo ? "YOLO · " : ""}${plan ? `${plan.id} v${plan.version}` : "no plan"}`;
    const headerLeft = theme.fg("muted", ` ${breadcrumb}`);
    const headerRight = theme.fg("dim", `${status} `);
    const headerGap = Math.max(1, width - visibleWidth(headerLeft) - visibleWidth(headerRight));
    out.push(truncateToWidth(`${headerLeft}${" ".repeat(headerGap)}${headerRight}`, width, "…"));

    // Tab bar (single line, never wraps).
    out.push(showingHelp ? theme.fg("muted", " project commands and agent tools") : this.tabLine(width));

    // Content window: the list, or the full-text reading pane when open.
    let content: string[];
    let focusLine: number | undefined;
    if (showingHelp) {
      content = fitLines((this.helpText ?? "").split("\n"), width);
    } else if (this.detailOpen) {
      const doc = view.detail?.(this.project, this.focusId()) ?? { title: view.title, fields: [] };
      content = renderDetailDoc(theme, doc, width);
    } else if (view.id === "plan") {
      content = renderPlanInteractive(this.project, theme, width, this.planCursor, this.showArchived).lines;
    } else {
      const rendered = renderViewLines(view, this.project, theme, width, this.focusId(), { showArchived: this.showArchived });
      content = rendered.lines;
      focusLine = rendered.focusLine;
    }
    const maxScroll = Math.max(0, content.length - viewport);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    // Keep the selected row on screen when ↑↓ walks past the viewport.
    if (focusLine !== undefined) {
      if (focusLine < this.scroll) this.scroll = focusLine;
      else if (focusLine >= this.scroll + viewport) this.scroll = Math.min(maxScroll, focusLine - viewport + 1);
    }
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
    const rows = this.rowIds();
    // Views with their own hint line state the select/read keys themselves, so the
    // footer drops them — but only when that line is actually on screen. On a short
    // terminal it scrolls away, and a key you cannot see is a key you do not have.
    const ownHintVisible = this.viewDef().statesKeys === true && this.viewportHeight() > 12;
    // A footer that overflows silently elides real keys — k3 found `q close` and
    // the archived hint disappearing at 80 columns, which is how a fix went
    // missing from the frames a reviewer was given. So the footer is built at
    // three densities and the widest that fits wins: the keys a user needs are
    // never the thing that gets cut.
    const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
    const build = (density: "full" | "tight" | "minimal"): string => {
      const hint = this.archivedHint(density !== "full");
      const help = this.helpText && density === "full" ? " · ? help" : "";
      const scroll = density === "full" ? scrollHint : "";
      if (showingHelp) return "? or esc close help · j/k scroll · q close";
      if (this.detailOpen) return "esc back to the list · j/k scroll · g/G ends · q close";
      const quit = density === "minimal" ? " · q" : " · q close";
      if (this.currentView === "plan") {
        const sel = density === "minimal" ? "↑↓" : "↑↓ · enter read";
        const edit = density === "minimal" ? "e · a · D" : "e · a new · D del · E raw";
        return `${sel} · ${edit}${density === "minimal" ? "" : " · tab"}${hint}${help}${quit}`;
      }
      if (rows.length > 0) {
        const sel = ownHintVisible ? "" : density === "minimal" ? "↑↓ · " : "↑↓ select · enter read in full · ";
        const edit = this.editableViews.has(this.currentView) ? (density === "minimal" ? "e · " : "e edit · ") : "";
        const tabs = density === "minimal" ? "tab" : "tab · 1-9/0 jump";
        return `${sel}${edit}${tabs}${hint}${scroll}${help}${quit}`;
      }
      const edit = this.editableViews.has(this.currentView) ? " · e edit · E raw" : "";
      return `tab · 1-9/0 jump${edit}${this.viewDef().detail ? " · enter read in full" : ""}${hint}${scroll}${help} · r reload${quit}`;
    };
    // The scroll counter sits on the right, so leave it room when there is one.
    const budget = (): number => width - (scrollable ? 14 : 1);
    let keys = build("full");
    if (visibleWidth(` ${plain(keys)}`) > budget()) keys = build("tight");
    if (visibleWidth(` ${plain(keys)}`) > budget()) keys = build("minimal");
    const left = theme.fg("dim", ` ${keys}`);
    const right = theme.fg("dim", `${scrollable ? "↕ " : ""}${range} `);
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    out.push(truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "…"));

    if (this.notice) out.push(truncateToWidth(theme.fg("dim", ` ${this.notice}`), width, "…"));
    return out.map((line) => truncateToWidth(line, width, "…"));
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
  const goals = live(project.goals).filter((goal) => goal.status === "ACTIVE").length;
  const openQuestions = live(project.questions).filter((question) => question.status === "UNKNOWN" || question.status === "PARTIAL").length;

  lines.push(
    theme.fg("accent", `◈ ${project.meta.name}`) +
      theme.fg("dim", project.meta.yolo ? " [YOLO]" : "") +
      theme.fg("muted", `  ${goals} active goals · ${openQuestions} open questions · ${openRisksText(project)}`),
  );
  if (project.meta.paused) {
    lines.push(theme.fg("warning", "  ⏸ PAUSED") + theme.fg("dim", project.meta.resumeNote ? ` · resume: ${project.meta.resumeNote}` : ""));
    return lines.slice(0, maxLines);
  }
  // The objective is what the work is for; it earns a line whenever it is set,
  // labelled so it cannot be mistaken for a hint.
  if (project.meta.objective) {
    lines.push(theme.fg("accent", "  ◆ OBJECTIVE  ") + theme.fg("text", truncateToWidth(project.meta.objective, 120, "…")));
  }
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

/** `2 open risks` — the qualifier matches the rail badge, which also counts open ones. */
function openRisksText(project: Project): string {
  const open = live(project.risks).filter((risk) => risk.status === "OPEN" || risk.status === "MITIGATING").length;
  return `${open} open risks`;
}

/** Plan progress used by the footer status. */
export function statusText(project: Project): string {
  const plan = activePlan(project);
  if (project.meta.paused) return `${project.meta.name}: paused`;
  if (!plan) return project.meta.name;
  const stats = dagStats(plan.nodes);
  return `${project.meta.name}: ${stats.byStatus.COMPLETED}/${stats.total} · ${stats.ready} ready`;
}

/* Re-exported for tests. */
export const internals = { computeDepths, activePlan, statusGlyph };
