import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { percentBadge, progressBar } from "../src/format.ts";
import { ProjectManager } from "../src/project.ts";
import { activePlan } from "../src/replan.ts";
import { cleanup, fixedClock, tempDir } from "./helpers.ts";

async function newProject(name: string) {
  const root = await tempDir();
  const manager = await ProjectManager.init(root, { name, clock: fixedClock(), by: "test" });
  return { root, manager };
}

describe("progress percent", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  test("a node keeps the percent it was given, and survives a reload", async () => {
    const { root, manager } = await newProject("Node percent");
    dirs.push(root);

    const node = await manager.addNode({ title: "Long job", percent: 40 }, { commit: false });
    assert.equal(node.percent, 40);

    // Round-trips through plan.yaml, so the value is not just in memory.
    await manager.refresh();
    const reloaded = activePlan(manager.project)!.nodes.find((item) => item.id === node.id)!;
    assert.equal(reloaded.percent, 40);

    const updated = await manager.updateNode(node.id, { percent: 75 }, { commit: false });
    assert.equal(updated.percent, 75);

    await manager.refresh();
    assert.equal(activePlan(manager.project)!.nodes.find((item) => item.id === node.id)!.percent, 75);
  });

  test("no percent means null, which is not the same as 0%", async () => {
    const { root, manager } = await newProject("Unestimated");
    dirs.push(root);

    const unestimated = await manager.addNode({ title: "Unknown size" }, { commit: false });
    assert.equal(unestimated.percent, null, "omitting percent means no estimate");

    const none = await manager.addNode({ title: "Started nothing" , percent: 0 }, { commit: false });
    assert.equal(none.percent, 0, "0% is a real estimate and must be kept");

    await manager.refresh();
    const plan = activePlan(manager.project)!;
    assert.equal(plan.nodes.find((item) => item.id === unestimated.id)!.percent, null);
    assert.equal(plan.nodes.find((item) => item.id === none.id)!.percent, 0);
  });

  test("a goal keeps its percent and it round-trips", async () => {
    const { root, manager } = await newProject("Goal percent");
    dirs.push(root);

    const goal = await manager.createGoal({ title: "Finish the thing", percent: 30 }, { commit: false });
    assert.equal(goal.percent, 30);

    await manager.refresh();
    assert.equal(manager.project.goals.find((item) => item.id === goal.id)!.percent, 30);
  });

  test("an out-of-range percent is refused and nothing is written", async () => {
    const { root, manager } = await newProject("Range");
    dirs.push(root);

    const node = await manager.addNode({ title: "Job", percent: 50 }, { commit: false });

    for (const bad of [-1, 101, 999]) {
      await assert.rejects(
        () => manager.updateNode(node.id, { percent: bad }, { commit: false }),
        /between 0 and 100/,
        `${bad} must be refused`,
      );
    }
    await assert.rejects(
      () => manager.addNode({ title: "Bad", percent: 101 }, { commit: false }),
      /between 0 and 100/,
    );
    await assert.rejects(
      () => manager.createGoal({ title: "Bad goal", percent: -5 }, { commit: false }),
      /between 0 and 100/,
    );

    // The rejection must leave the old value alone, not a clamped or partial one.
    assert.equal(activePlan(manager.project)!.nodes.find((item) => item.id === node.id)!.percent, 50);
    await manager.refresh();
    assert.equal(activePlan(manager.project)!.nodes.find((item) => item.id === node.id)!.percent, 50);
  });

  test("percent can be cleared back to no-estimate", async () => {
    const { root, manager } = await newProject("Clear");
    dirs.push(root);

    const node = await manager.addNode({ title: "Job", percent: 60 }, { commit: false });
    const cleared = await manager.updateNode(node.id, { percent: null }, { commit: false });
    assert.equal(cleared.percent, null);

    await manager.refresh();
    assert.equal(activePlan(manager.project)!.nodes.find((item) => item.id === node.id)!.percent, null);
  });

  test("the bar shows a proportion and never hides the number", () => {
    assert.equal(progressBar(0, 10), "▱▱▱▱▱▱▱▱▱▱ 0%");
    assert.equal(progressBar(50, 10), "▰▰▰▰▰▱▱▱▱▱ 50%");
    assert.equal(progressBar(100, 10), "▰▰▰▰▰▰▰▰▰▰ 100%");
    // Rounded, so a bar can never show more than the number claims.
    assert.ok(progressBar(37, 10).includes("37%"));
    // Out of range is clamped in rendering, so a hand-edited file cannot break it.
    assert.ok(progressBar(150, 10).includes("100%"));
    assert.ok(progressBar(-5, 10).includes("0%"));
    for (const percent of [0, 1, 50, 99, 100]) {
      assert.ok(progressBar(percent).includes(`${percent}%`), "the number is always printed");
    }
  });

  test("the badge is empty when there is no estimate", () => {
    assert.equal(percentBadge(null), "");
    assert.equal(percentBadge(0), "0%");
    assert.equal(percentBadge(42), "42%");
  });
});
