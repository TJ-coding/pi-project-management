import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { BUDGETS, budgetViolations, collectTextFields, countWords, overBudget, overBudgetFields } from "../src/limits.ts";
import { ProjectManager } from "../src/project.ts";
import { cleanup, fixedClock, tempDir } from "./helpers.ts";

const prose = (words: number) => Array.from({ length: words }, (_, index) => `word${index}`).join(" ");

describe("limits", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  test("counts words and reports only the binding violation", () => {
    assert.equal(countWords("  one two   three "), 3);
    assert.equal(countWords(""), 0);
    assert.equal(overBudget("Short and sweet", "title"), null);

    const thirteenWords = Array.from({ length: 13 }, (_, index) => `w${index}`).join(" ");
    const byWords = overBudget(thirteenWords, "title");
    assert.ok(byWords, "13 words must exceed a 12-word headline");
    assert.deepEqual(byWords!.exceeded, ["13 words (max 12)"]);

    const byChars = overBudget(`${"x".repeat(240)} y`, "line");
    assert.ok(byChars);
    assert.deepEqual(byChars!.exceeded, [`242 chars (max ${BUDGETS.line.chars})`]);
  });

  test("untouched long text is grandfathered and edits may only shrink it", () => {
    const key = "goal:G1.description";
    const long = prose(120);
    const before = new Map([[key, { key, label: "G1 description", text: long, kind: "prose" as const }]]);

    // Unrelated edits are never blocked by legacy text…
    assert.deepEqual(budgetViolations(before, new Map(before)), []);

    // …and the ratchet allows tightening in more than one pass.
    const tightened = new Map([[key, { ...before.get(key)!, text: prose(90) }]]);
    assert.deepEqual(budgetViolations(before, tightened), [], "a shrinking edit must be accepted");

    // Growing it is refused, with the previous size named.
    const grown = new Map([[key, { ...before.get(key)!, text: prose(150) }]]);
    const violations = budgetViolations(before, grown);
    assert.equal(violations.length, 1);
    assert.match(violations[0]!, /G1 description is \d+ (words|chars)/);
    assert.match(violations[0]!, /may only shrink/);
  });

  test("every budgeted field has a known kind and a path", async () => {
    const root = await tempDir();
    dirs.push(root);
    const manager = await ProjectManager.init(root, { name: "Limits", clock: fixedClock(), by: "test" });
    await manager.updateDirection({ vision: "Ship it.", values: ["Short"] }, { approved: true, commit: false });
    await manager.createGoal({ title: "Short goal", description: "One tight sentence.", successCriteria: ["criterion"], commit: false } as never, { commit: false });
    const project = await manager.read((current) => current);

    const fields = collectTextFields(project);
    assert.ok(fields.has("direction.vision"));
    assert.ok(fields.has("goal:G1.title"));
    assert.ok(fields.has("goal:G1.description"));
    assert.ok(fields.has("goal:G1.successCriteria[0]"));
    for (const field of fields.values()) {
      assert.ok(BUDGETS[field.kind], `${field.key} has an unknown budget kind`);
      assert.ok(field.label.length > 0 && field.key.includes("."), `${field.key} needs a label and a path`);
    }
    assert.deepEqual(overBudgetFields(project), [], "a tight project has nothing over budget");
  });

  test("an over-budget write is rejected and leaves nothing behind", async () => {
    const root = await tempDir();
    dirs.push(root);
    const manager = await ProjectManager.init(root, { name: "Limits", clock: fixedClock(), by: "test" });

    await assert.rejects(
      () => manager.createGoal({ title: "Too long", description: prose(150) }, { commit: false }),
      /keep it Twitter-short/,
    );
    assert.equal((await manager.read((current) => current)).goals.length, 0, "the rejected goal must not be saved");

    // A short version of the same field is accepted.
    await manager.createGoal({ title: "Short goal", description: "One tight sentence, nothing more.", commit: false } as never, { commit: false });
    assert.equal((await manager.read((current) => current)).goals.length, 1);
  });

  test("legacy over-budget text is a warning for the reader, never an error", async () => {
    const root = await tempDir();
    dirs.push(root);
    const manager = await ProjectManager.init(root, { name: "Limits", clock: fixedClock(), by: "test" });
    await manager.createGoal({ title: "Short goal", description: "Tight.", commit: false } as never, { commit: false });
    const project = await manager.read((current) => current);
    // Simulate text written before the budget existed (or before it was tightened).
    const legacy = { ...project, goals: [{ ...project.goals[0]!, description: prose(150) }] };
    const warnings = overBudgetFields(legacy);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.field.label, /G1 description/);
  });
});
