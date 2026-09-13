/**
 * Long-running execution support (spec 16).
 *
 * A run can reference an external environment (ssh, docker, GPU box, API) and
 * can optionally be launched as a detached local process with its output
 * captured to `runs/<id>.log`. Detached runs keep running after the Pi session
 * ends, which is what makes multi-hour/multi-day work independent of a single
 * conversation. This module intentionally does NOT become an orchestrator; it
 * only supports starting a process and inspecting it later.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SpawnResult {
  pid: number;
  logFile: string;
}

export function spawnDetached(command: string, cwd: string, logFile: string): SpawnResult {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env },
    });
    child.unref();
    return { pid: child.pid ?? -1, logFile };
  } finally {
    closeSync(fd);
  }
}

export function isRunning(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function stopProcess(pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean {
  if (!isRunning(pid)) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Last `lines` lines of a log file (best effort). */
export function tailLog(logFile: string, lines = 20): string {
  if (!existsSync(logFile)) return "";
  try {
    const content = readFileSync(logFile, "utf8");
    const all = content.split("\n");
    return all.slice(Math.max(0, all.length - lines)).join("\n");
  } catch {
    return "";
  }
}
