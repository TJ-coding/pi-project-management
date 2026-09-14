import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { ProjectManager } from "../src/project.ts";
import { validateProject } from "../src/validate.ts";
import { cleanup, fixedClock, tempDir } from "./helpers.ts";

async function newProject(name: string) {
  const root = await tempDir();
  const manager = await ProjectManager.init(root, { name, clock: fixedClock(), by: "test" });
  return { root, manager };
}

describe("validation", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  test("a node id reused by a later plan is not a duplicate", async () => {
    const { root, manager } = await newProject("Node ids");
    dirs.push(root);

    const replan = async (title: string, nodes: { ref?: string; title: string }[]) =>
      manager.applyReplan(
        {
          trigger: title,
          rationale: "test",
          title,
          notes: [],
          superseded: [],
          carried: [],
          nodes: nodes.map((node) => ({ ...node, type: "TASK" as const })),
        },
        { commit: false },
      );

    await replan("P1", [{ title: "first" }, { title: "second" }]);
    await replan("P2", [{ ref: "N1", title: "first" }, { title: "third" }]);
    await replan("P3", [{ title: "fresh" }]);

    // N2 lives in both P1 and P3 by design, so a global check would be wrong.
    assert.equal(manager.project.plans.plans[0]!.nodes.some((node) => node.id === "N2"), true);
    assert.equal(manager.project.plans.plans[2]!.nodes.some((node) => node.id === "N2"), true);
    assert.deepEqual(
      validateProject(manager.project).filter((issue) => issue.includes("duplicate")),
      [],
    );
  });

  test("two nodes with the same id inside one plan are still refused", async () => {
    const { root, manager } = await newProject("Same plan");
    dirs.push(root);

    await manager.applyReplan(
      {
        trigger: "P1",
        rationale: "test",
        title: "P1",
        notes: [],
        superseded: [],
        carried: [],
        nodes: [{ ref: "N1", title: "first", type: "TASK" }, { ref: "N1", title: "clash", type: "TASK" }],
      },
      { commit: false },
    );

    assert.ok(
      validateProject(manager.project).some((issue) => issue.includes("duplicate id") && issue.includes("node")),
      "a plan that owns the same id twice must be reported",
    );
  });
});
