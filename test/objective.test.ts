import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { buildDigest } from "../src/context.ts";
import { VIEWS, widgetLines, statusText } from "../src/dashboard.ts";
import { renderObjectiveText } from "../src/format.ts";
import { ProjectManager } from "../src/project.ts";
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

describe("the project objective", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  test("an objective is set, persists across a reload and can be cleared", async () => {
    const { root, manager } = await newProject("Objective");
    dirs.push(root);

    assert.equal(manager.project.meta.objective ?? null, null, "a new project has no objective");

    await manager.setObjective("Ship the progress bars, then publish", { commit: false });
    assert.equal(manager.project.meta.objective, "Ship the progress bars, then publish");
    assert.ok(manager.project.meta.objectiveSetAt, "the date it was set is recorded");

    await manager.refresh();
    assert.equal(manager.project.meta.objective, "Ship the progress bars, then publish", "it survives a reload");

    await manager.setObjective(null, { commit: false });
    await manager.refresh();
    assert.equal(manager.project.meta.objective ?? null, null);
    assert.equal(manager.project.meta.objectiveSetAt ?? null, null, "clearing also clears the date");
  });

  test("changing the objective is recorded in history, with the previous one", async () => {
    const { root, manager } = await newProject("History");
    dirs.push(root);

    await manager.setObjective("First", { commit: false });
    assert.equal(manager.project.history.filter((e) => e.kind === "objective.changed").length, 1);

    await manager.setObjective("Second", { commit: false, reason: "the human changed direction" });
    const events = manager.project.history.filter((e) => e.kind === "objective.changed");
    assert.equal(events.length, 2);
    assert.match(events[1]!.summary, /Objective changed to: Second/);
    assert.match(events[1]!.summary, /was: First/, "the previous objective is not lost");
    assert.match(events[1]!.summary, /the human changed direction/);

    // Setting the same value again is not an event, so history stays meaningful.
    await manager.setObjective("Second", { commit: false });
    assert.equal(manager.project.history.filter((e) => e.kind === "objective.changed").length, 2);
  });

  test("the digest leads with the objective, its progress and what done means", async () => {
    const { root, manager } = await newProject("Digest");
    dirs.push(root);
    await manager.createGoal({ title: "Ship bars", successCriteria: ["bars render", "range refused"] }, { commit: false });
    await manager.applyReplan(
      {
        trigger: "t",
        rationale: "r",
        title: "P",
        notes: [],
        superseded: [],
        carried: [],
        nodes: [
          { title: "Build it", type: "TASK", goal: "G1" },
          { title: "Test it", type: "TASK", goal: "G1" },
        ],
      },
      { commit: false },
    );
    await manager.setNodeStatus("N1", "COMPLETED", { commit: false });
    await manager.setObjective("Finish the bars and publish", { commit: false });

    const digest = buildDigest(manager.project);
    const lines = digest.split("\n");
    const projectLine = lines.findIndex((line) => line.startsWith("PROJECT:"));
    const objectiveLine = lines.findIndex((line) => line.startsWith("OBJECTIVE:"));
    const visionLine = lines.findIndex((line) => line.startsWith("VISION:"));

    assert.ok(objectiveLine > projectLine, "the objective comes after the project name");
    if (visionLine >= 0) assert.ok(objectiveLine < visionLine, "and before the vision: it is the more specific fact");
    assert.match(digest, /OBJECTIVE: Finish the bars and publish/);
    assert.match(digest, /OBJECTIVE PROGRESS: plan P1: 1\/2 nodes done/, "progress is measured, not guessed");
    assert.match(digest, /next: N2 Test it/);
    assert.match(digest, /done when G1 \(2 criteria\) satisfied/, "the finish line names the criteria");
  });

  test("a project with no objective says so instead of rendering nothing", async () => {
    const { root, manager } = await newProject("Empty");
    dirs.push(root);
    assert.doesNotMatch(buildDigest(manager.project), /OBJECTIVE/);
    const text = renderObjectiveText(manager.project);
    assert.match(text, /none set for Empty/);
    assert.match(text, /\/project objective <sentence>/, "and shows how to set one");
  });

  test("the objective text shows progress and the criteria of its goals", async () => {
    const { root, manager } = await newProject("Text");
    dirs.push(root);
    await manager.createGoal({ title: "Ship bars", successCriteria: ["bars render"] }, { commit: false });
    await manager.applyReplan(
      {
        trigger: "t",
        rationale: "r",
        title: "P",
        notes: [],
        superseded: [],
        carried: [],
        nodes: [{ title: "Build it", type: "TASK", goal: "G1" }],
      },
      { commit: false },
    );
    await manager.setObjective("Finish the bars", { commit: false });

    const text = renderObjectiveText(manager.project);
    assert.match(text, /Finish the bars/);
    assert.match(text, /## Progress/);
    assert.match(text, /plan P1 v1: 0\/1 nodes done/);
    assert.match(text, /next: N1 Build it/);
    assert.match(text, /## Done when/);
    assert.match(text, /G1 Ship bars/);
    assert.match(text, /- bars render/, "the success criteria are the finish line");

    // A project with a plan but no linked goal must not pretend to have a finish line.
    const bare = await newProject("Bare");
    dirs.push(bare.root);
    await bare.manager.applyReplan(
      { trigger: "t", rationale: "r", title: "P", notes: [], superseded: [], carried: [], nodes: [{ title: "Lonely", type: "TASK" }] },
      { commit: false },
    );
    await bare.manager.setObjective("Do the thing", { commit: false });
    assert.match(renderObjectiveText(bare.manager.project), /no active goal is linked to this work/);
  });

  test("the dashboard and widget show the objective at a glance", async () => {
    const { root, manager } = await newProject("Panels");
    dirs.push(root);
    await manager.updateDirection({ vision: "A calm project tool" }, { approved: true, commit: false });
    await manager.setObjective("Finish the bars", { commit: false });
    const project = await manager.read((current) => current);

    const dashboard = VIEWS.find((view) => view.id === "dashboard")!.render(project, theme, 80).join("\n");
    assert.match(dashboard, /◆ OBJECTIVE\s+Finish the bars/, "the objective is labelled, not left as a bare glyph");
    assert.match(dashboard, /A calm project tool/, "the vision is still shown, just after it");

    const widget = widgetLines(project, theme).join("\n");
    assert.match(widget, /Finish the bars/);

    // A long objective is truncated, never allowed to overflow the panel.
    await manager.setObjective("An extremely long objective sentence that keeps going and going well past any sensible width", { commit: false });
    const long = await manager.read((current) => current);
    for (const width of [40, 80, 120]) {
      for (const line of VIEWS.find((view) => view.id === "dashboard")!.render(long, theme, width)) {
        assert.ok(visibleWidth(line) <= width, `objective overflows ${width}: ${JSON.stringify(line)}`);
      }
      for (const line of widgetLines(long, theme)) {
        assert.ok(visibleWidth(line) <= 160, `widget objective overflows: ${JSON.stringify(line)}`);
      }
    }
  });

  test("a paused project still reports its objective, and status stays readable", async () => {
    const { root, manager } = await newProject("Paused");
    dirs.push(root);
    await manager.setObjective("Finish the bars", { commit: false });
    await manager.pauseProject("start with N1", { commit: false });
    const project = await manager.read((current) => current);

    const widget = widgetLines(project, theme).join("\n");
    assert.match(widget, /PAUSED/);
    assert.match(widget, /start with N1/);
    assert.match(statusText(project), /paused/);
  });
});
