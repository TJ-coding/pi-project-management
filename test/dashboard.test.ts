import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ProjectBrowser, VIEWS, statusText, widgetLines } from "../src/dashboard.ts";
import { ProjectManager } from "../src/project.ts";
import { viewFallbacks } from "../src/commands.ts";
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
    assert.match(text, /Dashboard Demo/);
    assert.match(text, /Build an autonomous research environment\./);
    assert.match(text, /Build prototype/);
    assert.match(text, /Prototype operational/);
    assert.match(text, /Evaluation reliability/);
    assert.match(text, /Does evaluator correlate with humans\?/);
    assert.match(text, /Human comparison|Investigate/);
  });

  test("plan view renders the DAG with dependencies and statuses", async () => {
    const { root, manager } = await richProject();
    dirs.push(root);
    const project = await manager.read((current) => current);
    const text = VIEWS.find((view) => view.id === "plan")!.render(project, theme, 120).join("\n");
    assert.match(text, /P1 v1/);
    assert.match(text, /N1 /);
    assert.match(text, /RUNNING/);
    assert.match(text, /after /);
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

    const scrolling = new ProjectBrowser({ project, theme, onClose: () => undefined, initialView: "history" });
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

  test("commands expose a text fallback for every view", () => {
    const fallbacks = new Set(viewFallbacks());
    for (const view of VIEWS) assert.ok(fallbacks.has(view.id), `no fallback for ${view.id}`);
    assert.ok(fallbacks.has("evolution"));
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
