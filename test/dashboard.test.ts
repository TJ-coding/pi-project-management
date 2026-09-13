import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  ProjectBrowser,
  VIEWS,
  flatPlanNodes,
  orderedGoalIds,
  planGroups,
  renderPlanInteractive,
  statusText,
  widgetLines,
} from "../src/dashboard.ts";
import { ProjectManager } from "../src/project.ts";
import {
  PROJECT_SUBCOMMANDS,
  SUBCOMMAND_INFO,
  projectTools,
  renderHelp,
  renderSubcommandHelp,
  viewFallbacks,
} from "../src/commands.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderReplanAnalysis, renderReviewReport } from "../src/reports.ts";
import { cleanup, fixedClock, tempDir } from "./helpers.ts";

/** Minimal theme stub: identity styling, so we can assert on plain text. */
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

async function richProject() {
  const root = await tempDir();
  const clock = fixedClock();
  const manager = await ProjectManager.init(root, { name: "Dashboard Demo", clock, by: "test" });
  await manager.updateDirection(
    { vision: "Build an autonomous research environment.", intent: "Reduce manual experimentation." },
    { approved: true, commit: false },
  );
  await manager.createGoal({ title: "Build prototype", priority: 5, successCriteria: ["prototype runs"] }, { commit: false });
  await manager.createGoal({ title: "Demonstrate output", priority: 3 }, { commit: false });
  await manager.setGoalStatus("G1", "COMPLETED", { commit: false });
  await manager.updateState(
    { current: "Prototype operational; evaluator remains uncertain.", capabilities: ["cli"], problems: ["evaluator drift"] },
    { commit: false },
  );
  const risk = await manager.createRisk(
    { title: "Evaluation reliability", probability: 0.4, impact: 0.9, mitigation: "human comparison" },
    { commit: false },
  );
  await manager.createRisk({ title: "Compute cost", probability: 0.5, impact: 0.5 }, { commit: false });
  const question = await manager.createQuestion(
    {
      question: "Does evaluator correlate with humans?",
      importance: 1,
      uncertainty: 1,
      decisionImpact: 0.9,
      risks: [risk.id],
    },
    { commit: false },
  );
  await manager.createQuestion({ question: "Can the loop converge reliably?", importance: 0.8, uncertainty: 0.9, decisionImpact: 0.7 }, { commit: false });
  await manager.answerQuestion(question.id, { answer: "Correlation looks promising at 0.7", status: "PARTIAL", confidence: 0.5 }, { commit: false });
  await manager.setStrategy({ approach: "Focus on autonomous experimentation.", hypotheses: ["better evaluator -> better loop"] }, { commit: false });
  await manager.applyReplan(manager.analyzeReplan({ trigger: "kickoff" }), { commit: false });
  await manager.setNodeStatus("N1", "RUNNING", { commit: false });
  await manager.recordDecision(
    { title: "Use local benchmark", decision: "Start with a local benchmark.", rationale: "cheaper", authority: "SIGNIFICANT" },
    { commit: false },
  );
  const run = await manager.startRun({ title: "Human comparison", node: "N1", environment: [{ kind: "ssh", target: "gpu-box" }] }, { commit: false });
  await manager.logRun(run.id, [{ kind: "progress", text: "50 annotations collected" }], { commit: false });
  return { root, manager };
}

describe("dashboard", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  test("every view renders within the width and without crashing", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const project = await manager.read((current) => current);

    for (const view of VIEWS) {
      for (const width of [40, 80, 120]) {
        const lines = view.render(project, theme, width);
        assert.ok(lines.length > 0, `${view.id} rendered nothing at width ${width}`);
        for (const line of lines) {
          assert.ok(
            visibleWidth(line) <= width,
            `${view.id} line exceeds width ${width}: ${JSON.stringify(line)} (${visibleWidth(line)})`,
          );
        }
      }
    }
  });

  test("dashboard shows the core project facts", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const project = await manager.read((current) => current);
    const text = VIEWS.find((view) => view.id === "dashboard")!.render(project, theme, 120).join("\n");
    // Hierarchy: quiet vision, one focal NEXT block, then aligned numbers/signals.
    assert.match(text, /Build an autonomous research environment\./);
    assert.match(text, /┏━ NOW/);
    assert.match(text, /N\d/);
    assert.doesNotMatch(text, /▌ VISION/, "vision is quiet context, not a competing header");
    assert.match(text, /┏━ PROGRESS/);
    assert.match(text, /┏━ SIGNALS/);
    assert.match(text, /open questions/);
    assert.match(text, /Demonstrate output/);
    assert.doesNotMatch(text, /Build prototype/, "completed goals stay out of the dashboard");
  });

  test("plan view groups nodes and shows a selected-node detail pane", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const project = await manager.read((current) => current);
    const rendered = renderPlanInteractive(project, theme, 120, "N1");
    const text = rendered.lines.join("\n");
    assert.match(text, /P1 v1/);
    assert.match(text, /RUNNING/);
    assert.match(text, /READY|BLOCKED|FINISHED/);
    assert.match(text, /N1/);
    assert.match(text, /┏━ SELECTED/);
    assert.match(text, /N1 · /);
    assert.match(text, /after |no dependencies/);
    assert.ok(rendered.ids.includes("N1"));
    assert.ok(rendered.lines.length < 40, "plan view should stay scannable");

    // Grouping matches the DAG helpers.
    const groups = planGroups(project);
    assert.ok(groups.some((group) => group.key === "running" && group.nodes.some((node) => node.id === "N1")));
    assert.deepEqual(flatPlanNodes(project).map((node) => node.id), rendered.ids);
  });

  test("plan browser moves the cursor and emits edit/new/delete actions", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const project = await manager.read((current) => current);
    const actions: Array<{ kind: string; id?: string }> = [];
    const browser = new ProjectBrowser({
      project,
      theme,
      onClose: () => undefined,
      initialView: "plan",
      getTerminalRows: () => 30,
      onPlanAction: (action) => actions.push(action),
    });

    const ids = flatPlanNodes(project).map((node) => node.id);
    assert.ok(ids.length > 0);
    assert.match(browser.render(120).join("\n"), new RegExp(`┏━ SELECTED.*${ids[0]}`));
    if (ids.length > 1) {
      browser.handleInput("j");
      assert.match(browser.render(120).join("\n"), new RegExp(`┏━ SELECTED.*${ids[1]}`));
      browser.handleInput("k");
    }
    browser.handleInput("e");
    assert.deepEqual(actions.at(-1), { kind: "edit", id: ids[0] });
    browser.handleInput("a");
    assert.deepEqual(actions.at(-1), { kind: "new" });
    browser.handleInput("D");
    assert.deepEqual(actions.at(-1), { kind: "delete", id: ids[0] });

    // Enter reads the selected node in full (criteria and outputs are clipped in
    // the one-line list); `e` is the editor.
    browser.handleInput("\r");
    const pane = browser.render(120).join("\n");
    assert.match(pane, /READING/);
    assert.match(pane, /esc back to the list/);
    assert.match(pane, /KIND/);
    browser.handleInput("\x1b");
    assert.match(browser.render(120).join("\n"), /enter read in full · e edit/);

    for (const width of [60, 100, 140]) {
      for (const line of browser.render(width)) {
        assert.ok(visibleWidth(line) <= width, `plan line exceeds ${width}: ${JSON.stringify(line)}`);
      }
    }
  });

  test("browser switches views, scrolls and closes", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const project = await manager.read((current) => current);
    let closed = 0;
    const browser = new ProjectBrowser({ project, theme, onClose: () => (closed += 1) });

    assert.equal(browser.currentView, "dashboard");
    browser.handleInput("\t");
    assert.equal(browser.currentView, "direction");
    browser.handleInput("8");
    assert.equal(browser.currentView, "plan");
    browser.handleInput("h");
    assert.equal(browser.currentView, "strategy");
    browser.handleInput("q");
    assert.equal(closed, 1);

    const scrolling = new ProjectBrowser({
      project,
      theme,
      onClose: () => undefined,
      initialView: "history",
      getTerminalRows: () => 12,
    });
    const before = scrolling.render(80);
    scrolling.handleInput("j");
    scrolling.handleInput("j");
    const after = scrolling.render(80);
    assert.equal(before.length, after.length);
    assert.notDeepEqual(before, after, "history view should scroll");

    for (const width of [30, 60, 100]) {
      for (const line of scrolling.render(width)) {
        assert.ok(visibleWidth(line) <= width, `browser line exceeds width ${width}`);
      }
    }
  });

  test("widget and footer status summarise progress", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const project = await manager.read((current) => current);
    const widget = widgetLines(project, theme).join("\n");
    assert.match(widget, /Dashboard Demo/);
    assert.match(widget, /active goals/);
    assert.match(widget, /P1 v1/);
    const status = statusText(project);
    assert.match(status, /Dashboard Demo: /);
    assert.match(status, /ready/);
  });

  test("chrome stays one line per row and never clips the dock", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const project = await manager.read((current) => current);
    for (const [rows, width] of [[30, 100], [30, 80], [12, 60], [50, 140]] as const) {
      const browser = new ProjectBrowser({ project, theme, onClose: () => undefined, getTerminalRows: () => rows });
      for (const view of VIEWS) {
        const rendered = browser.render(width);
        // title + tabs + at most (rows - 3 - 4) body + 2 footer lines
        assert.ok(rendered.length <= rows - 3, `${view.id} renders ${rendered.length} lines for ${rows} rows`);
        for (const line of rendered) {
          assert.ok(visibleWidth(line) <= width, `${view.id} line exceeds ${width}: ${JSON.stringify(line)}`);
        }
        browser.handleInput("\t");
      }
    }
  });

  test("headings fit exactly and never wrap into stray rules", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const project = await manager.read((current) => current);
    for (const width of [60, 80, 100, 132]) {
      const lines = VIEWS.find((view) => view.id === "dashboard")!.render(project, theme, width);
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width);
        assert.doesNotMatch(line, /^─+$/, `stray separator line at width ${width}: ${JSON.stringify(line)}`);
      }
      assert.ok(lines.some((line) => line.includes("PROGRESS")) || lines.some((line) => line.includes("SIGNALS")));
    }
  });

  test("footer reports scroll position and tells you when nothing more can scroll", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const project = await manager.read((current) => current);

    // Prose views scroll with j/k and report the visible window.
    const long = new ProjectBrowser({ project, theme, onClose: () => undefined, initialView: "state", getTerminalRows: () => 10 });
    const first = long.render(100).join("\n");
    assert.match(first, /1-\d+\/\d+ lines/);
    assert.match(first, /j\/k/);
    long.handleInput("j");
    const scrolled = long.render(100).join("\n");
    assert.match(scrolled, /2-\d+\/\d+ lines/);

    // Row views spend j/k on the selection, so the list window does not move.
    const rows = new ProjectBrowser({ project, theme, onClose: () => undefined, initialView: "risks", getTerminalRows: () => 10 });
    assert.match(rows.render(100).join("\n"), /↑↓ select/);
    rows.handleInput("j");
    assert.match(rows.render(100).join("\n"), /1-\d+\/\d+ lines/);

    // A view that fits reports no scrolling without any stale hint.
    const empty = new ProjectBrowser({ project, theme, onClose: () => undefined, initialView: "strategy", getTerminalRows: () => 30 });
    const emptyText = empty.render(100).join("\n");
    assert.match(emptyText, /all \d+ lines/);
  });

  test("enter opens a reading pane with the selected row's full text", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const longText = "Long explanation that would be truncated in a one-line row. ".repeat(4).trim();
    await manager.createGoal(
      { title: "Document the long goal", description: longText, priority: 4, successCriteria: ["criterion one", "criterion two"] },
      { commit: false },
    );
    const project = await manager.read((current) => current);
    const browser = new ProjectBrowser({ project, theme, onClose: () => undefined, initialView: "goals", getTerminalRows: () => 40 });

    // The list is scannable: the description is nowhere in it.
    const list = browser.render(100).join("\n");
    assert.match(list, /↑↓ select · enter read in full/);
    assert.doesNotMatch(list, /Long explanation/);

    browser.handleInput("\r");
    const reading = browser.render(100).join("\n");
    assert.match(reading, /READING/);
    assert.match(reading, /esc back to the list/);
    assert.match(reading, /SUCCESS CRITERIA \(2\)/);
    assert.match(reading, /criterion one/);
    assert.ok(reading.replace(/\s+/g, " ").includes(longText), "the reading pane shows the untruncated description");

    // A short terminal scrolls the pane instead of clipping it.
    const clipped = new ProjectBrowser({ project, theme, onClose: () => undefined, initialView: "goals", getTerminalRows: () => 12 });
    clipped.handleInput("\r");
    const window = clipped.render(100).join("\n");
    assert.match(window, /1-\d+\/\d+ lines/);
    assert.doesNotMatch(window, /criterion one/, "criteria start below the fold until you scroll");
    clipped.handleInput("\x1b");
    assert.match(clipped.render(100).join("\n"), /↑↓ select · enter read in full/, "escape returns to the list");

    // Narrow terminals wrap instead of clipping, on the list and in the pane.
    for (const width of [40, 80]) {
      for (const line of browser.render(width)) {
        assert.ok(visibleWidth(line) <= width, `reading pane exceeds width ${width}: ${JSON.stringify(line)}`);
      }
    }

    // Escape goes back to the list, and ↑↓ picks which row enter opens.
    browser.handleInput("\x1b");
    assert.match(browser.render(100).join("\n"), /↑↓ select · enter read in full/);
    const ids = orderedGoalIds(project);
    assert.ok(ids.length >= 2);
    browser.handleInput("j");
    browser.handleInput("\r");
    const second = browser.render(100).join("\n");
    assert.match(second, /Demonstrate output/);
    assert.match(second, new RegExp(ids[1]!));
  });

  test("prose views open their uncapped text instead of the abbreviated list", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const project = await manager.read((current) => current);
    const browser = new ProjectBrowser({ project, theme, onClose: () => undefined, initialView: "state", getTerminalRows: () => 40 });
    assert.match(browser.render(100).join("\n"), /enter read every list in full/);
    browser.handleInput("\r");
    const text = browser.render(100).join("\n");
    assert.match(text, /State — full text/);
    assert.match(text, /PROBLEMS/);
    assert.match(text, /CAPABILITIES/);
    assert.match(text, /evaluator drift/);
  });

  test("e asks to edit editable views only, and the footer advertises it", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const project = await manager.read((current) => current);
    const requested: string[] = [];
    const browser = new ProjectBrowser({
      project,
      theme,
      onClose: () => undefined,
      getTerminalRows: () => 30,
      editableViews: ["goals", "risks", "plan"],
      onRequestEdit: (view) => requested.push(view),
    });

    // Dashboard is not editable.
    assert.doesNotMatch(browser.render(100).join("\n"), /e edit/);
    browser.handleInput("e");
    assert.deepEqual(requested, []);

    browser.handleInput("3"); // Goals
    assert.equal(browser.currentView, "goals");
    assert.match(browser.render(100).join("\n"), /e edit/);
    browser.handleInput("e");
    assert.deepEqual(requested, ["goals"]);

    browser.handleInput("6"); // Risks
    browser.handleInput("e");
    assert.deepEqual(requested, ["goals", "risks"]);
  });

  test("commands expose a text fallback for every view", () => {
    const fallbacks = new Set(viewFallbacks());
    for (const view of VIEWS) assert.ok(fallbacks.has(view.id), `no fallback for ${view.id}`);
    assert.ok(fallbacks.has("evolution"));
  });

  test("help lists every subcommand and explains how to add work", () => {
    const help = renderHelp();
    for (const sub of PROJECT_SUBCOMMANDS) {
      assert.match(help, new RegExp(`\\/project[^\\n]*\\b${sub}\\b`), `help does not document ${sub}`);
      assert.ok(SUBCOMMAND_INFO[sub].summary.length > 5, `${sub} has no summary`);
    }
    assert.match(help, /Changing work directly: \/project edit <section>/);
    assert.match(help, /work is added by talking to the agent/);
    assert.match(help, /project_goal/);
    assert.match(help, /project_replan/);
    assert.match(help, /Dashboard keys/);
  });

  test("help shows the registered agent tools and per-subcommand details", () => {
    const fakeApi = {
      getActiveTools: () => ["read", "project_goal"],
      getAllTools: () => [
        { name: "read", description: "Read files" },
        { name: "project_goal", description: "Create and update goals.\nMore detail here." },
        { name: "project_replan", description: "Adaptive replanning." },
      ],
    } as unknown as ExtensionAPI;

    const tools = projectTools(fakeApi);
    assert.deepEqual(tools.map((tool) => tool.name), ["project_goal", "project_replan"]);
    assert.equal(tools[0]!.active, true);
    assert.equal(tools[1]!.active, false);
    assert.equal(tools[0]!.description, "Create and update goals.");

    const help = renderHelp(fakeApi);
    assert.match(help, /Agent tools \(2\)/);
    assert.match(help, /project_goal, project_replan/);

    const detail = renderSubcommandHelp("replan");
    assert.match(detail, /Usage: \/project replan \[apply\]/);
    assert.match(detail, /smallest useful plan/);
    assert.match(renderSubcommandHelp("/yolo"), /Usage: \/project yolo/);
    assert.match(renderSubcommandHelp("nope"), /Unknown subcommand/);
  });

  test("the dashboard has in-place help on ?", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const project = await manager.read((current) => current);

    // Tall terminal: the whole reference fits, including how to add work.
    const tall = new ProjectBrowser({
      project,
      theme,
      onClose: () => undefined,
      getTerminalRows: () => 70,
      helpText: renderHelp(),
    });
    const normal = tall.render(100).join("\n");
    assert.doesNotMatch(normal, /Changing work directly/);
    assert.match(normal, /\? help/);

    tall.handleInput("?");
    const help = tall.render(100).join("\n");
    assert.match(help, /Project commands/);
    assert.match(help, /Changing work directly/);
    assert.match(help, /project_replan/);
    assert.match(help, /esc close help/);
    tall.handleInput("\x1b");
    assert.doesNotMatch(tall.render(100).join("\n"), /Changing work directly/);

    // Short terminal: help scrolls, and ? toggles it back off.
    const short = new ProjectBrowser({
      project,
      theme,
      onClose: () => undefined,
      getTerminalRows: () => 10,
      helpText: renderHelp(),
    });
    short.handleInput("?");
    const before = short.render(100).join("\n");
    assert.match(before, /Project commands/);
    short.handleInput("j");
    assert.notEqual(short.render(100).join("\n"), before);
    short.handleInput("?");
    assert.doesNotMatch(short.render(100).join("\n"), /Project commands/);
  });
});

describe("reports", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  test("replan analysis includes all twelve spec-25 inputs", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const proposal = manager.analyzeReplan({ trigger: "new evidence", evidence: ["benchmark failed"] });
    const text = manager.project ? renderReplanAnalysis(manager.project, proposal) : "";
    for (const heading of [
      "1-4. Direction",
      "5. Goals",
      "6. Current state",
      "7. Highest priority intelligence",
      "8. Highest priority risks",
      "9. Previous work",
      "10. Strategy",
      "11. Current plan",
      "12. New evidence",
      "Proposed smallest useful plan",
    ]) {
      assert.match(text, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(text, /benchmark failed/);
  });

  test("review report checks direction, readiness, validation and outcome", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const text = renderReviewReport(manager.project);
    assert.match(text, /Consistency with direction/);
    assert.match(text, /Most important unknowns/);
    assert.match(text, /Top risks/);
    assert.match(text, /Plan readiness/);
    assert.match(text, /Validation/);
    assert.match(text, /Gate outcomes/);
    assert.match(text, /Suggested outcome/);
  });
});

describe("visual hierarchy", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  /** Records which emphasis a renderer actually used. */
  function recordingTheme() {
    const used = { bold: [] as string[], bg: [] as Array<{ color: string; text: string }> };
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (color: string, text: string) => {
        used.bg.push({ color, text });
        return text;
      },
      bold: (text: string) => {
        used.bold.push(text);
        return text;
      },
      italic: (text: string) => text,
      strikethrough: (text: string) => text,
    } as unknown as Theme;
    return { theme, used };
  }

  test("the dashboard has exactly one focal panel and limited bold", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const project = await manager.read((current) => current);
    const { theme: recording, used } = recordingTheme();
    VIEWS.find((view) => view.id === "dashboard")!.render(project, recording, 120);

    // The dashboard has no selection: it is a read view.
    assert.equal(used.bg.filter((entry) => entry.color === "selectedBg").length, 0, "the dashboard has no selection");

    // Bold is reserved for the one thing to act on plus the section titles.
    assert.ok(used.bold.length <= 8, `too many bold fragments (${used.bold.length}): ${used.bold.join(" | ")}`);
    assert.ok(
      used.bold.some((text) => /N\d/.test(text)),
      `the focal node title should be bold, got: ${used.bold.join(" | ")}`,
    );
  });

  test("the plan browser highlights exactly one row and keeps the rest quiet", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const project = await manager.read((current) => current);
    const { theme: recording, used } = recordingTheme();
    const browser = new ProjectBrowser({ project, theme: recording, onClose: () => undefined, initialView: "plan", getTerminalRows: () => 40 });
    browser.render(120);
    const selected = used.bg.filter((entry) => entry.color === "selectedBg");
    assert.equal(selected.length, 1, `exactly one row may be selected, got ${selected.length}`);
    assert.match(selected[0]!.text, /N\d/);
  });

  test("containers group information and every row is visibly contained", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const project = await manager.read((current) => current);
    const plan = VIEWS.find((view) => view.id === "plan")!.render(project, theme, 120);
    const text = plan.join("\n");
    assert.match(text, /┏━ READY/);
    assert.match(text, /┏━ SELECTED/);
    assert.match(text, /┗━/);

    // Every body line between a header and its close must carry the container
    // spine, so there is no ambiguity about what belongs to what.
    const header = plan.findIndex((line) => line.includes("┏━ READY"));
    const close = plan.findIndex((line, index) => index > header && line.includes("┗━"));
    assert.ok(header >= 0 && close > header, "READY container not found");
    const body = plan.slice(header + 1, close);
    assert.ok(body.length >= 2, "container should hold its rows");
    assert.ok(
      body.some((line) => /┃/.test(line)),
      "container body should carry the spine",
    );
    const nextHeader = plan.findIndex((line, index) => index > header && line.includes("┏━"));
    if (nextHeader > header) {
      assert.ok(nextHeader > close, "a new container must not start before the previous one closes");
    }

    // Tabs keep their names whenever there is room.
    const browser = new ProjectBrowser({ project, theme, onClose: () => undefined, getTerminalRows: () => 30 });
    const wide = browser.render(170).join("\n");
    assert.match(wide, /1:Dashboard/);
    assert.match(wide, /6:Risks/);
    const narrow = browser.render(70).join("\n");
    assert.match(narrow, /6\(\d+\)/);
    assert.match(narrow, /Dashboard/, "the active tab keeps its name on narrow terminals");
  });
});

describe("containers", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  test("every opened container is closed, in order", async () => {
    const root = await tempDir();
    dirs.push(root);
    const manager = await ProjectManager.init(root, { name: "Containers", clock: fixedClock(), by: "test" });
    await manager.updateDirection({ vision: "V", values: ["Simple"] }, { approved: true, commit: false });
    await manager.updateState({ current: "C", capabilities: ["a"], problems: ["p"] }, { commit: false });
    await manager.createGoal({ title: "G", priority: 3 }, { commit: false });
    await manager.createQuestion({ question: "Q?", importance: 1, uncertainty: 1, decisionImpact: 1 }, { commit: false });
    await manager.createRisk({ title: "R", probability: 0.5, impact: 0.5 }, { commit: false });
    await manager.setStrategy({ approach: "A" }, { commit: false });
    await manager.applyReplan(manager.analyzeReplan({ trigger: "t" }), { commit: false });
    const project = await manager.read((current) => current);

    for (const view of VIEWS) {
      const lines = view.render(project, { ...theme, fg: (_c: string, t: string) => t } as Theme, 110);
      let open = 0;
      for (const line of lines) {
        if (line.includes("┏━")) open += 1;
        if (line.includes("┗━")) {
          open -= 1;
          assert.ok(open >= 0, `${view.id}: close without an open container: ${JSON.stringify(line)}`);
        }
      }
      assert.equal(open, 0, `${view.id}: ${open} unclosed container(s)`);
    }
  });
});
