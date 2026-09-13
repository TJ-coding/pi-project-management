import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ProjectManager } from "../src/project.ts";
import { loadProject, PROJECT_DIR, saveProject } from "../src/storage.ts";
import { cleanup, fixedClock, tempDir } from "./helpers.ts";

describe("storage round-trip", () => {
  let root: string;

  before(async () => {
    root = await tempDir();
  });
  after(async () => {
    await cleanup(root);
  });

  test("init writes the documented file layout", async () => {
    const clock = fixedClock();
    const manager = await ProjectManager.init(root, {
      name: "Round Trip",
      vision: "Make the round trip work.",
      intent: "Because persistence matters.",
      clock,
      by: "test",
    });
    await manager.updateDirection(
      {
        values: ["Simple", "Reliable"],
        concepts: [{ type: "technical", text: "Git is the durable state." }],
      },
      { commit: false, approved: true },
    );
    await manager.createGoal(
      { title: "Ship MVP", priority: 4, successCriteria: ["all files reload"] },
      { commit: false },
    );
    await manager.updateState(
      { initial: "Nothing existed.", current: "Files exist.", capabilities: ["persistence"] },
      { commit: false },
    );
    await manager.createQuestion(
      { question: "Does the round trip preserve links?", importance: 0.9, uncertainty: 0.8, decisionImpact: 0.7 },
      { commit: false },
    );
    await manager.createRisk(
      { title: "Serialization drift", probability: 0.3, impact: 0.8, mitigation: "tests" },
      { commit: false },
    );
    await manager.setStrategy({ approach: "YAML + markdown", hypotheses: ["humans can edit it"] }, { commit: false });

    const goal = manager.project.goals[0]!;
    const question = manager.project.questions[0]!;
    const risk = manager.project.risks[0]!;
    const proposal = manager.analyzeReplan({ trigger: "initial plan" });
    await manager.applyReplan(proposal, { commit: false });
    const node = manager.project.plans.plans[0]!.nodes[0]!;
    await manager.setNodeStatus(node.id, "RUNNING", { commit: false });
    await manager.updateNode(node.id, { goal: goal.id, question: question.id, risk: risk.id }, { commit: false });
    await manager.recordDecision(
      { title: "Use filesystem + Git", decision: "Persist to files.", rationale: "portable" },
      { commit: false },
    );
    await manager.startRun({ title: "round trip run", node: node.id }, { commit: false });
    await manager.finishRun(manager.project.runs[0]!.id, { status: "COMPLETED" }, { commit: false });

    // Direct file presence.
    for (const file of [
      "project.yaml",
      "direction.md",
      "goals.yaml",
      "state.md",
      "intelligence.yaml",
      "risks.yaml",
      "strategy.md",
      "plan.yaml",
      "plan.md",
      "history/events.jsonl",
      "history/history.md",
    ]) {
      await readFile(join(root, PROJECT_DIR, file), "utf8");
    }

    const loaded = await loadProject(root, fixedClock("2026-06-01T00:00:00.000Z"));
    assert.equal(loaded.meta.name, "Round Trip");
    assert.equal(loaded.direction.vision, "Make the round trip work.");
    assert.equal(loaded.direction.intent, "Because persistence matters.");
    assert.deepEqual(loaded.direction.values, ["Simple", "Reliable"]);
    assert.deepEqual(loaded.direction.concepts, [{ type: "technical", text: "Git is the durable state." }]);
    assert.equal(loaded.goals.length, 1);
    assert.equal(loaded.goals[0]!.title, "Ship MVP");
    assert.deepEqual(loaded.goals[0]!.successCriteria, ["all files reload"]);
    assert.equal(loaded.state.current, "Files exist.");
    assert.deepEqual(loaded.state.capabilities, ["persistence"]);
    assert.equal(loaded.questions.length, 1);
    assert.equal(loaded.questions[0]!.importance, 0.9);
    assert.equal(loaded.risks.length, 1);
    assert.equal(loaded.risks[0]!.title, "Serialization drift");
    assert.equal(loaded.strategy.approach, "YAML + markdown");
    assert.deepEqual(loaded.strategy.hypotheses, ["humans can edit it"]);
    assert.equal(loaded.plans.plans.length, 1);
    assert.equal(loaded.plans.active, loaded.plans.plans[0]!.id);
    assert.equal(loaded.decisions.length, 1);
    assert.equal(loaded.runs.length, 1);
    assert.equal(loaded.runs[0]!.status, "COMPLETED");
    assert.ok(loaded.history.length >= 10, `expected history events, got ${loaded.history.length}`);

    const nodeAfter = loaded.plans.plans[0]!.nodes.find((item) => item.id === node.id)!;
    assert.equal(nodeAfter.goal, goal.id);
    assert.equal(nodeAfter.question, question.id);
    assert.equal(nodeAfter.risk, risk.id);
    assert.equal(nodeAfter.status, "COMPLETED", "finishing the run completes the node");

    // Full save/load is idempotent for structured data.
    const before = JSON.stringify({ ...loaded, root: "" });
    await saveProject(loaded, { clock: fixedClock("2026-06-02T00:00:00.000Z") });
    const reloaded = await loadProject(root, fixedClock("2026-06-03T00:00:00.000Z"));
    const normalize = (project: Awaited<ReturnType<typeof loadProject>>): string =>
      JSON.stringify({
        ...project,
        root: "",
        meta: { ...project.meta, updated: "" },
        state: { ...project.state, updated: "" },
        strategy: { ...project.strategy, updated: "" },
      });
    assert.equal(normalize(reloaded), normalize(loaded), "second save/load is stable");
    void before;
  });

  test("hand-edited markdown and YAML are tolerated", async () => {
    const dir = await tempDir();
    try {
      const manager = await ProjectManager.init(dir, { name: "Hand Edited", clock: fixedClock(), by: "test" });
      await manager.createGoal({ title: "original" }, { commit: false });

      // Humans may reorder bullets, add comments and use CRLF.
      await writeFile(
        join(dir, PROJECT_DIR, "direction.md"),
        "# Direction\r\n\r\n## Vision\r\nA hand written vision.\r\n\r\n## Values\r\n- first\r\n- second\r\n",
        "utf8",
      );
      await writeFile(
        join(dir, PROJECT_DIR, "goals.yaml"),
        "# my goals\n- id: G1\n  title: hand edited title\n  priority: \"5\"\n  status: completed\n  success_criteria:\n    - works\n",
        "utf8",
      );

      const project = await loadProject(dir, fixedClock());
      assert.equal(project.direction.vision, "A hand written vision.");
      assert.deepEqual(project.direction.values, ["first", "second"]);
      assert.equal(project.goals[0]!.title, "hand edited title");
      assert.equal(project.goals[0]!.priority, 5);
      assert.equal(project.goals[0]!.status, "COMPLETED");
    } finally {
      await cleanup(dir);
    }
  });

  test("malformed history lines do not destroy the project", async () => {
    const dir = await tempDir();
    try {
      const manager = await ProjectManager.init(dir, { name: "Malformed", clock: fixedClock(), by: "test" });
      await manager.createGoal({ title: "g" }, { commit: false });
      const eventsFile = join(dir, PROJECT_DIR, "history", "events.jsonl");
      const existing = await readFile(eventsFile, "utf8");
      await writeFile(eventsFile, `${existing}not json at all\n`, "utf8");
      const project = await loadProject(dir, fixedClock());
      assert.equal(project.goals.length, 1);
      assert.ok(project.history.length >= 2);
    } finally {
      await cleanup(dir);
    }
  });
});
