import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { esc, gatherWorkspace, renderPhonePage, renderPhoneText, startPhoneServer, summarise } from "../src/phone.ts";
import { ProjectManager } from "../src/project.ts";
import { cleanup, fixedClock, tempDir } from "./helpers.ts";
import type { WorkspaceEntry } from "../src/storage.ts";

/** A workspace of two projects with something waiting on a human in each. */
async function twoProjects(): Promise<{ dirs: string[]; entries: WorkspaceEntry[] }> {
  const dirs: string[] = [];
  const entries: WorkspaceEntry[] = [];

  const a = await tempDir();
  dirs.push(a);
  const managerA = await ProjectManager.init(a, { name: "Alpha", clock: fixedClock(), by: "test" });
  await managerA.createGoal({ title: "Looks finished", successCriteria: ["x"] }, { commit: false });
  await managerA.applyReplan(
    {
      trigger: "t",
      rationale: "r",
      title: "P",
      notes: [],
      superseded: [],
      carried: [],
      nodes: [
        { title: "Ship it", type: "TASK", goal: "G1" },
        { title: "You decide this", type: "TASK", assignee: "human" },
      ],
    },
    { commit: false },
  );
  await managerA.setNodeStatus("N1", "COMPLETED", { commit: false });
  await managerA.setObjective("Finish alpha", { commit: false });
  entries.push({ name: "Alpha", path: a });

  const b = await tempDir();
  dirs.push(b);
  const managerB = await ProjectManager.init(b, { name: "Beta", clock: fixedClock(), by: "test" });
  await managerB.createQuestion({ question: "Which storage backend?", importance: 1, uncertainty: 1, decisionImpact: 0.9 }, { commit: false });
  await managerB.pauseProject("decide the backend", { commit: false });
  entries.push({ name: "Beta", path: b });

  return { dirs, entries };
}

describe("phone view", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await cleanup(dir);
  });

  test("every project is listed with its state and what it is doing", async () => {
    const { dirs: made, entries } = await twoProjects();
    dirs.push(...made);
    const data = await gatherWorkspace(entries);

    assert.equal(data.projects.length, 2);
    const alpha = data.projects.find((project) => project.name === "Alpha")!;
    const beta = data.projects.find((project) => project.name === "Beta")!;

    assert.equal(alpha.state, "IDLE", "alpha has no running node");
    assert.equal(alpha.objective, "Finish alpha");
    assert.match(alpha.currentTask ?? "", /N2 You decide this/, "it says what comes next");
    assert.deepEqual(alpha.plan, { id: "P1", done: 1, total: 2, ready: 1 });

    assert.equal(beta.state, "PAUSED", "a paused project says so");
    assert.equal(beta.openQuestions, 1);
  });

  test("running work outranks idle work, so the active project is first", async () => {
    const { dirs: made, entries } = await twoProjects();
    dirs.push(...made);
    const running = entries[0]!.path;
    const manager = (await ProjectManager.discover(running))!;
    await manager.setNodeStatus("N2", "RUNNING", { commit: false });

    const data = await gatherWorkspace(entries);
    assert.equal(data.projects[0]!.name, "Alpha", "the project with work in flight leads");
    assert.equal(data.projects[0]!.state, "RUNNING");
  });

  test("decisions from different projects are aggregated into one list", async () => {
    const { dirs: made, entries } = await twoProjects();
    dirs.push(...made);
    const data = await gatherWorkspace(entries);

    // Alpha: a human-assigned node and a goal whose work is all done.
    // Beta: a high-impact open question.
    const kinds = new Set(data.pending.map((item) => item.kind));
    assert.ok(kinds.has("approval"), "the human-assigned task is a pending decision");
    assert.ok(kinds.has("goal"), "the apparently-finished goal is a pending decision");
    assert.ok(kinds.has("question"), "the high-impact question is a pending decision");

    const projects = new Set(data.pending.map((item) => item.project));
    assert.equal(projects.size, 2, "decisions come from both projects, not just the current one");
    for (const item of data.pending) {
      assert.ok(item.choices.length >= 2, `${item.id} offers choices to pick from`);
      assert.ok(item.projectPath, `${item.id} says which project it belongs to`);
    }
  });

  test("a completed gate and a low-impact question are not nagged about", async () => {
    const root = await tempDir();
    dirs.push(root);
    const manager = await ProjectManager.init(root, { name: "Quiet", clock: fixedClock(), by: "test" });
    await manager.applyReplan(
      {
        trigger: "t",
        rationale: "r",
        title: "P",
        notes: [],
        superseded: [],
        carried: [],
        nodes: [{ title: "Done gate", type: "GATE", gate: { type: "REVIEW", criteria: "ok" } }],
      },
      { commit: false },
    );
    await manager.setNodeStatus("N1", "COMPLETED", { commit: false });
    await manager.createQuestion({ question: "Minor curiosity?", importance: 0.2, uncertainty: 0.2, decisionImpact: 0.2 }, { commit: false });

    const data = await gatherWorkspace([{ name: "Quiet", path: root }]);
    assert.equal(data.pending.length, 0, "only real decisions are surfaced");
  });

  test("a project whose directory is gone is reported, not crashed on", async () => {
    const data = await gatherWorkspace([{ name: "Vanished", path: "/tmp/pi-pm-does-not-exist-xyz" }]);
    assert.equal(data.projects.length, 1);
    assert.equal(data.projects[0]!.state, "MISSING");
    assert.equal(data.projects[0]!.exists, false);
    const page = renderPhonePage(data);
    assert.match(page, /Vanished/);
    assert.match(page, /not found/);
  });

  test("the page shows state, the current task and the choices", async () => {
    const { dirs: made, entries } = await twoProjects();
    dirs.push(...made);
    const data = await gatherWorkspace(entries);
    const page = renderPhonePage(data);

    assert.match(page, /<title>Projects — \d+ waiting<\/title>/);
    assert.match(page, /Waiting on you \(3\)/);
    assert.match(page, /Alpha/);
    assert.match(page, /Beta/);
    assert.match(page, /Finish alpha/);
    assert.match(page, /You decide this/);
    assert.match(page, /mark complete/, "the choices are rendered");
    assert.match(page, /width=device-width/, "it is usable on a phone");
    assert.match(page, /Read-only/, "the read-only promise is stated on the page");
  });

  test("page text is escaped, so a project cannot inject markup", async () => {
    assert.equal(esc('<script>alert("x")</script> & more'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more");

    const root = await tempDir();
    dirs.push(root);
    const manager = await ProjectManager.init(root, { name: "Sneaky", clock: fixedClock(), by: "test" });
    // Both the objective and the current task are rendered, so both are the
    // places an injection would have to land.
    await manager.createGoal({ title: "Hostile goal", successCriteria: ["x"] }, { commit: false });
    await manager.applyReplan(
      {
        trigger: "t",
        rationale: "r",
        title: "P",
        notes: [],
        superseded: [],
        carried: [],
        nodes: [{ title: "<img src=x onerror=alert(1)>next task", type: "TASK" }],
      },
      { commit: false },
    );
    await manager.setObjective("<script>alert('objective')</script>", { commit: false });
    const data = await gatherWorkspace([{ name: "Sneaky", path: root }]);
    const page = renderPhonePage(data);
    assert.doesNotMatch(page, /<script>alert/, "a script tag in project text never reaches the page raw");
    assert.doesNotMatch(page, /<img src=x/, "nor an image tag with a handler");
    // The text "onerror=" may appear inside escaped content, which is inert; what
    // must not exist is a live handler attribute inside a real tag. Match only a
    // handler name at an attribute boundary, so content="..." is not caught.
    for (const tag of page.match(/<[a-z][^>]*>/gi) ?? []) {
      assert.doesNotMatch(tag, /\s(on(?:error|load|click|mouse\w+|focus|blur|change|input|submit))\s*=/i, `a real tag carries an event handler: ${tag}`);
    }
    assert.match(page, /&lt;script&gt;alert/, "the objective is shown as text instead");
    assert.match(page, /&lt;img src=x onerror=alert\(1\)/, "and so is the task title");
  });

  test("the text view carries the same facts, for curl and for tests", async () => {
    const { dirs: made, entries } = await twoProjects();
    dirs.push(...made);
    const data = await gatherWorkspace(entries);
    const text = renderPhoneText(data);

    assert.match(text, /PROJECTS \(2\)/);
    assert.match(text, /Alpha \[idle\]/);
    assert.match(text, /Beta \[paused\]/);
    assert.match(text, /WAITING ON YOU \(3\)/);
    assert.match(text, /choices: /);
  });

  test("the server serves the page, the JSON and the text, and 404s the rest", async () => {
    const { dirs: made, entries } = await twoProjects();
    dirs.push(...made);

    const handle = await startPhoneServer({ host: "127.0.0.1", port: 0, entries });
    try {
      assert.ok(handle.port > 0, "a real port is bound");

      const page = await fetch(`${handle.url}`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /text\/html/);
      const html = await page.text();
      assert.match(html, /Waiting on you/);

      const json = (await fetch(`${handle.url}status`).then((r) => r.json())) as { projects: unknown[]; pending: unknown[] };
      assert.equal(json.projects.length, 2);
      assert.equal(json.pending.length, 3);

      const text = await fetch(`${handle.url}text`).then((r) => r.text());
      assert.match(text, /PROJECTS \(2\)/);

      const missing = await fetch(`${handle.url}nope`);
      assert.equal(missing.status, 404, "an unknown path is refused, not served the page");
    } finally {
      await handle.close();
    }
  });

  test("the server is read-only: no request can change a project", async () => {
    const { dirs: made, entries } = await twoProjects();
    dirs.push(...made);
    const alphaPath = entries[0]!.path;
    const handle = await startPhoneServer({ host: "127.0.0.1", port: 0, entries });

    try {
      const before = await (await ProjectManager.discover(alphaPath))!.read((project) => JSON.stringify(project));

      // Every mutating method a caller might hope for must be absent.
      for (const [method, path] of [
        ["POST", "/"],
        ["POST", "/status"],
        ["PUT", "/text"],
        ["DELETE", "/"],
        ["PATCH", "/status"],
      ] as const) {
        const response = await fetch(`${handle.url.replace(/\/$/, "")}${path}`, { method });
        assert.ok(response.status >= 400, `${method} ${path} must not be accepted (got ${response.status})`);
      }

      const after = await (await ProjectManager.discover(alphaPath))!.read((project) => JSON.stringify(project));
      assert.equal(after, before, "nothing on disk changed");
    } finally {
      await handle.close();
    }
  });

  test("a busy port is reported instead of crashing the command", async () => {
    // The human asked to see their projects, not to debug a port collision.
    const first = await startPhoneServer({ host: "127.0.0.1", port: 0 });
    try {
      await assert.rejects(
        () => startPhoneServer({ host: "127.0.0.1", port: first.port }),
        (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
        "a taken port surfaces EADDRINUSE so the caller can fall back",
      );
      // And taking port 0 still works while the other is held.
      const second = await startPhoneServer({ host: "127.0.0.1", port: 0 });
      assert.notEqual(second.port, first.port, "a free port is found");
      await second.close();
    } finally {
      await first.close();
    }
  });

  test("a missing project directory does not break the page", async () => {
    const handle = await startPhoneServer({
      host: "127.0.0.1",
      port: 0,
      entries: [{ name: "Gone", path: "/tmp/pi-pm-not-here-either" }],
    });
    try {
      const response = await fetch(handle.url);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Gone/);
    } finally {
      await handle.close();
    }
  });

  test("summarise reports an empty project without inventing numbers", async () => {
    const root = await tempDir();
    dirs.push(root);
    const manager = await ProjectManager.init(root, { name: "Blank", clock: fixedClock(), by: "test" });
    const project = await manager.read((current) => current);
    const summary = summarise({ name: "Blank", path: root }, project);

    assert.equal(summary.state, "IDLE");
    assert.equal(summary.plan, null, "no plan is null, not 0/0");
    assert.equal(summary.currentTask, null);
    assert.deepEqual(summary.pending, []);
  });
});
