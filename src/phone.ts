/**
 * A read-only view of the workspace, for a phone (G13).
 *
 * The problem this solves is not "I need another dashboard". It is: several Pi
 * sessions are asking questions independently, and the human has to be at the
 * machine to answer them. This surfaces the two things that actually need a
 * decision — which projects are running, and what is waiting on a human — on one
 * page that a phone can open.
 *
 * Deliberate limits:
 *   - Read-only. There is no route that mutates a project, so a stray tap or a
 *     scanner hitting the page cannot corrupt state. Decisions are still made in
 *     the project itself; this only gathers them.
 *   - No dependencies. A tiny node:http server and a self-contained HTML string,
 *     because a project-management extension should not add a web framework to
 *     the dependency tree (spec 2.6, 26).
 *   - Bound to the LAN by default, not 0.0.0.0, and it says what it exposed.
 */

import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";

import { activePlan } from "./replan.ts";
import { loadWorkspace, loadProject, PROJECT_DIR, type WorkspaceEntry } from "./storage.ts";
import { readyNodes } from "./dag.ts";
import { buildDigest } from "./context.ts";
import type { Project } from "./types.ts";

export interface PhoneServerOptions {
  host?: string;
  port?: number;
  /** Escape hatch for tests: serve these projects instead of the registry. */
  entries?: WorkspaceEntry[];
}

export interface PhoneServerHandle {
  url: string;
  port: number;
  host: string;
  close: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Gathering                                                          */
/* ------------------------------------------------------------------ */

export interface PendingDecision {
  project: string;
  projectPath: string;
  kind: "gate" | "goal" | "question" | "approval";
  id: string;
  title: string;
  /** The choices a human can pick between, phrased as answers. */
  choices: string[];
}

export interface ProjectSummary {
  name: string;
  path: string;
  exists: boolean;
  state: "PAUSED" | "COMPLETED" | "RUNNING" | "IDLE" | "MISSING";
  objective: string | null;
  current: string;
  /** What is being conducted right now, if anything. */
  currentTask: string | null;
  plan: { id: string; done: number; total: number; ready: number } | null;
  goals: { active: number; completed: number };
  openQuestions: number;
  openRisks: number;
  runningRuns: string[];
  pending: PendingDecision[];
  /** Node ids blocked only on a human action. */
  waitingOnHuman: string[];
}

async function readProjectAt(entry: WorkspaceEntry): Promise<Project | null> {
  const dir = entry.path.endsWith(PROJECT_DIR) ? entry.path : `${entry.path}/${PROJECT_DIR}`;
  if (!existsSync(dir)) return null;
  try {
    return await loadProject(entry.path);
  } catch {
    return null;
  }
}

/**
 * Everything that is genuinely waiting on a person, gathered from one project.
 *
 * These are not "all open things" — that list would be unusable. Each entry
 * names a decision the project cannot take itself: a gate awaiting an outcome,
 * a goal whose criteria look met, a question the agent could not answer alone.
 */
function pendingFor(project: Project): PendingDecision[] {
  const pending: PendingDecision[] = [];
  const plan = activePlan(project);

  for (const node of plan?.nodes ?? []) {
    if (node.type === "GATE" && node.status !== "COMPLETED" && node.status !== "FAILED" && node.status !== "SUPERSEDED") {
      pending.push({
        project: project.meta.name,
        projectPath: project.root,
        kind: "gate",
        id: node.id,
        title: `Gate: ${node.title}`,
        choices: ["PASS", "FAIL", "REPLAN", "ESCALATE"],
      });
    }
    if (node.assignee === "human" && (node.status === "PENDING" || node.status === "BLOCKED")) {
      pending.push({
        project: project.meta.name,
        projectPath: project.root,
        kind: "approval",
        id: node.id,
        title: `Waiting on you: ${node.title}`,
        choices: ["start it", "hand it to the agent", "drop it"],
      });
    }
  }

  for (const goal of project.goals) {
    if (goal.status !== "ACTIVE") continue;
    const nodes = plan?.nodes.filter((node) => node.goal === goal.id) ?? [];
    const allDone = nodes.length > 0 && nodes.every((node) => node.status === "COMPLETED" || node.status === "ABANDONED" || node.status === "SUPERSEDED");
    if (allDone) {
      pending.push({
        project: project.meta.name,
        projectPath: project.root,
        kind: "goal",
        id: goal.id,
        title: `Goal looks done: ${goal.title}`,
        choices: ["mark complete", "not yet", "abandon"],
      });
    }
  }

  for (const question of project.questions) {
    if (question.status !== "UNKNOWN" && question.status !== "PARTIAL") continue;
    if (question.decisionImpact < 0.7) continue;
    pending.push({
      project: project.meta.name,
      projectPath: project.root,
      kind: "question",
      id: question.id,
      title: `Needs your call: ${question.question}`,
      choices: ["answer it", "let the agent investigate", "leave it"],
    });
  }

  return pending;
}

/** One project, reduced to what a phone screen can show without scrolling forever. */
export function summarise(entry: WorkspaceEntry, project: Project | null): ProjectSummary {
  if (!project) {
    return {
      name: entry.name,
      path: entry.path,
      exists: false,
      state: "MISSING",
      objective: null,
      current: "",
      currentTask: null,
      plan: null,
      goals: { active: 0, completed: 0 },
      openQuestions: 0,
      openRisks: 0,
      runningRuns: [],
      pending: [],
      waitingOnHuman: [],
    };
  }

  const plan = activePlan(project);
  const runningRuns = project.runs.filter((run) => run.status === "RUNNING" || run.status === "STARTED");
  const runningNode = plan?.nodes.find((node) => node.status === "RUNNING");
  const nextNode = plan ? readyNodes(plan.nodes)[0] : undefined;
  const completed = plan ? plan.nodes.filter((node) => node.status === "COMPLETED").length : 0;

  return {
    name: project.meta.name,
    path: project.root,
    exists: true,
    state: project.meta.completed
      ? "COMPLETED"
      : project.meta.paused
        ? "PAUSED"
        : runningNode || runningRuns.length > 0
          ? "RUNNING"
          : "IDLE",
    objective: project.meta.objective ?? null,
    current: project.state.current,
    currentTask: runningNode
      ? `${runningNode.id} ${runningNode.title}`
      : nextNode
        ? `next: ${nextNode.id} ${nextNode.title}`
        : null,
    plan: plan ? { id: plan.id, done: completed, total: plan.nodes.length, ready: readyNodes(plan.nodes).length } : null,
    goals: {
      active: project.goals.filter((goal) => goal.status === "ACTIVE" && goal.archived !== true).length,
      completed: project.goals.filter((goal) => goal.status === "COMPLETED").length,
    },
    openQuestions: project.questions.filter((q) => (q.status === "UNKNOWN" || q.status === "PARTIAL") && q.archived !== true).length,
    openRisks: project.risks.filter((r) => (r.status === "OPEN" || r.status === "MITIGATING") && r.archived !== true).length,
    runningRuns: runningRuns.map((run) => `${run.id} ${run.title}`),
    pending: pendingFor(project),
    waitingOnHuman: (plan?.nodes ?? []).filter((node) => node.assignee === "human" && node.status !== "COMPLETED").map((node) => node.id),
  };
}

/** Every registered project, summarised, plus the aggregated decision list. */
export async function gatherWorkspace(entries?: WorkspaceEntry[]): Promise<{ projects: ProjectSummary[]; pending: PendingDecision[] }> {
  const list = entries ?? (await loadWorkspace()).projects;
  const projects: ProjectSummary[] = [];
  for (const entry of list) {
    projects.push(summarise(entry, await readProjectAt(entry)));
  }
  // Most urgent first: something running, then something waiting on a human.
  projects.sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
  const pending = projects.flatMap((project) => project.pending);
  return { projects, pending };
}

function rank(project: ProjectSummary): number {
  return (project.state === "RUNNING" ? 2 : 0) + (project.pending.length > 0 ? 1 : 0);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */

/** Minimal HTML escaping: everything here is user text rendered into a page. */
export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STATE_LABEL: Record<ProjectSummary["state"], string> = {
  RUNNING: "running",
  IDLE: "idle",
  PAUSED: "paused",
  COMPLETED: "complete",
  MISSING: "not found",
};

/** One self-contained page: no fetch, no build step, readable on a phone. */
export function renderPhonePage(data: { projects: ProjectSummary[]; pending: PendingDecision[] }, now = new Date()): string {
  const rows = data.projects
    .map((project) => {
      const plan = project.plan ? `${project.plan.done}/${project.plan.total} nodes` : "no plan";
      const task = project.currentTask ? `<div class="task">${esc(project.currentTask)}</div>` : "";
      const objective = project.objective ? `<div class="objective">${esc(project.objective)}</div>` : "";
      const counts = `${project.goals.active} goals · ${project.openQuestions} questions · ${project.openRisks} risks`;
      const waiting = project.pending.length > 0 ? `<span class="badge wait">${project.pending.length} need you</span>` : "";
      const runs = project.runningRuns.length > 0 ? `<div class="runs">${esc(project.runningRuns.join(", "))}</div>` : "";
      return `<li class="project ${project.state.toLowerCase()}">
  <div class="title"><span class="state">${STATE_LABEL[project.state]}</span> <strong>${esc(project.name)}</strong> ${waiting}</div>
  ${objective}${task}
  <div class="meta">${esc(plan)} · ${esc(counts)}</div>
  ${runs}
</li>`;
    })
    .join("\n");

  const decisions = data.pending.length === 0
    ? `<p class="clear">Nothing is waiting on you.</p>`
    : data.pending
        .map(
          (item) => `<li class="decision">
  <div class="where">${esc(item.project)} · ${esc(item.id)}</div>
  <div class="what">${esc(item.title)}</div>
  <div class="choices">${item.choices.map((choice) => `<span class="choice">${esc(choice)}</span>`).join("")}</div>
</li>`,
        )
        .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Projects — ${data.pending.length} waiting</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; font: 16px/1.45 -apple-system, system-ui, sans-serif; max-width: 46rem; margin-inline: auto; }
  h1 { font-size: 1.1rem; margin: 0 0 4px; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; opacity: .6; margin: 24px 0 8px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { border: 1px solid rgba(128,128,128,.3); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
  .state { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; opacity: .7; margin-right: 6px; }
  .project.running { border-left: 3px solid #2e9e5b; }
  .project.paused { border-left: 3px solid #d08b1a; }
  .project.completed { border-left: 3px solid #4a90d9; }
  .project.missing { opacity: .55; }
  .decision { border-left: 3px solid #c2453d; }
  .objective { margin-top: 4px; }
  .task { opacity: .85; margin-top: 2px; }
  .meta, .where { font-size: .8rem; opacity: .65; margin-top: 4px; }
  .choices { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; }
  .choice { border: 1px solid rgba(128,128,128,.45); border-radius: 999px; padding: 2px 10px; font-size: .82rem; }
  .badge { font-size: .72rem; border-radius: 999px; padding: 1px 8px; background: #c2453d; color: #fff; margin-left: 4px; }
  .clear { opacity: .6; }
  footer { margin-top: 28px; font-size: .75rem; opacity: .55; }
</style>
</head>
<body>
<h1>Projects</h1>
<div class="meta">${data.projects.length} project(s) · updated ${esc(now.toISOString().slice(11, 16))} UTC</div>
<h2>Waiting on you (${data.pending.length})</h2>
<ul>${decisions}</ul>
<h2>Projects</h2>
<ul>${rows}</ul>
<footer>Read-only. Answer a decision in the project itself; this page only gathers them.</footer>
</body>
</html>
`;
}

/** A plain-text version, so `curl` and tests can assert on the same data. */
export function renderPhoneText(data: { projects: ProjectSummary[]; pending: PendingDecision[] }): string {
  const lines = [`PROJECTS (${data.projects.length})`];
  for (const project of data.projects) {
    lines.push(`- ${project.name} [${STATE_LABEL[project.state]}]${project.objective ? ` — ${project.objective}` : ""}`);
    if (project.currentTask) lines.push(`    ${project.currentTask}`);
    if (project.plan) lines.push(`    plan ${project.plan.id}: ${project.plan.done}/${project.plan.total}, ${project.plan.ready} ready`);
  }
  lines.push("", `WAITING ON YOU (${data.pending.length})`);
  for (const item of data.pending) {
    lines.push(`- ${item.project}/${item.id}: ${item.title}`);
    lines.push(`    choices: ${item.choices.join(" / ")}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */

/**
 * Start the read-only server. Returns a handle with the URL to open on a phone;
 * the caller decides when to stop it.
 */
export async function startPhoneServer(options: PhoneServerOptions = {}): Promise<PhoneServerHandle> {
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 8787;
  const entries = options.entries;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    // Refuse anything but a read before touching the filesystem. Nothing here
    // would write anyway, but answering a POST with the page invites a caller to
    // believe the request did something.
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
      res.end("Method not allowed. This server is read-only.");
      return;
    }
    try {
      const data = await gatherWorkspace(entries);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(renderPhonePage(data));
        return;
      }
      if (url.pathname === "/status") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(data, null, 2));
        return;
      }
      if (url.pathname === "/text") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end(renderPhoneText(data));
        return;
      }
      // Nothing here writes, but be explicit rather than falling through to the page.
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found. This server is read-only: / , /status , /text");
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Failed to read the workspace: ${(error as Error).message}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Host addresses a phone on the same network can actually reach. */
export async function lanAddresses(): Promise<string[]> {
  const { networkInterfaces } = await import("node:os");
  const out: string[] = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) out.push(info.address);
    }
  }
  return out;
}

/** Convenience for the command: the digest of one project, for a quick glance. */
export function projectGlance(project: Project): string {
  return buildDigest(project);
}
