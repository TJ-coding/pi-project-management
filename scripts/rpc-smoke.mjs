#!/usr/bin/env node
/**
 * Headless smoke test for the extension against the real `pi` binary in RPC mode.
 *
 *   node scripts/rpc-smoke.mjs --ext ./src/index.ts --cwd /tmp/demo
 *
 * It:
 *   1. starts `pi --mode rpc -e <ext>` inside --cwd
 *   2. asserts /project commands are registered
 *   3. runs `/project help` and captures the extension UI notification
 *   4. runs an agent prompt that exercises project_init/project_goal/project_status
 *   5. verifies the project files on disk
 *
 * Dialog requests are auto-answered so the run never hangs.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const ext = getArg("ext", "./src/index.ts");
const cwd = getArg("cwd", process.cwd());
const promptFile = getArg("prompt-file", "");
const prompt = promptFile
  ? readFileSync(promptFile, "utf8")
  : getArg(
      "prompt",
      "Use project_init to initialize a project here named 'Smoke Test'. Then use project_goal to create a goal " +
        "'Validate tools' with priority 4. Then call project_status. Reply with the new goal id only.",
    );
const timeoutMs = Number(getArg("timeout", "240000"));
const expectGoal = getArg("expect-goal", "Validate tools");
const expectTools = getArg("expect-tool", "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const child = spawn(process.execPath === "" ? "pi" : "pi", ["--mode", "rpc", "--no-session", "-e", ext], {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
});

const events = [];
const notifications = [];
const toolCalls = [];
const errors = [];
let buffer = "";
let settled = false;

const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");

const finish = (code) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  child.kill("SIGKILL");
  process.exitCode = code;
  setTimeout(() => process.exit(code), 50);
};

const handle = (message) => {
  events.push(message);
  if (message.type === "extension_ui_request") {
    if (message.method === "notify") notifications.push(message);
    if (message.method === "confirm") {
      send({ type: "extension_ui_response", id: message.id, confirmed: true });
    } else if (message.method === "editor" || message.method === "input") {
      send({ type: "extension_ui_response", id: message.id, value: "" });
    } else if (message.method === "select") {
      send({ type: "extension_ui_response", id: message.id, cancelled: true });
    }
    return;
  }
  if (message.type === "response" && message.success === false) {
    errors.push(message);
  }
  if (message.type === "tool_execution_end") {
    // toolName may be nested on the event payload
    const name = message.toolName ?? message.tool?.name ?? message.name;
    toolCalls.push(name);
  }
  if (message.type === "agent_settled") {
    void verify();
  }
};

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // ignore non-JSON lines
    }
  }
});
child.stderr.on("data", (chunk) => {
  const text = chunk.toString("utf8").trim();
  if (text) console.error(`[pi stderr] ${text}`);
});

const timer = setTimeout(() => {
  console.error("Timed out waiting for the agent to settle.");
  console.error(`notifications: ${notifications.length}, tool calls: ${toolCalls.join(", ")}`);
  finish(1);
}, timeoutMs);

async function verify() {
  const failures = [];
  const commands = events.find((event) => event.type === "response" && event.command === "get_commands");
  const names = (commands?.data?.commands ?? []).map((command) => command.name);
  if (!names.includes("project")) failures.push(`/project command missing (got ${names.join(", ")})`);
  if (!names.includes("pm")) failures.push("/pm command missing");

  const helpNotify = notifications.find((notification) => (notification.message ?? "").includes("Project commands"));
  if (!helpNotify) failures.push("`/project help` did not produce the expected notification");

  const goalsFile = join(cwd, ".project", "goals.yaml");
  if (!existsSync(goalsFile)) {
    failures.push(".project/goals.yaml was not created by project_init/project_goal");
  } else if (expectGoal) {
    const goals = readFileSync(goalsFile, "utf8");
    if (!goals.includes(expectGoal)) failures.push(`goal '${expectGoal}' not found in goals.yaml`);
  }
  for (const file of ["project.yaml", "direction.md", "state.md", "intelligence.yaml", "risks.yaml", "strategy.md", "plan.yaml"]) {
    if (!existsSync(join(cwd, ".project", file))) failures.push(`missing .project/${file}`);
  }

  const projectToolCalls = toolCalls.filter((name) => typeof name === "string" && name.startsWith("project_"));
  if (projectToolCalls.length === 0) failures.push("no project_* tool executions observed");
  for (const expected of expectTools) {
    if (!projectToolCalls.includes(expected)) failures.push(`expected tool call ${expected} was not executed`);
  }

  console.log(`commands: ${names.join(", ")}`);
  console.log(`project tool calls: ${projectToolCalls.join(", ") || "(none)"}`);
  console.log(`notifications: ${notifications.length}`);
  for (const notification of notifications) console.log(`  - ${(notification.message ?? "").slice(0, 120)}`);

  if (failures.length > 0) {
    console.error("\nSMOKE FAILURES:");
    for (const failure of failures) console.error(`- ${failure}`);
    const lastAssistant = [...events].reverse().find((event) => event.type === "message_end" && event.message?.role === "assistant");
    if (lastAssistant) console.error(`last assistant message: ${JSON.stringify(lastAssistant.message).slice(0, 600)}`);
    finish(1);
    return;
  }
  console.log("\nSMOKE PASS");
  finish(0);
}

/* Sequence: list commands, run /project help, then prompt the agent. */
send({ id: "1", type: "get_commands" });
setTimeout(() => {
  send({ id: "2", type: "prompt", message: "/project help" });
}, 500);
setTimeout(() => {
  send({ id: "3", type: "prompt", message: prompt });
}, 1500);
