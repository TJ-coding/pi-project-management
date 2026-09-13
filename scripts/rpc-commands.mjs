#!/usr/bin/env node
/**
 * Run `/project ...` commands against a real `pi` in RPC mode and report the
 * extension UI notifications produced. Used to verify the command surface
 * headlessly.
 *
 *   node scripts/rpc-commands.mjs --ext ./src/index.ts --cwd /tmp/demo \
 *     --commands "/project status,/project plan,/project review"
 */

import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const ext = getArg("ext", "./src/index.ts");
const cwd = getArg("cwd", process.cwd());
const commands = getArg("commands", "/project status")
  .split("||")
  .map((command) => command.trim())
  .filter(Boolean);
const timeoutMs = Number(getArg("timeout", "120000"));

const child = spawn("pi", ["--mode", "rpc", "--no-session", "-e", ext], {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

const notifications = [];
const failures = [];
const pending = new Map();
let buffer = "";
let settled = false;

const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");

const finish = (code) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  for (const [text] of notifications) console.log(`notify: ${text.split("\n")[0].slice(0, 140)}`);
  if (failures.length > 0) {
    console.error("\nCOMMAND SMOKE FAILURES:");
    for (const failure of failures) console.error(`- ${failure}`);
  } else {
    console.log("\nCOMMAND SMOKE PASS");
  }
  child.kill("SIGKILL");
  process.exitCode = code;
  setTimeout(() => process.exit(code), 50);
};

const handle = (message) => {
  if (message.type === "extension_ui_request") {
    if (message.method === "notify") notifications.push([message.message ?? "", message.notifyType]);
    if (message.method === "confirm") send({ type: "extension_ui_response", id: message.id, confirmed: true });
    else if (message.method === "editor" || message.method === "input") {
      send({ type: "extension_ui_response", id: message.id, value: "" });
    } else if (message.method === "select") {
      send({ type: "extension_ui_response", id: message.id, cancelled: true });
    }
    return;
  }
  if (message.type === "response" && message.id && pending.has(message.id)) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    if (message.success) resolve();
    else {
      failures.push(`command ${message.id} failed: ${JSON.stringify(message.error ?? message)}`);
      resolve();
    }
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
      /* ignore non-JSON */
    }
  }
});
child.stderr.on("data", (chunk) => {
  const text = chunk.toString("utf8").trim();
  if (text && !text.includes("pix-bench-prefetch")) console.error(`[pi stderr] ${text}`);
});

const timer = setTimeout(() => {
  failures.push(`timed out after ${timeoutMs}ms`);
  finish(1);
}, timeoutMs);

const runCommand = (id, command) =>
  new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, type: "prompt", message: command });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        failures.push(`no response for ${command}`);
        resolve();
      }
    }, 20000);
  });

for (const [index, command] of commands.entries()) {
  const id = `cmd-${index}`;
  const before = notifications.length;
  await runCommand(id, command);
  if (notifications.length === before && !command.includes("yolo")) {
    failures.push(`command produced no notification: ${command}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
}

finish(failures.length > 0 ? 1 : 0);
