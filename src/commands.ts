/**
 * `/project` commands (spec 23). Commands are the human-facing half of the same
 * project-management interface the agent uses through tools. In interactive mode
 * they open the TUI dashboard; in other modes they emit text.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

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
import { EDITABLE_SECTIONS, editableSection, editableSectionIds, type EditableSection } from "./editing.ts";
import { renderReplanAnalysis, renderReviewReport } from "./reports.ts";

export const PROJECT_SUBCOMMANDS = [
  "dashboard",
  "init",
  "edit",
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
  "tools",
  "help",
] as const;

type Subcommand = (typeof PROJECT_SUBCOMMANDS)[number];

/** Single source of truth for discovery: Tab completion, `/project help` and help text. */
export const SUBCOMMAND_INFO: Record<Subcommand, { usage: string; summary: string; details?: string }> = {
  dashboard: { usage: "/project", summary: "open the project dashboard (TUI)" },
  init: {
    usage: "/project init [name]",
    summary: "create a .project/ in this directory",
    details: "Prompts for vision and intent when a UI is available. Refuses if a project already exists here.",
  },
  edit: {
    usage: "/project edit <section>",
    summary: "edit a section as text (same path as agent changes)",
    details: `Sections: ${EDITABLE_SECTIONS.map((section) => section.id).join(", ")}. Also available with the e key in the dashboard. Saving validates the text, records history and commits to git.`,
  },
  status: {
    usage: "/project status",
    summary: "where we are / going / believe / doing",
    details: "The four core questions. In print mode (pi -p) this prints to stdout without a model call.",
  },
  direction: { usage: "/project direction", summary: "vision, intent, values, concepts" },
  goals: { usage: "/project goals", summary: "goals, priorities and outcomes" },
  state: { usage: "/project state", summary: "initial state, current state, capabilities, problems" },
  intelligence: { usage: "/project intelligence", summary: "prioritized questions and answers" },
  risks: { usage: "/project risks", summary: "prioritized risk registry" },
  strategy: { usage: "/project strategy", summary: "approach, hypotheses, priorities, alternatives" },
  plan: {
    usage: "/project plan",
    summary: "active plan DAG, readiness and gate results",
    details: "To execute a node, ask the agent (project_plan node_status). Nodes move PENDING -> RUNNING -> COMPLETED/FAILED.",
  },
  history: { usage: "/project history", summary: "semantic history of significant changes" },
  evolution: { usage: "/project evolution", summary: "how the plan changed and why" },
  runs: { usage: "/project runs", summary: "long-running work records and logs" },
  summary: { usage: "/project summary", summary: "final summary: goal outcomes, risks, decisions, lessons" },
  review: {
    usage: "/project review",
    summary: "strategic review against direction and goals",
    details: "Checks consistency with vision/intent/values/concepts, top unknowns and risks, plan readiness and integrity; offers to record the review as a decision.",
  },
  replan: {
    usage: "/project replan [apply]",
    summary: "analyze (and optionally apply) the smallest useful plan",
    details: "Without 'apply' it shows the analysis and asks before applying. Pivoting is strategic and needs approval (unless YOLO).",
  },
  resume: {
    usage: "/project resume",
    summary: "unfinished runs, interrupted nodes and next actions",
    details: "Optionally reconciles runs whose process is gone to INTERRUPTED.",
  },
  yolo: { usage: "/project yolo [on|off]", summary: "toggle YOLO auto-accept (still recorded)" },
  complete: { usage: "/project complete", summary: "mark the project complete and show the summary" },
  watch: { usage: "/project watch [on|off]", summary: "toggle the editor widget" },
  projects: { usage: "/project projects", summary: "list projects in the local workspace" },
  tools: {
    usage: "/project tools",
    summary: "list the project_* tools the agent can call",
    details: "Human and agent operations are the same; tools are what the agent uses.",
  },
  help: { usage: "/project help [subcommand]", summary: "this reference, or details for one subcommand" },
};

const DASHBOARD_KEYS = "tab/arrows switch view · 1-9 jump · j/k or ↑↓ scroll · space page · g/G top/bottom · e edit · ? help · r reload · q close";

/** Full reference, grouped, generated from SUBCOMMAND_INFO. */
export function renderHelp(pi?: ExtensionAPI): string {
  const lines: string[] = ["Project commands", ""];
  const groups: Array<[string, Subcommand[]]> = [
    ["View", ["dashboard", "status", "direction", "goals", "state", "intelligence", "risks", "strategy", "plan", "history", "evolution", "runs", "summary"]],
    ["Act", ["init", "edit", "review", "replan", "resume", "yolo", "complete", "watch"]],
    ["Discover", ["tools", "projects", "help"]],
  ];
  for (const [title, names] of groups) {
    lines.push(`${title}:`);
    for (const name of names) {
      const info = SUBCOMMAND_INFO[name];
      lines.push(`  ${info.usage.padEnd(26)} ${info.summary}`);
    }
    lines.push("");
  }

  lines.push("Changing work directly: /project edit <section> (or press e in the dashboard).");
  lines.push("Otherwise work is added by talking to the agent, for example:");
  lines.push('  "add a goal to ship the parser, priority 4"            -> project_goal');
  lines.push('  "record what we do not know about the evaluator"       -> project_question');
  lines.push('  "add a risk that the index fails at scale, 0.4 x 0.9"  -> project_risk');
  lines.push('  "turn this into the smallest useful plan"              -> project_replan');
  lines.push('  "start N1 and keep it after I close pi"                -> project_run');
  lines.push("");

  const tools = projectTools(pi);
  if (tools.length > 0) {
    lines.push(`Agent tools (${tools.length}) — run /project tools for details, or ask the agent directly:`);
    lines.push(`  ${tools.map((tool) => tool.name).join(", ")}`);
    lines.push("");
  }

  lines.push(`Dashboard keys: ${DASHBOARD_KEYS}.`);
  return lines.join("\n");
}

/** Details for one subcommand (used by `/project help <sub>`). */
export function renderSubcommandHelp(name: string): string {
  const sub = name.toLowerCase().replace(/^\//, "") as Subcommand;
  const info = SUBCOMMAND_INFO[sub];
  if (!info) return `Unknown subcommand "${name}".\n\n${renderHelp()}`;
  const aliases = sub === "dashboard" ? "\nAliases: `/project` with no argument, `status` in non-TUI modes." : "";
  return [
    `Usage: ${info.usage}`,
    "",
    info.summary,
    ...(info.details ? ["", info.details] : []),
    aliases,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

interface ToolSummary {
  name: string;
  description: string;
  active: boolean;
}

/** The project tools currently visible to the agent (name + first line of description). */
export function projectTools(pi?: ExtensionAPI): ToolSummary[] {
  if (!pi) return [];
  const active = new Set(pi.getActiveTools());
  return pi
    .getAllTools()
    .filter((tool) => tool.name.startsWith("project_"))
    .map((tool) => ({
      name: tool.name,
      description: (tool.description ?? "").split("\n")[0] ?? "",
      active: active.has(tool.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function subcommandCompletions(prefix: string): AutocompleteItem[] | null {
  const items: AutocompleteItem[] = PROJECT_SUBCOMMANDS.filter((name) => name.startsWith(prefix.toLowerCase())).map(
    (name) => ({
      value: name,
      label: name,
      description: SUBCOMMAND_INFO[name].summary,
    }),
  );
  return items.length > 0 ? items : null;
}

export interface CommandUiOptions {
  setWidgetEnabled: (enabled: boolean) => void;
  isWidgetEnabled: () => boolean;
}

export function registerProjectCommands(pi: ExtensionAPI, ui: CommandUiOptions): void {
  pi.registerCommand("project", {
    description: "Project management: dashboard, direction, goals, state, intelligence, risks, strategy, plan, history, runs",
    getArgumentCompletions: subcommandCompletions,
    handler: async (args, ctx) => handleProjectCommand(pi, ui, args, ctx),
  });

  pi.registerCommand("pm", {
    description: "Shorthand for /project",
    getArgumentCompletions: subcommandCompletions,
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
    await showText(pi, ctx, rest ? renderSubcommandHelp(rest) : renderHelp(pi));
    return;
  }

  if (sub === "tools") {
    const tools = projectTools(pi);
    const lines =
      tools.length === 0
        ? "No project_* tools are registered (is the extension loaded?)."
        : tools
            .map((tool) => `- ${tool.active ? "●" : "○"} ${tool.name}: ${tool.description || "(no description)"}`)
            .join("\n");
    await showText(
      pi,
      ctx,
      `Project tools (${tools.length}) — ● active, ○ inactive.\n${lines}\n\nThe agent calls these from natural language; you can also name one explicitly, e.g. "use project_question to add …".`,
    );
    return;
  }

  if (sub === "init") {
    await runInit(pi, ctx, rest);
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
      `No project here. Run /project init to create one, or cd into a project directory.\n\n${renderHelp(pi)}`,
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
    case "edit": {
      if (!rest) {
        await showText(
          pi,
          ctx,
          `Editable sections: ${editableSectionIds().join(", ")}\n\nUsage: /project edit <section>\nYou can also press e inside the dashboard.`,
        );
        return;
      }
      const section = editableSection(rest);
      if (!section) {
        await showText(pi, ctx, `Unknown section "${rest}". Editable: ${editableSectionIds().join(", ")}.`);
        return;
      }
      await runSectionEditor(pi, ctx, manager, section);
      await showBrowser(pi, ctx, manager, section.view);
      return;
    }
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
      await showText(pi, ctx, `Unknown subcommand "${sub}".\n\n${renderHelp(pi)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Subcommand implementations                                         */
/* ------------------------------------------------------------------ */

async function runInit(pi: ExtensionAPI, ctx: ExtensionCommandContext, rest: string): Promise<void> {
  const existing = await ProjectManager.discover(ctx.cwd, { by: "human" });
  if (existing) {
    await showText(pi, ctx, `A project already exists at ${existing.root}.`);
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
  await showBrowser(pi, ctx, manager, "dashboard", `Initialized project "${manager.project.meta.name}".`);
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
  // The browser can hand control back to an editor; loop until the user closes it.
  let currentView = view;
  let pendingNotice = notice;
  for (;;) {
    const action = await openBrowser(pi, ctx, manager, currentView, pendingNotice);
    pendingNotice = undefined;
    if (!action) return;
    const [, sectionId] = /^edit:(.+)$/.exec(action) ?? [];
    if (!sectionId) return;
    const section = editableSection(sectionId);
    if (!section) return;
    currentView = section.view;
    await runSectionEditor(pi, ctx, manager, section);
  }
}

async function openBrowser(
  pi: ExtensionAPI | undefined,
  ctx: ExtensionCommandContext,
  manager: ProjectManager,
  view: string,
  notice?: string,
): Promise<string | null> {
  if (notice) ctx.ui.notify(notice, "info");

  if (ctx.mode !== "tui") {
    const project = await manager.read((current) => current);
    const render = VIEW_FALLBACK[view] ?? renderStatusText;
    await showText(pi, ctx, render(project));
    return null;
  }

  return ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    return new ProjectBrowser({
      project: manager.project,
      theme,
      initialView: view,
      helpText: renderHelp(pi),
      editableViews: EDITABLE_SECTIONS.map((section) => section.view),
      onRequestEdit: (editView) => done(`edit:${editView}`),
      onClose: () => done(null),
      getTerminalRows: () => tui.terminal.rows,
      onChange: () => tui.requestRender(),
      reload: async () => {
        const project = await manager.read((current) => current);
        return project;
      },
    });
  });
}

/**
 * Open the section's on-disk text in Pi's editor. Saving validates, records
 * history and commits exactly like an agent-driven change would.
 */
async function runSectionEditor(
  pi: ExtensionAPI | undefined,
  ctx: ExtensionCommandContext,
  manager: ProjectManager,
  section: EditableSection,
): Promise<void> {
  if (!ctx.hasUI) {
    await showText(
      pi,
      ctx,
      `Editing ${section.label} needs interactive mode. Edit .project/${section.file} directly; the next operation reloads it from disk.`,
    );
    return;
  }

  let text = section.read(manager.project);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const edited = await ctx.ui.editor(
      `Edit ${section.label} — .project/${section.file}  (save = record history + git)`,
      text,
    );
    if (typeof edited !== "string") return; // cancelled
    if (edited.trim() === text.trim()) return; // unchanged

    // Guard against accidentally clearing a whole section (select-all + save).
    if (edited.trim() === "" && text.trim() !== "") {
      const ok = await ctx.ui.confirm("Clear section?", `${section.label} will be emptied. Save anyway?`);
      if (!ok) return;
    }

    if (section.strategic && !manager.project.meta.yolo) {
      const ok = await ctx.ui.confirm(
        "Strategic change",
        `${section.label} affects direction. Save this change?`,
      );
      if (!ok) return;
    }

    try {
      const summary = await section.apply(manager, edited, { approved: true, approvedBy: "human", clock: manager.clock });
      ctx.ui.notify(`${summary}.`, "info");
      return;
    } catch (error) {
      const message = (error as Error).message;
      const retry = await ctx.ui.confirm("Edit rejected", `${message}\n\nEdit again with your text?`);
      if (!retry) {
        await showText(pi, ctx, message);
        return;
      }
      text = edited; // keep the user's text for the retry
    }
  }
  await showText(pi, ctx, "Gave up after three failed saves. Your changes were not applied.");
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
