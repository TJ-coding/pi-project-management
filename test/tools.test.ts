import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerProjectTools } from "../src/tools.ts";
import { cleanup, fixedClock, tempDir } from "./helpers.ts";

/* ---------------- fakes ---------------- */

interface CapturedTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

function captureTools(): { tools: Map<string, CapturedTool>; api: ExtensionAPI } {
  const tools = new Map<string, CapturedTool>();
  const api = {
    registerTool: (definition: CapturedTool) => {
      tools.set(definition.name, definition);
    },
  } as unknown as ExtensionAPI;
  registerProjectTools(api);
  return { tools, api };
}

function fakeContext(cwd: string, options: { hasUI?: boolean; confirm?: boolean } = {}): {
  ctx: ExtensionContext;
  notifications: string[];
  confirmations: () => number;
} {
  const notifications: string[] = [];
  let confirmations = 0;
  const ctx = {
    cwd,
    mode: options.hasUI === false ? "print" : "tui",
    hasUI: options.hasUI !== false,
    ui: {
      notify: (message: string) => notifications.push(message),
      confirm: async () => {
        confirmations += 1;
        return options.confirm ?? false;
      },
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      custom: async () => undefined,
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
    sessionManager: { getSessionFile: () => null, getEntries: () => [], getBranch: () => [] },
  } as unknown as ExtensionContext;
  return { ctx, notifications, confirmations: () => confirmations };
}

const { tools } = captureTools();

async function run(name: string, params: Record<string, unknown>, ctx: ExtensionContext) {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} not registered`);
  return tool!.execute("call", params, undefined, undefined, ctx);
}

const text = (result: { content: Array<{ type: string; text: string }> }) => result.content.map((part) => part.text).join("\n");

describe("agent tools", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  test("all expected tools are registered with descriptions", () => {
    for (const name of [
      "project_init",
      "project_status",
      "project_context",
      "project_direction",
      "project_goal",
      "project_state",
      "project_question",
      "project_risk",
      "project_strategy",
      "project_plan",
      "project_gate",
      "project_decision",
      "project_history",
      "project_run",
      "project_replan",
      "project_review",
      "project_complete",
      "project_resume",
      "project_resource",
    ]) {
      const tool = tools.get(name) as unknown as { description?: string; parameters?: unknown };
      assert.ok(tool, `${name} missing`);
      assert.ok(tool.description && tool.description.length > 20, `${name} description too short`);
      assert.ok(tool.parameters, `${name} has no parameters schema`);
    }
  });

  test("tools refuse to run without a project", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { ctx } = fakeContext(dir, { hasUI: false });
    await assert.rejects(() => run("project_status", {}, ctx), /No project found/);
  });

  test("status and context render project facts", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { ctx } = fakeContext(dir, { hasUI: false });
    await run("project_init", { name: "Tool Test", vision: "Vision from tool", values: ["Simple"] }, ctx);
    await run("project_goal", { action: "create", title: "Goal from tool", priority: 5 }, ctx);
    await run("project_question", { action: "add", question: "Is it persisted?", importance: 1, uncertainty: 1, decisionImpact: 1 }, ctx);
    await run("project_replan", { action: "apply", trigger: "tool test" }, ctx);

    const status = text(await run("project_status", {}, ctx));
    assert.match(status, /Vision from tool/);
    assert.match(status, /Goal from tool/);

    const goals = text(await run("project_status", { section: "goals" }, ctx));
    assert.match(goals, /G1/);

    const plan = text(await run("project_status", { section: "plan" }, ctx));
    assert.match(plan, /P1/);

    const digest = text(await run("project_status", { section: "digest" }, ctx));
    assert.match(digest, /VALUES: Simple/);

    const nodeId = /N\d+/.exec(plan)![0];
    const context = text(await run("project_context", { node: nodeId, history: true }, ctx));
    assert.match(context, new RegExp(`ACTIVE NODE: ${nodeId}`));

    const validation = text(await run("project_status", { section: "validation" }, ctx));
    assert.match(validation, /Validation/);
  });

  test("goal, risk, question and decision round trip through tools", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { ctx } = fakeContext(dir, { hasUI: false });
    await run("project_init", { name: "Round Trip", yolo: true }, ctx);
    await run("project_goal", { action: "create", title: "Tool goal", priority: 4, successCriteria: ["works"] }, ctx);
    await run("project_risk", { action: "add", title: "Tool risk", probability: 0.4, impact: 0.8, mitigation: "test" }, ctx);
    await run("project_question", { action: "add", question: "Tool question?", importance: 0.9, uncertainty: 1, decisionImpact: 0.8, risks: ["R1"] }, ctx);
    await run("project_question", { action: "answer", id: "Q1", answer: "Yes", status: "CONFIRMED", confidence: 0.9 }, ctx);
    await run("project_strategy", { action: "set", approach: "Tool strategy" }, ctx);
    await run("project_decision", { action: "record", title: "Tool decision", decision: "Do it", rationale: "test" }, ctx);
    await run("project_direction", { action: "set", vision: "Tool vision", approved: true }, ctx);

    const risks = text(await run("project_risk", { action: "list" }, ctx));
    assert.match(risks, /Tool risk/);
    assert.match(risks, /probability 0.60/, "CONFIRMED answer should raise the linked risk probability");

    const intelligence = text(await run("project_question", { action: "list" }, ctx));
    assert.match(intelligence, /CONFIRMED/);

    const decisions = text(await run("project_decision", { action: "list" }, ctx));
    assert.match(decisions, /Tool decision/);

    const direction = text(await run("project_direction", { action: "get" }, ctx));
    assert.match(direction, /Tool vision/);

    const summary = text(await run("project_status", { section: "summary" }, ctx));
    assert.match(summary, /Tool goal/);
  });

  test("plan, gate and run tools persist execution state", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { ctx } = fakeContext(dir, { hasUI: false });
    await run("project_init", { name: "Execution", yolo: true }, ctx);
    await run("project_plan", { action: "add_node", title: "Do the work", type: "TASK" }, ctx);
    await run("project_plan", { action: "node_status", id: "N1", status: "RUNNING" }, ctx);
    await run("project_gate", { action: "define", node: "N1", gateType: "VALIDATION", criteria: "works" }, ctx);
    await run("project_gate", { action: "evaluate", node: "N1", outcome: "FAIL", notes: "not yet" }, ctx);
    await run("project_plan", { action: "node_status", id: "N1", status: "COMPLETED", outputs: ["artifact"] }, ctx);
    const plan = text(await run("project_plan", { action: "get" }, ctx));
    assert.match(plan, /COMPLETED/);
    assert.match(plan, /gate\(VALIDATION\)/);
    assert.match(plan, /gate FAIL: not yet/);
    assert.match(plan, /artifact/);

    const started = text(await run("project_run", { action: "start", title: "Background job", command: "echo tool-run > out.txt" }, ctx));
    assert.match(started, /Started run RUN1/);
    const listed = text(await run("project_run", { action: "list" }, ctx));
    assert.match(listed, /RUN1/);
    await run("project_run", { action: "finish", id: "RUN1", status: "COMPLETED", notes: "done" }, ctx);
    const tail = text(await run("project_run", { action: "tail", id: "RUN1" }, ctx));
    assert.match(tail, /RUN1/);
    // give the detached process a moment, then confirm it really ran
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(existsSync(join(dir, "out.txt")));

    const history = text(await run("project_history", { action: "list" }, ctx));
    assert.match(history, /gate.failed/);
    assert.match(history, /run.finished/);
  });

  test("resume, review and resource tools report state", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { ctx } = fakeContext(dir, { hasUI: false });
    await run("project_init", { name: "Reports", yolo: true, repositories: ["https://example.com/repo.git"] }, ctx);
    await run("project_resource", { action: "set_resources", resources: [{ kind: "ssh", target: "gpu-box" }] }, ctx);
    const scope = text(await run("project_resource", { action: "get" }, ctx));
    assert.match(scope, /example\.com\/repo\.git/);
    assert.match(scope, /ssh: gpu-box/);

    const review = text(await run("project_review", { record: true, outcome: "REPLAN", notes: "needs work" }, ctx));
    assert.match(review, /Strategic review/);
    const decisions = text(await run("project_decision", { action: "list" }, ctx));
    assert.match(decisions, /Strategic review/);

    const resume = text(await run("project_resume", { reconcile: true }, ctx));
    assert.match(resume, /# Resume: Reports/);
    assert.match(resume, /Next actions/);

    const analysis = text(await run("project_replan", { action: "analyze", trigger: "tool analyze", evidence: ["e1"] }, ctx));
    assert.match(analysis, /1-4\. Direction/);
    assert.match(analysis, /12\. New evidence/);
  });

  test("project_init reports an existing project and completion renders the summary", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const { ctx } = fakeContext(dir, { hasUI: false });
    const first = text(await run("project_init", { name: "Complete Me", vision: "v" }, ctx));
    assert.match(first, /Initialized project/);
    const second = text(await run("project_init", { name: "Duplicate" }, ctx));
    assert.match(second, /already exists/);

    await run("project_goal", { action: "create", title: "Done goal" }, ctx);
    await run("project_goal", { action: "status", id: "G1", status: "COMPLETED" }, ctx);
    await run("project_plan", { action: "add_node", title: "Work" }, ctx);
    await run("project_plan", { action: "node_status", id: "N1", status: "COMPLETED", outputs: ["done"] }, ctx);

    const blocked = text(await run("project_complete", {}, ctx));
    assert.match(blocked, /requires human approval/);
    const completed = text(await run("project_complete", { approved: true }, ctx));
    assert.match(completed, /Project Summary/);
    assert.match(completed, /Done goal/);
    assert.match(completed, /Plan Evolution/);

    const yoloDir = await tempDir();
    dirs.push(yoloDir);
    const yolo = fakeContext(yoloDir, { hasUI: false });
    await run("project_init", { name: "Yolo complete", yolo: true }, yolo.ctx);
    const auto = text(await run("project_complete", {}, yolo.ctx));
    assert.match(auto, /Project Summary/);
    const events = readFileSync(join(yoloDir, ".project", "history", "events.jsonl"), "utf8");
    assert.match(events, /project.completed/);
  });

  test("strategic changes ask for approval when a UI is available", async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const approved = fakeContext(dir, { hasUI: true, confirm: true });
    await run("project_init", { name: "Approval", vision: "v" }, approved.ctx);
    const result = text(await run("project_direction", { action: "set", intent: "new intent" }, approved.ctx));
    assert.match(result, /new intent/);
    assert.equal(approved.confirmations(), 1);

    const rejected = fakeContext(dir, { hasUI: true, confirm: false });
    const rejectedResult = text(await run("project_direction", { action: "set", vision: "never" }, rejected.ctx));
    assert.match(rejectedResult, /requires human approval/);
    const direction = text(await run("project_direction", { action: "get" }, rejected.ctx));
    assert.doesNotMatch(direction, /never/);

    // YOLO bypasses the prompt and records the decision.
    const yoloDir = await tempDir();
    dirs.push(yoloDir);
    const yolo = fakeContext(yoloDir, { hasUI: false });
    await run("project_init", { name: "Yolo", yolo: true }, yolo.ctx);
    const auto = text(await run("project_goal", { action: "create", title: "Big goal" }, yolo.ctx));
    assert.match(auto, /Created goal G1/);
    const abandoned = text(
      await run("project_goal", { action: "status", id: "G1", status: "ABANDONED", reason: "superseded by G7" }, yolo.ctx),
    );
    assert.match(abandoned, /ABANDONED/);
    const events = readFileSync(join(yoloDir, ".project", "history", "events.jsonl"), "utf8");
    assert.match(events, /Pi automatically accepted: goal G1 ABANDONED/);
  });
});
