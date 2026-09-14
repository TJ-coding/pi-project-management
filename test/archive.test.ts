import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { archivedCounts, isArchived, VIEWS, viewCounts } from "../src/dashboard.ts";
import { ProjectManager } from "../src/project.ts";
import { activePlan } from "../src/replan.ts";
import { cleanup, fixedClock, tempDir } from "./helpers.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

async function newProject(name: string) {
  const root = await tempDir();
  const manager = await ProjectManager.init(root, { name, clock: fixedClock(), by: "test" });
  return { root, manager };
}

describe("archiving", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  test("a goal can be archived and restored, and survives a reload", async () => {
    const { root, manager } = await newProject("Goal archive");
    dirs.push(root);

    await manager.createGoal({ title: "Still relevant" }, { commit: false });
    await manager.createGoal({ title: "No longer relevant" }, { commit: false });

    const archived = await manager.setArchived("goal", "G2", true, { commit: false, reason: "superseded by another goal" });
    assert.equal(archived.archived, true);
    assert.equal(archived.changed, true);

    await manager.refresh();
    assert.equal(manager.project.goals.find((goal) => goal.id === "G2")!.archived, true);
    assert.equal(manager.project.goals.find((goal) => goal.id === "G1")!.archived, false);

    // Archiving twice reports that nothing changed, rather than logging a no-op.
    const again = await manager.setArchived("goal", "G2", true, { commit: false });
    assert.equal(again.changed, false);

    const restored = await manager.setArchived("goal", "G2", false, { commit: false });
    assert.equal(restored.changed, true);
    await manager.refresh();
    assert.equal(manager.project.goals.find((goal) => goal.id === "G2")!.archived, false);
  });

  test("every archivable kind round-trips through its file", async () => {
    const { root, manager } = await newProject("All kinds");
    dirs.push(root);

    await manager.createGoal({ title: "G" }, { commit: false });
    await manager.createQuestion({ question: "Q?" }, { commit: false });
    await manager.createRisk({ title: "R" }, { commit: false });
    await manager.addNode({ title: "N" }, { commit: false });

    for (const [kind, id] of [["goal", "G1"], ["question", "Q1"], ["risk", "R1"], ["node", "N1"]] as const) {
      await manager.setArchived(kind, id, true, { commit: false });
    }

    await manager.refresh();
    assert.equal(isArchived(manager.project.goals.find((goal) => goal.id === "G1")!), true);
    assert.equal(isArchived(manager.project.questions.find((question) => question.id === "Q1")!), true);
    assert.equal(isArchived(manager.project.risks.find((risk) => risk.id === "R1")!), true);
    assert.equal(isArchived(activePlan(manager.project)!.nodes.find((node) => node.id === "N1")!), true);
  });

  test("an archived item is never deleted and keeps its links", async () => {
    const { root, manager } = await newProject("Kept");
    dirs.push(root);

    const risk = await manager.createRisk({ title: "Linked risk" }, { commit: false });
    const goal = await manager.createGoal({ title: "Linked goal", risks: [risk.id] }, { commit: false });
    await manager.setArchived("goal", goal.id, true, { commit: false });

    await manager.refresh();
    const kept = manager.project.goals.find((item) => item.id === goal.id)!;
    assert.equal(kept.title, "Linked goal", "the record is intact, not deleted");
    assert.deepEqual(kept.risks, [risk.id], "links survive archiving");
    assert.ok(manager.project.risks.some((item) => item.id === risk.id), "the linked risk is untouched");
  });

  test("archiving a missing id fails loudly instead of silently doing nothing", async () => {
    const { root, manager } = await newProject("Missing");
    dirs.push(root);
    await assert.rejects(() => manager.setArchived("goal", "G99", true, { commit: false }), /goal G99/i);
    await assert.rejects(() => manager.setArchived("risk", "R42", true, { commit: false }), /risk R42/i);
  });

  test("archived items stop counting as active work", async () => {
    const { root, manager } = await newProject("Counts");
    dirs.push(root);

    await manager.createGoal({ title: "Active A", priority: 5 }, { commit: false });
    await manager.createGoal({ title: "Active B", priority: 4 }, { commit: false });
    await manager.createQuestion({ question: "Open Q?", importance: 1, uncertainty: 1, decisionImpact: 1 }, { commit: false });
    await manager.createRisk({ title: "Open R", probability: 0.6, impact: 0.6 }, { commit: false });
    await manager.addNode({ title: "Node A" }, { commit: false });
    await manager.addNode({ title: "Node B" }, { commit: false });

    const before = viewCounts(manager.project);
    assert.equal(before.get("goals"), 2);
    assert.equal(before.get("intelligence"), 1);
    assert.equal(before.get("risks"), 1);
    assert.equal(before.get("plan"), 2);

    await manager.setArchived("goal", "G1", true, { commit: false });
    await manager.setArchived("question", "Q1", true, { commit: false });
    await manager.setArchived("risk", "R1", true, { commit: false });
    await manager.setArchived("node", "N1", true, { commit: false });

    const after = viewCounts(manager.project);
    assert.equal(after.get("goals"), 1, "an archived goal stops counting");
    assert.equal(after.get("intelligence"), 0, "an archived question stops counting");
    assert.equal(after.get("risks"), 0, "an archived risk stops counting");
    assert.equal(after.get("plan"), 1, "an archived node stops counting");

    const counts = archivedCounts(manager.project);
    assert.deepEqual(counts, { goals: 1, questions: 1, risks: 1, nodes: 1, total: 4 });
  });

  test("the panel says how many are hidden and shows them on request", async () => {
    const { root, manager } = await newProject("Hidden");
    dirs.push(root);
    await manager.createGoal({ title: "Visible goal" }, { commit: false });
    await manager.createGoal({ title: "Archived goal" }, { commit: false });
    await manager.setArchived("goal", "G2", true, { commit: false });
    const project = await manager.read((current) => current);
    const goalsView = VIEWS.find((view) => view.id === "goals")!;

    const hidden = goalsView.render(project, theme, 100).join("\n");
    assert.match(hidden, /Visible goal/, "active work is still listed");
    assert.doesNotMatch(hidden, /Archived goal/, "archived work is out of the way by default");
    assert.match(hidden, /1 archived goal hidden · press v to show/, "the panel states what it is hiding");

    const shown = goalsView.render(project, theme, 100, { showArchived: true }).join("\n");
    assert.match(shown, /Archived goal/, "v brings it back");
    assert.match(shown, /⌫/, "and marks it as archived so it cannot be mistaken for active");
    assert.match(shown, /1 archived goal shown · press v to hide/);

    // The count line must fit every supported width.
    for (const width of [40, 80, 120]) {
      for (const line of goalsView.render(project, theme, width).join("\n").split("\n")) {
        assert.ok(visibleWidth(line) <= width, `archived note exceeds ${width}: ${JSON.stringify(line)}`);
      }
    }
  });

  test("risks and plan nodes hide archived rows the same way", async () => {
    const { root, manager } = await newProject("Views");
    dirs.push(root);
    await manager.createRisk({ title: "Live risk" }, { commit: false });
    await manager.createRisk({ title: "Dead risk" }, { commit: false });
    await manager.setArchived("risk", "R2", true, { commit: false });
    await manager.addNode({ title: "Live node" }, { commit: false });
    await manager.addNode({ title: "Dead node" }, { commit: false });
    await manager.setArchived("node", "N2", true, { commit: false });
    const project = await manager.read((current) => current);

    const risks = VIEWS.find((view) => view.id === "risks")!;
    assert.doesNotMatch(risks.render(project, theme, 100).join("\n"), /Dead risk/);
    assert.match(risks.render(project, theme, 100).join("\n"), /1 archived risk hidden/);
    assert.match(risks.render(project, theme, 100, { showArchived: true }).join("\n"), /Dead risk/);

    const plan = VIEWS.find((view) => view.id === "plan")!;
    const planHidden = plan.render(project, theme, 100).join("\n");
    assert.match(planHidden, /Live node/);
    assert.doesNotMatch(planHidden, /Dead node/, "an archived node leaves the DAG groups");
    assert.match(planHidden, /1 archived node hidden · press v to show/, "the plan view states what it is hiding");
    const planShown = plan.render(project, theme, 100, { showArchived: true }).join("\n");
    assert.match(planShown, /Dead node/);
  });

  test("archiving a node does not rewire the DAG for its dependants", async () => {
    const { root, manager } = await newProject("Dag");
    dirs.push(root);
    await manager.addNode({ title: "Parent" }, { commit: false });
    await manager.addNode({ title: "Child", dependsOn: ["N1"] }, { commit: false });
    await manager.setNodeStatus("N1", "COMPLETED", { commit: false });

    // The child is ready because its parent is done; archiving the parent hides
    // the row but must not make the child look blocked.
    await manager.setArchived("node", "N1", true, { commit: false });
    const project = await manager.read((current) => current);
    const plan = VIEWS.find((view) => view.id === "plan")!.render(project, theme, 100).join("\n");
    assert.doesNotMatch(plan, /Parent/, "the archived parent is hidden");
    assert.match(plan, /READY/, "the child is still ready");
    assert.match(plan, /Child/);
  });

  test("archiving is recorded in history with its reason", async () => {
    const { root, manager } = await newProject("History");
    dirs.push(root);
    await manager.createGoal({ title: "Old idea" }, { commit: false });
    await manager.setArchived("goal", "G1", true, { commit: false, reason: "out of scope now" });

    const events = manager.project.history.filter((event) => event.kind === "archived");
    assert.equal(events.length, 1);
    assert.match(events[0]!.summary, /Goal G1 archived: Old idea/);
    assert.match(events[0]!.summary, /out of scope now/);
    assert.deepEqual(events[0]!.refs, ["G1"]);

    await manager.setArchived("goal", "G1", false, { commit: false });
    assert.equal(manager.project.history.filter((event) => event.kind === "unarchived").length, 1);
  });
});
