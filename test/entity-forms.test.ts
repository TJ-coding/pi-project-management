import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  directionForm,
  documentForm,
  entityChoices,
  entityForm,
  goalForm,
  questionForm,
  riskForm,
  stateForm,
  strategyForm,
} from "../src/entity-forms.ts";
import { FormEditor } from "../src/form.ts";
import { ProjectManager } from "../src/project.ts";
import { cleanup, fixedClock, tempDir } from "./helpers.ts";
import type { FormField } from "../src/form.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

async function project(name: string) {
  const root = await tempDir();
  const manager = await ProjectManager.init(root, { name, clock: fixedClock(), by: "test" });
  await manager.updateDirection({ vision: "V", intent: "I", values: ["Simple"] }, { approved: true, commit: false });
  await manager.updateState({ current: "S" }, { commit: false });
  await manager.createGoal({ title: "Goal one", priority: 3, successCriteria: ["done"] }, { commit: false });
  await manager.createQuestion({ question: "Q one?", importance: 0.5, uncertainty: 1, decisionImpact: 0.5 }, { commit: false });
  await manager.createRisk({ title: "Risk one", probability: 0.4, impact: 0.8 }, { commit: false });
  await manager.setStrategy({ approach: "A" }, { commit: false });
  await manager.applyReplan(manager.analyzeReplan({ trigger: "test" }), { commit: false });
  return { root, manager };
}

/** Drive a form field directly (bypassing key handling) for value-level tests. */
function field(form: { fields: FormField[] }, key: string): FormField {
  const found = form.fields.find((candidate) => candidate.key === key);
  assert.ok(found, `field ${key} missing`);
  return found;
}

describe("entity forms", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  test("goal edit form loads the entity, saves changes and records history", async () => {
    const { root, manager } = await project("Goals");
    dirs.push(root);
    const form = goalForm(manager.project, "G1");
    assert.match(form.title, /G1/);

    (field(form, "title") as Extract<FormField, { kind: "text" }>).set("Goal one (edited)");
    (field(form, "priority") as Extract<FormField, { kind: "int" }>).set(5);
    (field(form, "status") as Extract<FormField, { kind: "enum" }>).set("COMPLETED");
    (field(form, "successCriteria") as Extract<FormField, { kind: "list" }>).set(["done", "verified"]);
    (field(form, "questions") as Extract<FormField, { kind: "refs" }>).set(["Q1"]);
    (field(form, "risks") as Extract<FormField, { kind: "refs" }>).set(["R1"]);

    const summary = await form.save(manager);
    assert.match(summary, /G1 updated/);

    const reloaded = await manager.read((current) => current);
    assert.equal(reloaded.goals[0]!.title, "Goal one (edited)");
    assert.equal(reloaded.goals[0]!.priority, 5);
    assert.equal(reloaded.goals[0]!.status, "COMPLETED");
    assert.deepEqual(reloaded.goals[0]!.successCriteria, ["done", "verified"]);
    assert.deepEqual(reloaded.goals[0]!.questions, ["Q1"]);
    assert.ok(reloaded.history.some((event) => event.kind === "goal.completed"));
  });

  test("goal create form assigns an id, and delete removes links", async () => {
    const { root, manager } = await project("Create delete");
    dirs.push(root);
    const create = goalForm(manager.project);
    assert.doesNotMatch(create.title, /G\d/);
    (field(create, "title") as Extract<FormField, { kind: "text" }>).set("Brand new goal");
    (field(create, "priority") as Extract<FormField, { kind: "int" }>).set(4);
    assert.match(await create.save(manager), /G2 created/);

    // Link goal one to goal two, then delete goal two and confirm links are gone.
    const linkForm = goalForm(await manager.read((current) => current), "G1");
    (field(linkForm, "parent") as Extract<FormField, { kind: "ref" }>).set("G2");
    await linkForm.save(manager);
    let reloaded = await manager.read((current) => current);
    assert.equal(reloaded.goals.find((goal) => goal.id === "G1")!.parent, "G2");

    const deleteForm = goalForm(reloaded, "G2");
    assert.ok(deleteForm.remove);
    assert.match(await deleteForm.remove!(manager), /G2 deleted/);
    reloaded = await manager.read((current) => current);
    assert.equal(reloaded.goals.length, 1);
    assert.equal(reloaded.goals[0]!.parent, null);
    assert.deepEqual(manager.issues().filter((issue) => issue.includes("G2")), []);
  });

  test("risk form exposes computed exposure and saves numbers", async () => {
    const { root, manager } = await project("Risks");
    dirs.push(root);
    const form = riskForm(manager.project, "R1");
    const exposure = field(form, "exposure");
    assert.equal(typeof exposure.hint, "function");
    assert.match((exposure.hint as () => string)(), /0\.32/);
    (field(form, "probability") as Extract<FormField, { kind: "float" }>).set(0.9);
    (field(form, "impact") as Extract<FormField, { kind: "float" }>).set(0.9);
    (field(form, "status") as Extract<FormField, { kind: "enum" }>).set("MITIGATING");
    (field(form, "mitigation") as Extract<FormField, { kind: "prose" }>).set("Run the comparison");
    assert.match((field(form, "exposure").hint as () => string)(), /0\.81/);
    assert.match(await form.save(manager), /R1 updated/);
    const reloaded = await manager.read((current) => current);
    assert.equal(reloaded.risks[0]!.probability, 0.9);
    assert.equal(reloaded.risks[0]!.status, "MITIGATING");
    assert.equal(reloaded.risks[0]!.mitigation, "Run the comparison");
  });

  test("question form computes the priority score", async () => {
    const { root, manager } = await project("Questions");
    dirs.push(root);
    const form = questionForm(manager.project, "Q1");
    (field(form, "importance") as Extract<FormField, { kind: "float" }>).set(1);
    (field(form, "uncertainty") as Extract<FormField, { kind: "float" }>).set(1);
    (field(form, "decisionImpact") as Extract<FormField, { kind: "float" }>).set(1);
    assert.match((field(form, "score").hint as () => string)(), /1\.00 +CRITICAL/);
    (field(form, "status") as Extract<FormField, { kind: "enum" }>).set("ANSWERED");
    (field(form, "answer") as Extract<FormField, { kind: "prose" }>).set("Yes, with evidence");
    (field(form, "confidence") as Extract<FormField, { kind: "float" }>).set(0.8);
    assert.match(await form.save(manager), /Q1 updated/);
    const reloaded = await manager.read((current) => current);
    assert.equal(reloaded.questions[0]!.status, "ANSWERED");
    assert.equal(reloaded.questions[0]!.answer, "Yes, with evidence");
    assert.equal(reloaded.questions[0]!.confidence, 0.8);
  });

  test("document forms save direction, state and strategy", async () => {
    const { root, manager } = await project("Documents");
    dirs.push(root);

    const direction = directionForm(manager.project);
    (field(direction, "vision") as Extract<FormField, { kind: "prose" }>).set("New vision");
    (field(direction, "values") as Extract<FormField, { kind: "list" }>).set(["Simple", "Reliable"]);
    (field(direction, "concepts") as Extract<FormField, { kind: "list" }>).set(["[technical] Git is the state", "no type here"]);
    assert.match(await direction.save(manager), /Direction saved/);

    const state = stateForm(await manager.read((current) => current));
    (field(state, "current") as Extract<FormField, { kind: "prose" }>).set("Everything works");
    (field(state, "capabilities") as Extract<FormField, { kind: "list" }>).set(["cli", "tui"]);
    await state.save(manager);

    const strategy = strategyForm(await manager.read((current) => current));
    (field(strategy, "approach") as Extract<FormField, { kind: "prose" }>).set("Focus");
    (field(strategy, "priorities") as Extract<FormField, { kind: "list" }>).set(["First", "Second"]);
    await strategy.save(manager);

    const reloaded = await manager.read((current) => current);
    assert.equal(reloaded.direction.vision, "New vision");
    assert.deepEqual(reloaded.direction.values, ["Simple", "Reliable"]);
    assert.deepEqual(reloaded.direction.concepts, [
      { type: "technical", text: "Git is the state" },
      { type: "concept", text: "no type here" },
    ]);
    assert.equal(reloaded.state.current, "Everything works");
    assert.deepEqual(reloaded.state.capabilities, ["cli", "tui"]);
    assert.equal(reloaded.strategy.approach, "Focus");
    assert.deepEqual(reloaded.strategy.priorities, ["First", "Second"]);
  });

  test("entity choices describe each entity for the picker", async () => {
    const { root, manager } = await project("Choices");
    dirs.push(root);
    const projectValue = await manager.read((current) => current);
    assert.deepEqual(entityChoices(projectValue, "goal").map((choice) => choice.id), ["G1"]);
    assert.match(entityChoices(projectValue, "goal")[0]!.description, /P3/);
    assert.match(entityChoices(projectValue, "risk")[0]!.description, /exposure 0\.32/);
    assert.match(entityChoices(projectValue, "question")[0]!.label, /Q1/);
  });

  test("documentForm dispatches by section and entityForm by kind", async () => {
    const { root, manager } = await project("Dispatch");
    dirs.push(root);
    const projectValue = await manager.read((current) => current);
    assert.ok(documentForm("direction", projectValue));
    assert.ok(documentForm("state", projectValue));
    assert.ok(documentForm("strategy", projectValue));
    assert.equal(documentForm("goals", projectValue), undefined);
    assert.match(entityForm("goal", projectValue).title, /New goal|G\d/);
    assert.match(entityForm("risk", projectValue).title, /New risk|R\d/);
    assert.match(entityForm("question", projectValue).title, /New question|Q\d/);
  });

  test("a form renders end-to-end with the real FormEditor", async () => {
    const { root, manager } = await project("Rendering");
    dirs.push(root);
    const form = goalForm(manager.project, "G1");
    const actions: string[] = [];
    const editor = new FormEditor({
      title: form.title,
      fields: form.fields,
      theme,
      getTerminalRows: () => 30,
      onExit: (action) => actions.push(action.kind),
    });
    const frame = editor.render(100).join("\n");
    assert.match(frame, /Title/);
    assert.match(frame, /Goal one/);
    assert.match(frame, /Priority/);
    assert.match(frame, /Success criteria/);
    assert.match(frame, /done/);
    editor.handleInput("s");
    assert.deepEqual(actions, ["save"]);
  });
});
