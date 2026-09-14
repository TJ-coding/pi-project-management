import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { buildDigest } from "../src/context.ts";
import { archivedCounts, isArchived, VIEWS, viewCounts, widgetLines } from "../src/dashboard.ts";
import { progressBar, renderGoalsText } from "../src/format.ts";
import { renderCompletionSummary } from "../src/history.ts";
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

  test("an archived item is excluded from the digest and the text renderers", async () => {
    // Regression: the panels stopped counting archived goals but the digest and
    // `project_goal list` still presented them as ACTIVE GOALS, which is exactly
    // the "stops counting as active" promise G12 makes.
    const { root, manager } = await newProject("Digest");
    dirs.push(root);
    await manager.createGoal({ title: "Live goal", priority: 3 }, { commit: false });
    await manager.createGoal({ title: "Done with it", priority: 4 }, { commit: false });
    await manager.createRisk({ title: "Live risk" }, { commit: false });
    await manager.createRisk({ title: "Archived risk" }, { commit: false });
    await manager.createQuestion({ question: "Live question?", importance: 1, uncertainty: 1, decisionImpact: 1 }, { commit: false });
    await manager.createQuestion({ question: "Archived question?", importance: 1, uncertainty: 1, decisionImpact: 1 }, { commit: false });

    await manager.setArchived("goal", "G2", true, { commit: false });
    await manager.setArchived("risk", "R2", true, { commit: false });
    await manager.setArchived("question", "Q2", true, { commit: false });
    const project = await manager.read((current) => current);

    const digest = buildDigest(project);
    const activeLine = digest.split("\n").find((line) => line.startsWith("ACTIVE GOALS"))!;
    assert.match(activeLine, /Live goal/);
    assert.doesNotMatch(activeLine, /Done with it/, "an archived goal is not listed as active");
    assert.doesNotMatch(digest, /TOP RISK: R2/, "an archived risk is not the top risk");
    assert.doesNotMatch(digest, /TOP UNKNOWN: Q2/, "nor is an archived question the top unknown");

    // The list still shows it, but marked, so the record is not hidden either.
    const text = renderGoalsText(project);
    assert.match(text, /Done with it/);
    assert.match(text, /\[ARCHIVED\]/, "an archived goal is labelled where it is listed");
    assert.match(text, /1 archived \(marked/, "and the count is stated once");
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
    assert.match(hidden, /1 · 1 archived · v/, "the panel states what it is hiding in the group header");

    const shown = goalsView.render(project, theme, 100, { showArchived: true }).join("\n");
    assert.match(shown, /Archived goal/, "v brings it back");
    assert.match(shown, /archived/, "and marks it as archived so it cannot be mistaken for active");
    assert.match(shown, /showing 1 archived · v/);

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
    assert.match(risks.render(project, theme, 100).join("\n"), /1 archived · v/);
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

    const events = manager.project.history.filter((event) => event.kind === "goal.archived");
    assert.equal(events.length, 1);
    assert.match(events[0]!.kind, /goal\.archived/, "the kind is namespaced like goal.created");
    assert.match(events[0]!.summary, /Goal G1 archived: Old idea/);
    assert.match(events[0]!.summary, /out of scope now/);
    assert.deepEqual(events[0]!.refs, ["G1"]);

    await manager.setArchived("goal", "G1", false, { commit: false });
    assert.equal(manager.project.history.filter((event) => event.kind === "goal.unarchived").length, 1);
  });

  test("the summary and the dashboard footer do not present archived work as live", async () => {
    // k3's second review found the archived filter had not reached these two
    // surfaces: the summary printed an archived goal as bare ACTIVE, and the
    // footer counted it while the widget said otherwise. A test that only checked
    // the panel and the widget could not see either.
    const { root, manager } = await newProject("Surfaces");
    dirs.push(root);
    await manager.createGoal({ title: "Still live" }, { commit: false });
    await manager.createGoal({ title: "Put away" }, { commit: false });
    await manager.setArchived("goal", "G2", true, { commit: false });
    const project = await manager.read((current) => current);

    const summary = VIEWS.find((view) => view.id === "summary")!.render(project, theme, 100).join("\n");
    const row = summary.split("\n").find((line) => line.includes("Put away"))!;
    assert.ok(row, "the archived goal stays in the honest record");
    assert.match(row, /ARCHIVED/, "but it is marked archived where it is listed");
    assert.doesNotMatch(row, /ACTIVE/, "and never asserts ACTIVE, which it is not");

    const dashboard = VIEWS.find((view) => view.id === "dashboard")!.render(project, theme, 100).join("\n");
    const footer = dashboard.split("\n").find((line) => line.includes("full lists"))!;
    assert.match(footer, /2 goals \(1 archived\)/, "the footer names how many of its count are archived");
    // And that count agrees with the live metric shown further up the same view.
    assert.match(dashboard, /0\/1 done/, "the metric counts live goals only");
  });

  test("the dashboard goal metric agrees with the goals panel", async () => {
    // Regression found by reading frames: the dashboard divided by every goal in
    // the project while the goals panel counted only live ones, so the two
    // disagreed about the same number as soon as anything was archived.
    const { root, manager } = await newProject("Consistent");
    dirs.push(root);
    await manager.createGoal({ title: "Done one" }, { commit: false });
    await manager.createGoal({ title: "Still open" }, { commit: false });
    await manager.createGoal({ title: "Dropped it" }, { commit: false });
    await manager.setGoalStatus("G1", "COMPLETED", { commit: false });
    await manager.setArchived("goal", "G3", true, { commit: false });
    const project = await manager.read((current) => current);

    const dashboard = VIEWS.find((view) => view.id === "dashboard")!.render(project, theme, 100).join("\n");
    const metric = /(\d+)\/(\d+) done/.exec(dashboard);
    assert.ok(metric, "the dashboard shows a goals metric");
    const [, done, total] = metric!;

    const panelShows = project.goals.filter((goal) => !isArchived(goal)).length;
    assert.equal(Number(total), panelShows, `dashboard says ${total} goals but the panel lists ${panelShows}`);
    assert.equal(Number(done), 1, "one live goal is complete");
  });
});

describe("archived items across panels (k3 frame review)", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  test("every surface agrees on how many goals are active", async () => {
    // k3 ranked this first: the goals panel said 2 while the widget said 3 and
    // the summary called the third ACTIVE — the counts are why this tool exists,
    // and two panels disagreeing makes every number untrustworthy.
    const { root, manager } = await newProject("Agreement");
    dirs.push(root);
    await manager.createGoal({ title: "One" }, { commit: false });
    await manager.createGoal({ title: "Two" }, { commit: false });
    await manager.createGoal({ title: "Three" }, { commit: false });
    await manager.setArchived("goal", "G3", true, { commit: false });
    const project = await manager.read((current) => current);

    const live = project.goals.filter((goal) => !isArchived(goal) && goal.status === "ACTIVE").length;
    assert.equal(live, 2);

    const widget = widgetLines(project, theme).join("\n");
    assert.match(widget, new RegExp(`${live} active goals`), "the widget counts live goals");

    const dashboard = VIEWS.find((view) => view.id === "dashboard")!.render(project, theme, 100).join("\n");
    const metric = /(\d+)\/(\d+) done/.exec(dashboard);
    assert.ok(metric, "the dashboard shows a goals metric");
    assert.equal(Number(metric![2]), 2, "and divides by live goals, not every goal");

    // The digest is what an agent reads first, so it must agree too.
    assert.doesNotMatch(buildDigest(project), /ACTIVE GOALS.*Three/, "the digest does not call it active");
  });

  test("an archived goal is marked wherever it is still listed", async () => {
    const { root, manager } = await newProject("Marked");
    dirs.push(root);
    await manager.createGoal({ title: "Stowed away" }, { commit: false });
    await manager.setArchived("goal", "G1", true, { commit: false });
    const project = await manager.read((current) => current);

    // Kept in the honest record (spec 21 wants goal outcomes preserved), but
    // never presented as bare ACTIVE.
    const summary = renderCompletionSummary(project);
    assert.match(summary, /Stowed away/);
    assert.match(summary, /\[ARCHIVED\]/, "the completion summary marks it");
    assert.match(renderGoalsText(project), /\[ARCHIVED\]/, "so does the goals list");

    // The rows view uses the word, not a glyph: the delete key is `D`, so a
    // backspace glyph would read as "marked for deletion" (k3 issue 5).
    const shown = VIEWS.find((view) => view.id === "goals")!.render(project, theme, 100, { showArchived: true }).join("\n");
    assert.match(shown, /archived/);
    assert.doesNotMatch(shown, /⌫/, "no delete-looking glyph on an archived row");
  });

  test("a 100% goal that is still open is marked in words, not with the done glyph", async () => {
    // k3, round 3: the plan panel uses ✓ for a *done* node, so reusing that glyph
    // on an open goal taught "✓100% = done" while the counter said 0/2. The word
    // carries the meaning now and ✓ stays a completion mark.
    const { root, manager } = await newProject("Hundred");
    dirs.push(root);
    await manager.createGoal({ title: "Work finished", percent: 100 }, { commit: false });
    await manager.createGoal({ title: "Not started" }, { commit: false });
    const project = await manager.read((current) => current);

    const goals = VIEWS.find((view) => view.id === "goals")!.render(project, theme, 100).join("\n");
    assert.match(goals, /100% finished\?/, "the open 100% goal says so in words");
    assert.doesNotMatch(goals, /✓/, "and does not borrow the completion glyph");
    const dashboard = VIEWS.find((view) => view.id === "dashboard")!.render(project, theme, 100).join("\n");
    assert.match(dashboard, /0\/2 done/, "the counter still says the goal is not closed");

    // A genuinely closed 100% goal needs no hedge.
    await manager.setGoalStatus("G1", "COMPLETED", { commit: false });
    const closed = VIEWS.find((view) => view.id === "goals")!.render(await manager.read((c) => c), theme, 100).join("\n");
    assert.doesNotMatch(closed, /finished\?/, "a closed goal carries no question mark");
  });

  test("progress bars use one vocabulary and one width everywhere", () => {
    // k3 issue 4: ▰▱ at 6 cells in one pane and █░ elsewhere meant re-learning
    // the bar per panel, and a 6-cell bar rounded 60% up to 67%.
    assert.equal(progressBar(60), "██████░░░░ 60%");
    assert.ok(!progressBar(60).includes("▰"), "no second bar vocabulary");
    assert.equal(progressBar(60).split(" ")[0]!.length, 10, "one width");
  });

  test("an archived node keeps a stable percent column in the plan rows", async () => {
    // k3 issue 7: `60% G2` crowded two tokens and unestimated rows shifted the
    // goal column left, so the percent needed its own fixed slot.
    const { root, manager } = await newProject("Columns");
    dirs.push(root);
    await manager.applyReplan(
      {
        trigger: "t",
        rationale: "r",
        title: "P",
        notes: [],
        superseded: [],
        carried: [],
        nodes: [
          { title: "Estimated node", type: "TASK", goal: "G1", percent: 65 },
          { title: "Unestimated node", type: "TASK", goal: "G1" },
        ],
      },
      { commit: false },
    );
    await manager.createGoal({ title: "Shared goal" }, { commit: false });
    const project = await manager.read((current) => current);
    const lines = VIEWS.find((view) => view.id === "plan")!.render(project, theme, 100);
    const estimated = lines.find((line) => line.includes("Estimated node"))!;
    const unestimated = lines.find((line) => line.includes("Unestimated node"))!;

    // The goal badge must sit in the same column whether or not there is a percent.
    const columnOf = (line: string): number => line.indexOf("G1");
    assert.equal(columnOf(estimated), columnOf(unestimated), "the link column does not shift");
    assert.match(estimated, /65% G1/, "the percent is separated from the link by a space");
    assert.doesNotMatch(estimated, /65%G1/, "and never runs into it");
  });
});
