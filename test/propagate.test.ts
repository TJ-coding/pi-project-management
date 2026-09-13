import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { ProjectManager } from "../src/project.ts";
import { applyGoalFill, suggestGoalFill } from "../src/propagate.ts";
import { cleanup, fixedClock, tempDir } from "./helpers.ts";

async function scenario() {
  const root = await tempDir();
  const clock = fixedClock();
  const manager = await ProjectManager.init(root, { name: "Fill", clock, by: "test" });
  const goal = await manager.createGoal({ title: "Ship the parser", priority: 4 }, { commit: false });
  // A question and a risk that already name the goal, and a node under it.
  const question = await manager.createQuestion(
    { question: "Which grammar version do we target?", goals: [goal.id] },
    { commit: false },
  );
  const risk = await manager.createRisk(
    { title: "Grammar churn", probability: 0.4, impact: 0.6, goals: [goal.id] },
    { commit: false },
  );
  await manager.addNode({ title: "Read the grammar spec", type: "TASK", goal: goal.id }, { commit: false });
  return { root, manager, goal, question, risk };
}

describe("goal fill-in", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  test("proposes only what the project already knows, and never replaces", async () => {
    const { root, manager, goal, question } = await scenario();
    dirs.push(root);
    const project = await manager.read((current) => current);
    const proposals = suggestGoalFill(project, goal.id);

    const byKey = new Map(proposals.map((proposal) => [proposal.key, proposal]));
    assert.deepEqual(byKey.get("questions")?.add, [question.id], "the linked question is proposed");
    assert.deepEqual(byKey.get("risks")?.add, ["R1"], "the linked risk is proposed");
    assert.deepEqual(byKey.get("tasks")?.add, ["N1"], "the node under the goal is proposed");
    assert.ok(byKey.has("successCriteria"), "an empty criteria list gets a proposal");
    assert.match(byKey.get("successCriteria")!.add[0]!, /Answer Q1/, "and it is phrased as the finish line");
    assert.ok(byKey.has("description"), "an empty description gets a seed");
    // The goal still has none of it: proposals change nothing on their own.
    const untouched = await manager.read((current) => current);
    assert.deepEqual(untouched.goals[0]!.questions, []);
  });

  test("applying appends and is idempotent", async () => {
    const { root, manager, goal } = await scenario();
    dirs.push(root);
    const project = await manager.read((current) => current);
    const accepted = suggestGoalFill(project, goal.id);

    const patch = applyGoalFill(project.goals[0]!, accepted);
    await manager.updateGoal(goal.id, patch, { commit: false });

    const filled = await manager.read((current) => current);
    const after = filled.goals[0]!;
    assert.deepEqual(after.questions, ["Q1"]);
    assert.deepEqual(after.risks, ["R1"]);
    assert.deepEqual(after.tasks, ["N1"]);
    assert.ok(after.successCriteria.length > 0);
    assert.match(after.description, /grammar version/i);

    // Nothing left to propose, and applying again would not duplicate links.
    const again = suggestGoalFill(filled, goal.id);
    assert.equal(again.length, 0, "a completed goal has nothing left to propose");
  });

  test("a goal whose fields are already filled is left alone", async () => {
    const { root, manager, goal, question, risk } = await scenario();
    dirs.push(root);
    await manager.updateGoal(
      goal.id,
      {
        description: "Hand-written description that must survive",
        questions: [question.id],
        risks: [risk.id],
        tasks: ["N1"],
        successCriteria: ["A hand-written criterion"],
      },
      { commit: false },
    );
    const project = await manager.read((current) => current);
    const proposals = suggestGoalFill(project, goal.id);
    assert.equal(proposals.length, 0, "nothing to add to a complete goal");

    // An empty patch means "change nothing": leaving a field undefined is how
    // updateGoal is told not to touch it.
    const patch = applyGoalFill(project.goals[0]!, proposals);
    assert.equal(patch.description, undefined, "the hand-written description is not overwritten");
    assert.deepEqual(patch.successCriteria, ["A hand-written criterion"]);
    assert.deepEqual(patch.questions, ["Q1"]);
    await manager.updateGoal(goal.id, patch, { commit: false });
    const reread = await manager.read((current) => current);
    assert.equal(reread.goals[0]!.description, "Hand-written description that must survive");
  });

  test("an unknown goal proposes nothing rather than throwing", async () => {
    const { root, manager } = await scenario();
    dirs.push(root);
    const project = await manager.read((current) => current);
    assert.deepEqual(suggestGoalFill(project, "G99"), []);
  });
});
