import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { buildTargetedContext, buildDigest, buildResumeReport } from "../src/context.ts";
import { renderCompletionSummary, planEvolution, summarizeSince, formatAwaySummary } from "../src/history.ts";
import { ProjectManager } from "../src/project.ts";
import { renderStatusText } from "../src/format.ts";
import { PROJECT_DIR } from "../src/storage.ts";
import { cleanup, fixedClock, tempDir } from "./helpers.ts";

async function newProject(name: string) {
  const root = await tempDir();
  const clock = fixedClock();
  const manager = await ProjectManager.init(root, { name, clock, by: "test" });
  return { root, clock, manager };
}

describe("project manager", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  test("strategic direction changes require approval unless YOLO is on", async () => {
    const { root, manager } = await newProject("Strategic");
    dirs.push(root);

    const blocked = await manager.updateDirection({ vision: "A bold new vision" }, { commit: false });
    assert.equal(blocked.status, "requires-approval");
    assert.equal(manager.project.direction.vision, "");

    const approved = await manager.updateDirection(
      { vision: "A bold new vision" },
      { commit: false, approved: true, approvedBy: "human" },
    );
    assert.equal(approved.status, "applied");
    assert.equal(manager.project.direction.vision, "A bold new vision");

    await manager.setYolo(true, { commit: false });
    const auto = await manager.updateDirection({ intent: "YOLO intent" }, { commit: false });
    assert.equal(auto.status, "applied");
    assert.equal(auto.status === "applied" && auto.autoAccepted, true);
    const historyText = manager.project.history.map((event) => event.summary).join("\n");
    assert.match(historyText, /Pi automatically accepted/);
  });

  test("goal lifecycle records the right history kinds", async () => {
    const { root, manager } = await newProject("Goals");
    dirs.push(root);
    const goal = await manager.createGoal({ title: "First", priority: 5 }, { commit: false });
    const done = await manager.setGoalStatus(goal.id, "COMPLETED", { commit: false });
    assert.equal(done.status, "applied");
    const kinds = manager.project.history.map((event) => event.kind);
    assert.ok(kinds.includes("goal.created"));
    assert.ok(kinds.includes("goal.completed"));

    const abandoned = await manager.setGoalStatus(goal.id, "ABANDONED", { commit: false });
    assert.equal(abandoned.status, "requires-approval");
    await manager.setYolo(true, { commit: false });
    const yoloAbandon = await manager.setGoalStatus(goal.id, "ABANDONED", { commit: false, reason: "superseded by G7" });
    assert.equal(yoloAbandon.status, "applied");
    assert.equal(manager.project.goals[0]!.status, "ABANDONED");
    assert.match(manager.project.history.map((event) => event.summary).join("\n"), /Pi automatically accepted: goal/);
  });

  test("answering a question can propagate into linked risk estimates", async () => {
    const { root, manager } = await newProject("Intelligence");
    dirs.push(root);
    const risk = await manager.createRisk({ title: "scalability", probability: 0.5, impact: 0.8 }, { commit: false });
    const question = await manager.createQuestion(
      { question: "Can architecture X scale?", importance: 1, uncertainty: 1, decisionImpact: 1, risks: [risk.id] },
      { commit: false },
    );
    await manager.answerQuestion(
      question.id,
      { answer: "No, it fails at 10k.", status: "CONFIRMED", confidence: 0.9, evidence: [{ description: "benchmark", run: undefined }] },
      { commit: false },
    );
    const updated = await manager.propagateQuestionToRisks(question.id, { commit: false });
    assert.equal(updated.length, 1);
    assert.ok(manager.project.risks[0]!.probability > 0.5);
    assert.equal(manager.project.questions[0]!.uncertainty, 0);

    const fresh = await manager.read((project) => project);
    assert.equal(fresh.questions[0]!.status, "CONFIRMED");
    assert.equal(fresh.questions[0]!.evidence.length, 1);
    assert.ok(fresh.risks[0]!.probability > 0.5);
  });

  test("gates record outcomes and complete the gate node", async () => {
    const { root, manager } = await newProject("Gates");
    dirs.push(root);
    const plan = await manager.applyReplan(
      {
        trigger: "start",
        rationale: "one gate",
        title: "Gate plan",
        notes: [],
        superseded: [],
        carried: [],
        nodes: [
          {
            title: "Evaluate approach",
            type: "GATE",
            gate: { type: "STRATEGIC_REVIEW", criteria: "still aligned with vision" },
          },
        ],
      },
      { commit: false },
    );
    assert.equal(plan.status, "applied");
    const node = manager.project.plans.plans[0]!.nodes[0]!;
    await manager.evaluateGate(node.id, "REPLAN", "approach drifted from intent", "agent", { commit: false });
    assert.equal(manager.project.plans.plans[0]!.nodes[0]!.status, "COMPLETED");
    const results = manager.project.plans.plans[0]!.gates;
    assert.equal(results.length, 1);
    assert.equal(results[0]!.outcome, "REPLAN");
    assert.ok(manager.project.history.some((event) => event.kind === "gate.failed"));

    // Gate results survive a full reload from disk.
    const reloaded = await ProjectManager.open(root, { clock: fixedClock() });
    const persisted = reloaded.project.plans.plans[0]!.gates;
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]!.outcome, "REPLAN");
    assert.equal(persisted[0]!.notes, "approach drifted from intent");
    assert.equal(reloaded.project.plans.plans[0]!.nodes[0]!.status, "COMPLETED");
  });

  test("replanning carries valid work, drops invalidated work and adds investigation", async () => {
    const { root, manager } = await newProject("Replan");
    dirs.push(root);
    const keep = await manager.createQuestion(
      { question: "Keep this open", importance: 1, uncertainty: 1, decisionImpact: 1 },
      { commit: false },
    );
    const kill = await manager.createQuestion(
      { question: "This will be invalidated", importance: 1, uncertainty: 1, decisionImpact: 1 },
      { commit: false },
    );

    const first = await manager.applyReplan(manager.analyzeReplan({ trigger: "v1" }), { commit: false });
    assert.equal(first.status, "applied");
    assert.equal(manager.project.plans.plans.length, 1);
    const plan1 = manager.project.plans.plans[0]!;
    const keepNode = plan1.nodes.find((node) => node.question === keep.id)!;
    const killNode = plan1.nodes.find((node) => node.question === kill.id)!;
    assert.ok(keepNode && killNode);

    await manager.setNodeStatus(keepNode.id, "COMPLETED", { commit: false, outputs: ["evidence"] });
    await manager.answerQuestion(kill.id, { answer: "assumption was wrong", status: "INVALIDATED", confidence: 0.9 }, {
      commit: false,
    });

    const proposal = manager.analyzeReplan({ trigger: "invalidated assumption" });
    assert.ok(proposal.superseded.some((line) => line.includes(killNode.id)));
    assert.ok(proposal.carried.some((line) => line.includes(keepNode.id)));

    const second = await manager.applyReplan(proposal, { commit: false });
    assert.equal(second.status, "applied");
    assert.equal(manager.project.plans.plans.length, 2);
    const plan2 = manager.project.plans.plans[1]!;
    const plan1After = manager.project.plans.plans[0]!;
    assert.equal(plan2.version, 2);
    assert.ok(plan2.nodes.find((node) => node.id === keepNode.id && node.status === "COMPLETED"));
    assert.equal(plan2.nodes.find((node) => node.question === kill.id), undefined);
    assert.equal(plan1After.supersededBy, plan2.id);
    assert.equal(manager.project.plans.active, plan2.id);
    assert.equal(manager.project.plans.changes.length, 2);
    assert.equal(manager.project.plans.changes[1]!.trigger, "invalidated assumption");
    assert.ok(manager.project.history.some((event) => event.kind === "plan.changed"));

    // A fundamental pivot is a strategic action and needs approval outside YOLO.
    const pivotBlocked = await manager.applyReplan(manager.analyzeReplan({ trigger: "fundamental pivot" }), {
      commit: false,
      pivot: true,
    });
    assert.equal(pivotBlocked.status, "requires-approval");
    await manager.setYolo(true, { commit: false });
    const pivot = await manager.applyReplan(manager.analyzeReplan({ trigger: "fundamental pivot" }), {
      commit: false,
      pivot: true,
    });
    assert.equal(pivot.status, "applied");
    assert.ok(manager.project.history.some((event) => event.kind === "pivot"));
  });

  test("runs can be started, logged, finished and reconciled", async () => {
    const { root, manager } = await newProject("Runs");
    dirs.push(root);
    const planResult = await manager.applyReplan(
      {
        trigger: "start",
        rationale: "one task",
        title: "Run plan",
        notes: [],
        superseded: [],
        carried: [],
        nodes: [{ title: "Long job", type: "TASK" }],
      },
      { commit: false },
    );
    assert.equal(planResult.status, "applied");
    const nodeId = manager.project.plans.plans[0]!.nodes[0]!.id;
    const run = await manager.startRun(
      { title: "Long job run", node: nodeId, environment: [{ kind: "ssh", target: "gpu-box" }] },
      { commit: false },
    );
    assert.equal(manager.project.plans.plans[0]!.nodes[0]!.status, "RUNNING");
    await manager.logRun(run.id, [{ kind: "progress", text: "epoch 1 done" }], { commit: false });
    await manager.updateRun(run.id, { pid: 999_999 }, { commit: false });
    const reconciled = await manager.reconcileRuns({ commit: false });
    assert.equal(reconciled.length, 1);
    assert.equal(manager.project.runs[0]!.status, "INTERRUPTED");
    assert.equal(manager.project.plans.plans[0]!.nodes[0]!.status, "INTERRUPTED");

    await manager.finishRun(run.id, { status: "COMPLETED", outputs: [{ description: "metric=0.91" }] }, { commit: false });
    assert.equal(manager.project.runs[0]!.status, "COMPLETED");
    assert.equal(manager.project.plans.plans[0]!.nodes[0]!.status, "COMPLETED");
    assert.ok(manager.project.plans.plans[0]!.nodes[0]!.outputs.includes("metric=0.91"));
  });

  test("concurrent mutations are serialized and both persist", async () => {
    const { root, manager } = await newProject("Concurrency");
    dirs.push(root);
    await Promise.all([
      manager.createGoal({ title: "A" }, { commit: false }),
      manager.createGoal({ title: "B" }, { commit: false }),
      manager.createGoal({ title: "C" }, { commit: false }),
    ]);
    const reloaded = await manager.read((project) => project);
    assert.equal(reloaded.goals.length, 3);
    assert.equal(new Set(reloaded.goals.map((goal) => goal.id)).size, 3);
  });

  test("external hand edits are picked up on the next read", async () => {
    const { root, manager } = await newProject("External");
    dirs.push(root);
    await manager.createGoal({ title: "original" }, { commit: false });
    const goalsFile = join(root, PROJECT_DIR, "goals.yaml");
    const text = await readFile(goalsFile, "utf8");
    await writeFile(goalsFile, text.replace("original", "edited on disk"), "utf8");
    const goals = await manager.read((project) => project.goals);
    assert.equal(goals[0]!.title, "edited on disk");
  });

  test("validation detects referential problems", async () => {
    const { root, manager } = await newProject("Validation");
    dirs.push(root);
    await manager.createGoal({ title: "G", questions: ["Q999"] }, { commit: false });
    await manager.read(() => undefined);
    const issues = manager.issues();
    assert.ok(issues.some((issue) => issue.includes("missing question Q999")), issues.join("\n"));
    assert.ok(issues.some((issue) => issue.includes("vision is empty")));

    // The same checks apply after a reload from disk.
    const reloaded = await ProjectManager.open(root, { clock: fixedClock() });
    assert.ok(reloaded.issues().some((issue) => issue.includes("missing question Q999")));
  });

  test("completion requires approval outside YOLO and writes a summary", async () => {
    const { root, manager } = await newProject("Completion");
    dirs.push(root);
    await manager.createGoal({ title: "Goal A" }, { commit: false });
    await manager.setGoalStatus("G1", "COMPLETED", { commit: false });
    const blocked = await manager.completeProject({ commit: false });
    assert.equal(blocked.status, "requires-approval");
    await manager.setYolo(true, { commit: false });
    const done = await manager.completeProject({ commit: false });
    assert.equal(done.status, "applied");
    assert.equal(manager.project.meta.completed, true);

    const summary = renderCompletionSummary(manager.project);
    assert.match(summary, /Project Summary/);
    assert.match(summary, /Goal A/);
    assert.match(summary, /Plan Evolution/);
    assert.match(summary, /Lessons/);
  });
});

describe("history and formatting", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  test("away summary and plan evolution tell the story", async () => {
    const { root, manager } = await newProject("Story");
    dirs.push(root);
    const clock = manager.clock as ReturnType<typeof fixedClock>;
    const goal = await manager.createGoal({ title: "Story goal" }, { commit: false });
    await manager.answerQuestion(
      (await manager.createQuestion({ question: "Will it?", importance: 1, uncertainty: 1, decisionImpact: 1 }, { commit: false })).id,
      { answer: "yes", status: "CONFIRMED" },
      { commit: false },
    );
    await manager.createRisk({ title: "Story risk", probability: 0.3, impact: 0.9 }, { commit: false });
    await manager.setGoalStatus(goal.id, "COMPLETED", { commit: false });
    await manager.applyReplan(manager.analyzeReplan({ trigger: "first" }), { commit: false });
    clock.tick();
    await manager.applyReplan(manager.analyzeReplan({ trigger: "second", title: "Story plan v2" }), { commit: false });

    const summary = summarizeSince(manager.project, "2026-01-01T00:00:00.000Z");
    assert.ok(summary.goalsCompleted.length >= 1);
    assert.ok(summary.questionsAnswered.length >= 1);
    assert.ok(summary.planChanges.length >= 1);
    const text = formatAwaySummary(summary);
    assert.match(text, /Goals completed/);

    const evolution = planEvolution(manager.project);
    assert.equal(evolution.length, 2);
    assert.equal(evolution[1]!.version, 2);
    assert.ok(evolution[1]!.change);
    assert.equal(evolution[1]!.change!.trigger, "second");
  });

  test("status, digest and targeted context render usable text", async () => {
    const { root, manager } = await newProject("Context");
    dirs.push(root);
    await manager.updateDirection({ vision: "Vision text", intent: "Intent text" }, { commit: false, approved: true });
    await manager.updateState({ current: "Prototype works.", capabilities: ["cli"] }, { commit: false });
    const risk = await manager.createRisk({ title: "Evaluation reliability", probability: 0.4, impact: 0.9 }, { commit: false });
    await manager.createQuestion(
      { question: "Does evaluator correlate with humans?", importance: 1, uncertainty: 1, decisionImpact: 0.8, risks: [risk.id] },
      { commit: false },
    );
    await manager.applyReplan(manager.analyzeReplan({ trigger: "kickoff" }), { commit: false });

    const status = renderStatusText(manager.project);
    assert.match(status, /Vision text/);
    assert.match(status, /Prototype works\./);
    assert.match(status, /Highest risk/);

    const digest = buildDigest(manager.project);
    assert.match(digest, /PROJECT: Context/);
    assert.match(digest, /TOP UNKNOWN/);
    assert.match(digest, /NEXT:/);
    // A capped NEXT list says how many ready nodes it hid, so the digest never
    // looks complete while withholding work.
    assert.doesNotMatch(digest, /\(\+\d+ more ready/, "nothing is hidden yet, so no pointer is expected");
    for (const node of manager.project.plans.plans[0]!.nodes) {
      await manager.updateNode(node.id, { status: "COMPLETED" }, { commit: false });
    }
    await manager.addNode({ title: "Fifth ready task", type: "TASK" }, { commit: false });
    await manager.addNode({ title: "Sixth ready task", type: "TASK" }, { commit: false });
    for (const extra of ["Seventh", "Eighth", "Ninth"]) {
      await manager.addNode({ title: `${extra} ready task`, type: "TASK" }, { commit: false });
    }
    const capped = buildDigest(manager.project);
    assert.match(capped, /NEXT:/);
    assert.match(capped, /\(\+\d+ more ready — \/project plan\)/, "a capped NEXT list must point at the full list");

    const node = manager.project.plans.plans[0]!.nodes[0]!;
    const targeted = buildTargetedContext(manager.project, { node: node.id, history: true });
    assert.match(targeted, new RegExp(`ACTIVE NODE: ${node.id}`));
    assert.match(targeted, /RECENT HISTORY/);

    const searched = buildTargetedContext(manager.project, { query: "evaluator correlate" });
    assert.match(searched, /RELATED QUESTIONS|RELATED RISKS/);

    const resume = buildResumeReport(manager.project);
    assert.match(resume, /# Resume: Context/);
    assert.match(resume, /Next actions/);
  });
});
