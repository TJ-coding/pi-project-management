#!/usr/bin/env node
/**
 * Bootstraps a tiny Python venv with `pyte` (terminal emulation) and runs the
 * TUI smoke test, so `npm run smoke:tui` works on a clean checkout.
 *
 *   node scripts/run-tui-smoke.mjs [--cwd /tmp/pi-pm-demo]
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const venv = join(repo, ".venv-tui");
const venvPython = join(venv, "bin", process.platform === "win32" ? "python.exe" : "python");

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const cwd = getArg("cwd", "/tmp/pi-pm-demo");

function hasPyte(python) {
  return spawnSync(python, ["-c", "import pyte"], { stdio: "ignore" }).status === 0;
}

function ensureVenv() {
  if (existsSync(venvPython) && hasPyte(venvPython)) return venvPython;
  const system = process.env.PYTHON ?? "python3";
  if (!existsSync(venvPython)) {
    console.log(`creating ${venv} …`);
    const created = spawnSync(system, ["-m", "venv", venv], { stdio: "inherit" });
    if (created.status !== 0) {
      console.error(`Could not create a virtualenv with ${system}. Install pyte manually: pip install pyte`);
      process.exit(2);
    }
  }
  console.log("installing pyte …");
  const installed = spawnSync(venvPython, ["-m", "pip", "install", "--quiet", "pyte"], { stdio: "inherit" });
  if (installed.status !== 0) {
    console.error("Could not install pyte. Install it manually: pip install pyte");
    process.exit(2);
  }
  return venvPython;
}

const python = ensureVenv();

// Forward only known pass-through flags; --cwd is always provided explicitly.
const extra = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--cwd") {
    index += 1;
    continue;
  }
  if (arg === "--dump") extra.push(arg);
  else if ((arg === "--cols" || arg === "--rows") && args[index + 1]) {
    extra.push(arg, args[index + 1]);
    index += 1;
  }
}

const result = spawnSync(
  python,
  [join(here, "tui-smoke.py"), "--ext", join(repo, "src", "index.ts"), "--cwd", cwd, ...extra],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
