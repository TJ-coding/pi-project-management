/**
 * `/project` commands (spec 23). Commands are the human-facing half of the same
 * project-management interface the agent uses through tools. In interactive mode
 * they open the TUI dashboard; in other modes they emit text.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { buildResumeReport } from "./context.ts";
import { ProjectBrowser, VIEWS } from "./dashboard.ts";
import {
  renderDirectionText,
  renderPlanEvolutionText,
  renderGoalsText,
  renderHistoryText,
  renderIntelligenceText,
  renderPlanText,
  renderRisksText,
  renderRunsText,
  renderStateText,
  renderStatusText,
  renderStrategyText,
} from "./format.ts";
import { renderCompletionSummary } from "./history.ts";
import { ProjectManager } from "./project.ts";
import { renderReplanAnalysis, renderReviewReport } from "./reports.ts";

export const PROJECT_SUBCOMMANDS = [
  "dashboard",
  "init",
  "status",
  "direction",
  "goals",
  "state",
  "intelligence",
  "risks",
  "strategy",
  "plan",
  "history",
  "evolution",
  "runs",
  "summary",
  "review",
  "replan",
  "resume",
  "yolo",
  "complete",
  "watch",
  "projects",
  "help",
] as const;

export interface CommandUiOptions {
  setWidgetEnabled: (enabled: boolean) => void;
  isWidgetEnabled: () => boolean;
}

const HELP = `Project commands

  /project                     open the project dashboard (TUI)
  /project init [name]         initialize a .project/ in this directory
  /project status              overview: where we are / going / believe / doing
  /project direction           vision, intent, values, concepts
  /project goals               goals and their outcomes
  /project state               initial state, current state, capabilities...
  /project intelligence        prioritized questions and answers
  /project risks               prioritized risk registry
  /project strategy            current approach, hypotheses, priorities
  /project plan                active plan DAG and readiness
  /project history             semantic history
  /project evolution           how the plan changed and why
  /project runs                long-running work records
  /project summary             final project summary (goals, risks, lessons)
  /project review              strategic review against direction and goals
  /project replan [apply]      analyze (and optionally apply) a new plan
  /project resume              inspect unfinished work after interruption
  /project yolo [on|off]       toggle YOLO auto-accept mode
  /project complete            mark the project complete and show the summary
  /project watch [on|off]      toggle the editor widget
  /project projects            list projects in the local workspace
  /project help                this help

Keyboard in the dashboard: tab/arrows switch view, 1-9 jump, j/k scroll, r reload, q close.`;

export function registerProjectCommands(pi: ExtensionAPI, ui: CommandUiOptions): void {
  pi.registerCommand("project", {
    description: "Project management: dashboard, direction, goals, state, intelligence, risks, strategy, plan, history, runs",
    getArgumentCompletions: (prefix: string) => {
      const items = PROJECT_SUBCOMMANDS.filter((name) => name.startsWith(prefix)).map((name) => ({
        value: name,
        label: name,
      }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => handleProjectCommand(pi, ui, args, ctx),
  });

  pi.registerCommand("pm", {
    description: "Shorthand for /project",
    getArgumentCompletions: (prefix: string) => {
      const items = PROJECT_SUBCOMMANDS.filter((name) => name.startsWith(prefix)).map((name) => ({
        value: name,
        label: name,
      }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => handleProjectCommand(pi, ui, args, ctx),
  });
}

async function handleProjectCommand(
  pi: ExtensionAPI,
  ui: CommandUiOptions,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const trimmed = args.trim();
  const [rawSub, ...restParts] = trimmed.split(/\s+/);
  const sub = (rawSub ?? "").toLowerCase();
  const rest = restParts.join(" ").trim();

  if (sub === "help" || sub === "-h" || sub === "--help") {
    await showText(pi, ctx, HELP);
    return;
  }

  if (sub === "init") {
    await runInit(ctx, rest);
    return;
  }

  if (sub === "projects") {
    const workspace = await (await import("./storage.ts")).loadWorkspace();
    const lines = workspace.projects.length === 0
      ? "No projects registered in the local workspace yet. Use /project init inside a directory."
      : workspace.projects
          .map((entry) => `- ${entry.name}: ${entry.path}${workspace.active === entry.name ? " (active)" : ""}`)
          .join("\n");
    await showText(pi, ctx, `Workspace projects (${workspace.projects.length}):\n${lines}`);
    return;
  }

  const manager = await ProjectManager.discover(ctx.cwd, { by: "human" });
  if (!manager) {
    await showText(
      pi,
      ctx,
      `No project here. Run /project init to create one, or cd into a project directory.\n\n${HELP}`,
    );
    return;
  }

  switch (sub) {
    case "":
    case "dashboard":
    case "status":
      await showBrowser(pi, ctx, manager, "dashboard");
      return;
    case "direction":
      await showBrowser(pi, ctx, manager, "direction");
      return;
    case "goals":
      await showBrowser(pi, ctx, manager, "goals");
      return;
    case "state":
      await showBrowser(pi, ctx, manager, "state");
      return;
    case "intelligence":
      await showBrowser(pi, ctx, manager, "intelligence");
      return;
    case "risks":
      await showBrowser(pi, ctx, manager, "risks");
      return;
    case "strategy":
      await showBrowser(pi, ctx, manager, "strategy");
      return;
    case "plan":
      await showBrowser(pi, ctx, manager, "plan");
      return;
    case "history":
      await showBrowser(pi, ctx, manager, "history");
      return;
    case "evolution":
      await showBrowser(pi, ctx, manager, "summary");
      return;
    case "runs":
      await showBrowser(pi, ctx, manager, "runs");
      return;
    case "summary":
      await showBrowser(pi, ctx, manager, "summary");
      return;
    case "review":
      await runReview(pi, ctx, manager);
      return;
    case "replan":
      await runReplan(pi, ctx, manager, rest);
      return;
    case "resume":
      await runResume(pi, ctx, manager);
      return;
    case "yolo":
      await runYolo(pi, ctx, manager, rest);
      return;
    case "complete":
      await runComplete(pi, ctx, manager);
      return;
    case "watch":
      await runWatch(pi, ctx, ui, rest);
      return;
    default:
      await showText(pi, ctx, `Unknown subcommand "${sub}".\n\n${HELP}`);
  }
}

/* ------------------------------------------------------------------ */
/* Subcommand implementations                                         */
/* ------------------------------------------------------------------ */

async function runInit(ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const existing = await ProjectManager.discover(ctx.cwd, { by: "human" });
  if (existing) {
    await showText(undefined, ctx, `A project already exists at ${existing.root}.`);
    return;
  }
  const name = rest || ctx.cwd.split("/").filter(Boolean).pop() || "project";
  let vision = "";
  let intent = "";
  if (ctx.hasUI) {
    const visionAnswer = await ctx.ui.editor(
      "Vision — what should this project become? (Esc to skip)",
      "",
    );
    if (typeof visionAnswer === "string") vision = visionAnswer;
    const intentAnswer = await ctx.ui.editor("Intent — why does this project exist? (Esc to skip)", "");
    if (typeof intentAnswer === "string") intent = intentAnswer;
  }
  const manager = await ProjectManager.init(ctx.cwd, { name, vision, intent, by: "human" });
  await showBrowser(undefined, ctx, manager, "dashboard", `Initialized project "${manager.project.meta.name}".`);
}

async function runReview(pi: ExtensionAPI, ctx: ExtensionCommandContext, manager: ProjectManager): Promise<void> {
  const report = await manager.read((project) => renderReviewReport(project));
  if (!ctx.hasUI) {
    await showText(pi, ctx, report);
    return;
  }
  const record = await ctx.ui.confirm("Strategic review", "Record this review as a project decision?");
  if (record) {
    await manager.recordDecision(
      {
        title: "Strategic review",
        decision: "Strategic review completed",
        rationale: report,
        authority: "SIGNIFICANT",
      },
      { commit: true },
    );
  }
  await showText(pi, ctx, `${record ? "Review recorded as a decision.\n\n" : ""}${report}`);
}

async function runReplan(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  manager: ProjectManager,
  rest: string,
): Promise<void> {
  const proposal = await manager.read(() => manager.analyzeReplan({ trigger: "manual replan from /project replan" }));
  const analysis = await manager.read((project) => renderReplanAnalysis(project, proposal));

  const wantsApply = rest.includes("apply") || rest.includes("yes");
  if (!wantsApply) {
    if (!ctx.hasUI) {
      await showText(pi, ctx, analysis);
      return;
    }
    const apply = await ctx.ui.confirm("Replan", `Apply ${proposal.title}?\n\n${proposal.rationale}`);
    if (!apply) {
      await showText(pi, ctx, analysis);
      return;
    }
  }

  let approved = false;
  if (ctx.hasUI && !manager.project.meta.yolo) {
    approved = await ctx.ui.confirm("Strategic approval", "A plan change is recorded as a new plan version. Approve?");
  }
  const pivot = ctx.hasUI ? await ctx.ui.confirm("Pivot?", "Is this a fundamental pivot (strategic change)?") : false;
  const outcome = await manager.applyReplan(proposal, { approved, approvedBy: approved ? "human" : undefined, pivot });
  if (outcome.status === "requires-approval") {
    await showText(pi, ctx, `${outcome.message}\n\n${analysis}`);
    return;
  }
  await showBrowser(pi, ctx, manager, "plan", `Applied plan ${outcome.value.plan.id} (v${outcome.value.plan.version}).`);
}

async function runResume(pi: ExtensionAPI, ctx: ExtensionCommandContext, manager: ProjectManager): Promise<void> {
  let reconciled = "not requested";
  if (ctx.hasUI) {
    const doReconcile = await ctx.ui.confirm(
      "Resume",
      "Mark runs without a live process as INTERRUPTED before resuming?",
    );
    if (doReconcile) {
      const changed = await manager.reconcileRuns();
      reconciled = changed.length === 0 ? "no stale runs" : `marked interrupted: ${changed.map((run) => run.id).join(", ")}`;
    }
  }
  const report = await manager.read((project) => buildResumeReport(project));
  await showText(pi, ctx, `${report}\n\n(reconcile: ${reconciled})`);
}

async function runYolo(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  manager: ProjectManager,
  rest: string,
): Promise<void> {
  const enable = rest === "on" ? true : rest === "off" ? false : !manager.project.meta.yolo;
  await manager.setYolo(enable);
  await showText(
    pi,
    ctx,
    `YOLO mode ${enable ? "enabled" : "disabled"}. ${
      enable
        ? "Strategic decisions will be auto-accepted and recorded in history."
        : "Strategic decisions will ask for human approval."
    }`,
  );
}

async function runComplete(pi: ExtensionAPI, ctx: ExtensionCommandContext, manager: ProjectManager): Promise<void> {
  let approved = false;
  if (ctx.hasUI && !manager.project.meta.yolo) {
    approved = await ctx.ui.confirm("Complete project", "Mark this project complete?");
    if (!approved) return;
  }
  const outcome = await manager.completeProject({ approved, approvedBy: approved ? "human" : undefined });
  if (outcome.status === "requires-approval") {
    await showText(pi, ctx, outcome.message);
    return;
  }
  await showBrowser(pi, ctx, manager, "summary", "Project marked complete.");
  void renderCompletionSummary;
}

async function runWatch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  ui: CommandUiOptions,
  rest: string,
): Promise<void> {
  const enable = rest === "on" ? true : rest === "off" ? false : !ui.isWidgetEnabled();
  ui.setWidgetEnabled(enable);
  await showText(pi, ctx, `Project widget ${enable ? "enabled" : "disabled"}.`);
}

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                  */
/* ------------------------------------------------------------------ */

const VIEW_FALLBACK: Record<string, (project: Parameters<typeof renderStatusText>[0]) => string> = {
  dashboard: renderStatusText,
  direction: renderDirectionText,
  goals: (project) => renderGoalsText(project),
  state: renderStateText,
  intelligence: (project) => renderIntelligenceText(project, 50),
  risks: (project) => renderRisksText(project, 50),
  strategy: renderStrategyText,
  plan: (project) => renderPlanText(project),
  history: (project) => renderHistoryText(project, 100),
  evolution: (project) => renderPlanEvolutionText(project),
  runs: (project) => renderRunsText(project, 30),
  summary: renderCompletionSummary,
};

async function showBrowser(
  pi: ExtensionAPI | undefined,
  ctx: ExtensionCommandContext,
  manager: ProjectManager,
  view: string,
  notice?: string,
): Promise<void> {
  if (notice) ctx.ui.notify(notice, "info");

  if (ctx.mode !== "tui") {
    const project = await manager.read((current) => current);
    const render = VIEW_FALLBACK[view] ?? renderStatusText;
    await showText(pi, ctx, render(project));
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    return new ProjectBrowser({
      project: manager.project,
      theme,
      initialView: view,
      onClose: () => done(),
      getTerminalRows: () => tui.terminal.rows,
      onChange: () => tui.requestRender(),
      reload: async () => {
        const project = await manager.read((current) => current);
        return project;
      },
    });
  });
}

async function showText(
  pi: ExtensionAPI | undefined,
  ctx: ExtensionCommandContext,
  text: string,
): Promise<void> {
  if (ctx.hasUI) {
    ctx.ui.notify(text, "info");
    return;
  }
  // Print mode: stdout is a plain text stream, so the text is the command output.
  if (ctx.mode === "print") {
    process.stdout.write(`${text}\n`);
    return;
  }
  if (pi) {
    pi.appendEntry("project-output", { text });
  }
}

/** Used by tests: every view has a text fallback. */
export function viewFallbacks(): string[] {
  return [...VIEWS.map((view) => view.id), ...Object.keys(VIEW_FALLBACK)];
}
