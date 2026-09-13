/**
 * Pi Project Management Extension
 *
 * A persistent project-management and adaptive-planning layer that sits above
 * individual Pi sessions. See README.md for the full picture; the design follows
 * the specification in spec/Project Management Spec.md.
 *
 * Philosophy: direction is relatively stable, plans are hypotheses, execution
 * generates information, and new information changes the plan.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerProjectCommands } from "./commands.ts";
import { buildDigest } from "./context.ts";
import { statusText, widgetLines } from "./dashboard.ts";
import { ProjectManager } from "./project.ts";
import { isRunning } from "./runs.ts";
import { registerProjectTools } from "./tools.ts";
import type { Project } from "./types.ts";

const WIDGET_KEY = "project-management";

export default function projectManagement(pi: ExtensionAPI): void {
  let widgetEnabled = true;
  let manager: ProjectManager | null = null;
  let currentProject: Project | null = null;

  registerProjectTools(pi);
  registerProjectCommands(pi, {
    setWidgetEnabled: (enabled) => {
      widgetEnabled = enabled;
    },
    isWidgetEnabled: () => widgetEnabled,
  });

  const load = async (ctx: ExtensionContext): Promise<Project | null> => {
    manager = await ProjectManager.discover(ctx.cwd, { by: "agent" });
    currentProject = manager ? await manager.read((project) => project) : null;
    return currentProject;
  };

  const paint = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    if (!currentProject || !widgetEnabled) {
      ctx.ui.setStatus(WIDGET_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const project = currentProject;
    ctx.ui.setStatus(WIDGET_KEY, statusText(project));
    ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
      render: () => widgetLines(project, theme),
      invalidate: () => undefined,
    }));
  };

  /* ---------------- session lifecycle ---------------- */

  pi.on("session_start", async (_event, ctx) => {
    const project = await load(ctx);
    paint(ctx);
    if (project && ctx.hasUI) {
      const stale = project.runs.filter(
        (run) => (run.status === "STARTED" || run.status === "RUNNING") && !isRunning(run.pid),
      );
      if (stale.length > 0) {
        ctx.ui.notify(
          `Project "${project.meta.name}" has ${stale.length} unfinished run(s) (${stale.map((run) => run.id).join(", ")}). ` +
            "Run /project resume or ask to resume.",
          "warning",
        );
      }
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus(WIDGET_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  });

  /* ---------------- keep the widget fresh ---------------- */

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!event.toolName.startsWith("project_")) return;
    if (!manager) return;
    currentProject = await manager.read((project) => project);
    paint(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!manager) return;
    currentProject = await manager.read((project) => project);
    paint(ctx);
  });

  /* ---------------- agent context (spec 24) ---------------- */

  pi.on("before_agent_start", async (_event, ctx) => {
    const project = await load(ctx);
    paint(ctx);
    if (!project) return;

    const digest = buildDigest(project);
    const content = [
      `An active project is attached to this working directory: "${project.meta.name}" (${project.root}).`,
      "Use the project_* tools to read and update it instead of editing .project files by hand.",
      "Keep the plan the smallest one justified by current knowledge; record significant changes as decisions/history;",
      "answer intelligence questions with evidence; update risk probability/impact when evidence appears.",
      project.meta.yolo
        ? "YOLO mode is ON: make the call, but always record what you did and why."
        : "For strategic changes (vision, intent, values, major goals, pivots, completion) ask the human first.",
      "",
      digest,
    ].join("\n");

    return {
      message: {
        customType: "project-management",
        content,
        display: false,
      },
    };
  });
}
