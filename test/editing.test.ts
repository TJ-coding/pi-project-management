import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { EDITABLE_SECTIONS, editableForView, editableSection, editableSectionIds } from "../src/editing.ts";
import { ProjectManager } from "../src/project.ts";
import { cleanup, fixedClock, tempDir } from "./helpers.ts";

async function project(name: string) {
  const root = await tempDir();
  const clock = fixedClock();
  const manager = await ProjectManager.init(root, { name, clock, by: "test" });
  await manager.updateDirection(
    { vision: "Original vision", intent: "Original intent", values: ["Simple"] },
    { approved: true, commit: false },
  );
  await manager.updateState({ current: "Original state" }, { commit: false });
  await manager.createGoal({ title: "Original goal", priority: 3 }, { commit: false });
  await manager.createQuestion({ question: "Original question?", importance: 0.5, uncertainty: 1, decisionImpact: 0.5 }, { commit: false });
  await manager.createRisk({ title: "Original risk", probability: 0.5, impact: 0.5 }, { commit: false });
  await manager.setStrategy({ approach: "Original approach" }, { commit: false });
  await manager.applyReplan(manager.analyzeReplan({ trigger: "test" }), { commit: false });
  return { root, manager };
}

describe("human editing", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  test("every editable section has a source text and a stable id", async () => {
    const { root, manager } = await project("Sections");
    dirs.push(root);
    assert.deepEqual(editableSectionIds(), ["direction", "state", "strategy", "goals", "intelligence", "risks", "plan"]);
    for (const section of EDITABLE_SECTIONS) {
      const text = section.read(manager.project);
      assert.ok(text.length > 0, `${section.id} has no source text`);
      assert.ok(editableSection(section.id) === section);
      assert.ok(editableForView(section.view) === section);
    }
    assert.equal(editableSection("Goals"), EDITABLE_SECTIONS[3]);
    assert.equal(editableSection("nope"), undefined);
  });

  test("markdown sections round-trip through the editor", async () => {
    const { root, manager } = await project("Markdown");
    dirs.push(root);

    const direction = editableSection("direction")!;
    const directionText = direction.read(manager.project).replace("Original vision", "Edited vision");
    const directionSummary = await direction.apply(manager, directionText, { approved: true, approvedBy: "human" });
    assert.match(directionSummary, /Direction/);

    const state = editableSection("state")!;
    const stateText = state.read(manager.project).replace("Original state", "Edited state").replace("## Capabilities\n\n_None yet._", "## Capabilities\n\n- new capability");
    await state.apply(manager, stateText, {});

    const strategy = editableSection("strategy")!;
    await strategy.apply(manager, strategy.read(manager.project).replace("Original approach", "Edited approach"), {});

    const reloaded = await manager.read((current) => current);
    assert.equal(reloaded.direction.vision, "Edited vision");
    assert.equal(reloaded.state.current, "Edited state");
    assert.deepEqual(reloaded.state.capabilities, ["new capability"]);
    assert.equal(reloaded.strategy.approach, "Edited approach");
    assert.ok(reloaded.history.some((event) => event.summary.includes("Direction changed")));
    assert.ok(reloaded.history.some((event) => event.summary.includes("edited by hand")));
  });

  test("yaml sections round-trip and record history", async () => {
    const { root, manager } = await project("Yaml");
    dirs.push(root);

    const goals = editableSection("goals")!;
    const goalsText = goals.read(manager.project).replace("Original goal", "Edited goal").replace("priority: 3", "priority: 5");
    assert.match(await goals.apply(manager, goalsText, {}), /1 goal/);

    const questions = editableSection("intelligence")!;
    await questions.apply(manager, questions.read(manager.project).replace("Original question?", "Edited question?"), {});

    const risks = editableSection("risks")!;
    await risks.apply(manager, risks.read(manager.project).replace("probability: 0.5", "probability: 0.9"), {});

    const plan = editableSection("plan")!;
    await plan.apply(manager, plan.read(manager.project), {});

    const reloaded = await manager.read((current) => current);
    assert.equal(reloaded.goals[0]!.title, "Edited goal");
    assert.equal(reloaded.goals[0]!.priority, 5);
    assert.equal(reloaded.questions[0]!.question, "Edited question?");
    assert.equal(reloaded.risks[0]!.probability, 0.9);
    assert.ok(reloaded.history.some((event) => event.summary.includes("Goals edited by hand")));
    assert.ok(reloaded.history.some((event) => event.summary.includes("Intelligence edited by hand")));
    assert.ok(reloaded.history.some((event) => event.summary.includes("Risks edited by hand")));

    // A full reload from disk preserves the edits (they really were persisted).
    const reopened = await ProjectManager.open(root, { clock: fixedClock() });
    assert.equal(reopened.project.goals[0]!.title, "Edited goal");
    assert.equal(reopened.project.risks[0]!.probability, 0.9);
  });

  test("added and removed entities are reflected in the history summary", async () => {
    const { root, manager } = await project("Counts");
    dirs.push(root);
    const goals = editableSection("goals")!;
    const text = `${goals.read(manager.project)}\n- id: G2\n  title: Added by hand\n  description: ""\n  priority: 2\n  success_criteria: []\n  status: ACTIVE\n  parent: null\n  questions: []\n  risks: []\n  tasks: []\n`;
    await goals.apply(manager, text, {});
    const reloaded = await manager.read((current) => current);
    assert.equal(reloaded.goals.length, 2);
    assert.ok(reloaded.history.some((event) => /Goals edited by hand: 2 total \(\+1\/-0\)/.test(event.summary)));
  });

  test("invalid text is rejected without changing the project", async () => {
    const { root, manager } = await project("Invalid");
    dirs.push(root);

    const goals = editableSection("goals")!;
    const before = await manager.read((current) => current);
    await assert.rejects(() => goals.apply(manager, "not: a list\n", {}), /must contain a YAML list/);
    await assert.rejects(() => goals.apply(manager, "title: [unclosed", {}));
    const after = await manager.read((current) => current);
    assert.equal(after.goals.length, before.goals.length);
    assert.equal(after.goals[0]!.title, "Original goal");
  });

  test("an edit that would break references is rejected, pre-existing issues do not block", async () => {
    const { root, manager } = await project("Dangling");
    dirs.push(root);

    const goals = editableSection("goals")!;
    const dangling = goals.read(manager.project).replace("questions: []", "questions:\n    - Q999");
    await assert.rejects(() => goals.apply(manager, dangling, {}), /links to missing question Q999/);
    const untouched = await manager.read((current) => current);
    assert.deepEqual(untouched.goals[0]!.questions, []);

    // Pre-existing breakage (as if a human edited files outside the extension)
    // must not block unrelated edits from being saved.
    const goalsFile = `${root}/.project/goals.yaml`;
    const { readFile, writeFile } = await import("node:fs/promises");
    const onDisk = await readFile(goalsFile, "utf8");
    await writeFile(goalsFile, onDisk.replace("questions: []", "questions:\n    - Q999"), "utf8");

    const risks = editableSection("risks")!;
    const risksText = risks.read(await manager.read((current) => current)).replace("probability: 0.5", "probability: 0.7");
    await risks.apply(manager, risksText, {});
    const reloaded = await manager.read((current) => current);
    assert.equal(reloaded.risks[0]!.probability, 0.7);
    assert.deepEqual(reloaded.goals[0]!.questions, ["Q999"], "the pre-existing issue is left as-is");
  });

  test("a strategic direction edit still needs approval outside YOLO", async () => {
    const { root, manager } = await project("Strategic");
    dirs.push(root);
    const direction = editableSection("direction")!;
    const text = direction.read(manager.project).replace("Original vision", "Unapproved vision");
    await assert.rejects(() => direction.apply(manager, text, { approved: false }), /requires human approval/);
    const reloaded = await manager.read((current) => current);
    assert.equal(reloaded.direction.vision, "Original vision");

    await manager.setYolo(true, { commit: false });
    await direction.apply(manager, text, {});
    assert.equal((await manager.read((current) => current)).direction.vision, "Unapproved vision");
  });
});
