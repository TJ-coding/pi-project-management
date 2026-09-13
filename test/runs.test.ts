import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ProjectManager } from "../src/project.ts";
import { isRunning, spawnDetached, stopProcess, tailLog } from "../src/runs.ts";
import { cleanup, fixedClock, tempDir } from "./helpers.ts";

describe("long-running runs", () => {
  let root: string;

  before(async () => {
    root = await tempDir();
  });
  after(async () => {
    await cleanup(root);
  });

  test("detached processes keep running outside the session and can be inspected later", async () => {
    const manager = await ProjectManager.init(root, { name: "Long Running", clock: fixedClock(), by: "test" });
    await manager.applyReplan(
      {
        trigger: "start",
        rationale: "long job",
        title: "Job plan",
        notes: [],
        superseded: [],
        carried: [],
        nodes: [{ title: "Long job", type: "TASK" }],
      },
      { commit: false },
    );

    const logFile = join(root, ".project", "runs", "RUN1.log");
    const { pid } = spawnDetached("echo starting; sleep 30; echo finished", root, logFile);
    assert.ok(pid > 0);
    assert.ok(isRunning(pid), "detached process should be alive");

    const started = await manager.startRun(
      { title: "Long job", node: "N1", command: "sleep 30", pid, log: logFile, session: "session-1" },
      { commit: false },
    );

    // Simulate a different Pi session reading the same project from disk.
    const secondSession = await ProjectManager.open(root, { clock: fixedClock("2026-02-01T00:00:00.000Z") });
    const persisted = secondSession.project.runs.find((run) => run.id === started.id)!;
    assert.equal(persisted.status, "STARTED");
    assert.equal(persisted.pid, pid);
    assert.equal(persisted.session, "session-1");
    assert.equal(secondSession.project.plans.plans[0]!.nodes[0]!.status, "RUNNING");

    // A live process must not be reconciled into INTERRUPTED.
    const untouched = await secondSession.reconcileRuns({ commit: false });
    assert.equal(untouched.length, 0);
    assert.equal(secondSession.project.runs[0]!.status, "STARTED");

    // Once the process is gone, reconcile marks it (and its node) interrupted.
    assert.ok(stopProcess(pid));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(isRunning(pid), false);
    const reconciled = await secondSession.reconcileRuns({ commit: false });
    assert.equal(reconciled.length, 1);
    assert.equal(secondSession.project.runs[0]!.status, "INTERRUPTED");
    assert.equal(secondSession.project.plans.plans[0]!.nodes[0]!.status, "INTERRUPTED");

    // The log written by the detached process is available to the next session.
    const tail = tailLog(logFile);
    assert.match(tail, /starting/);

    // Resume report lists the interrupted run and next actions.
    const resume = await secondSession.read((project) => project.runs.map((run) => `${run.id}:${run.status}`).join(","));
    assert.equal(resume, "RUN1:INTERRUPTED");

    // A fresh process can finish the run and complete the node.
    await secondSession.finishRun("RUN1", { status: "COMPLETED", notes: "resumed and finished" }, { commit: false });
    assert.equal(secondSession.project.runs[0]!.status, "COMPLETED");
    assert.equal(secondSession.project.plans.plans[0]!.nodes[0]!.status, "COMPLETED");
    assert.match(readFileSync(join(root, ".project", "history", "events.jsonl"), "utf8"), /run.finished/);
    assert.ok(existsSync(logFile));
  });

  test("stopProcess reports when there is nothing to stop", () => {
    assert.equal(stopProcess(999_999), false);
    assert.equal(isRunning(null), false);
    assert.equal(isRunning(0), false);
  });
});
