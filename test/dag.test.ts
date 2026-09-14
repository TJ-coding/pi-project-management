import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  blockedByDependencies,
  dagStats,
  descendants,
  findCycles,
  nextActionable,
  rankActionable,
  readyNodes,
  topoOrder,
  validateDag,
} from "../src/dag.ts";
import type { NodeStatus, NodeType, PlanNode } from "../src/types.ts";

let counter = 0;
function node(id: string, dependsOn: string[] = [], overrides: Partial<PlanNode> = {}): PlanNode {
  counter += 1;
  return {
    id,
    title: `node ${id}`,
    description: "",
    type: (overrides.type ?? "TASK") as NodeType,
    status: (overrides.status ?? "PENDING") as NodeStatus,
    dependsOn,
    goal: null,
    risk: null,
    question: null,
    outputs: [],
    failureReason: null,
    assignee: "agent",
    gate: overrides.gate ?? null,
    run: null,
    percent: overrides.percent ?? null,
    created: `2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`,
    updated: "2026-01-01T00:00:00.000Z",
    started: null,
    finished: null,
    ...overrides,
  };
}

describe("dag", () => {
  test("linear chain is only executable in order", () => {
    const nodes = [node("N1"), node("N2", ["N1"]), node("N3", ["N2"])];
    assert.deepEqual(readyNodes(nodes).map((n) => n.id), ["N1"]);
    nodes[0]!.status = "COMPLETED";
    assert.deepEqual(readyNodes(nodes).map((n) => n.id), ["N2"]);
    nodes[1]!.status = "FAILED";
    assert.deepEqual(readyNodes(nodes).map((n) => n.id), []);
    assert.deepEqual(blockedByDependencies(nodes).map((n) => n.id), ["N3"]);
  });

  test("diamond dependencies resolve deterministically", () => {
    const nodes = [
      node("N1"),
      node("N2", ["N1"]),
      node("N3", ["N1"]),
      node("N4", ["N2", "N3"]),
    ];
    nodes[0]!.status = "COMPLETED";
    assert.deepEqual(readyNodes(nodes).map((n) => n.id), ["N2", "N3"]);
    nodes[1]!.status = "COMPLETED";
    assert.deepEqual(readyNodes(nodes).map((n) => n.id), ["N3"]);
    nodes[2]!.status = "COMPLETED";
    assert.deepEqual(readyNodes(nodes).map((n) => n.id), ["N4"]);
  });

  test("cycles and missing dependencies are reported", () => {
    const cyclic = [node("N1", ["N2"]), node("N2", ["N1"])];
    const cycles = findCycles(cyclic);
    assert.equal(cycles.length, 1);
    assert.ok(cycles[0]!.includes("N1") && cycles[0]!.includes("N2"));

    const problems = validateDag([...cyclic, node("N3", ["N404"])]);
    assert.ok(problems.some((problem) => problem.kind === "cycle"));
    assert.ok(problems.some((problem) => problem.kind === "missing-dependency" && problem.node === "N3"));

    const duplicate = validateDag([node("N1"), node("N1")]);
    assert.ok(duplicate.some((problem) => problem.kind === "duplicate-id"));
  });

  test("topological order respects dependencies and is stable", () => {
    const nodes = [node("N3", ["N1"]), node("N1"), node("N2", ["N1", "N3"])];
    assert.deepEqual(topoOrder(nodes).map((n) => n.id), ["N1", "N3", "N2"]);
  });

  test("gate and review nodes rank above plain tasks", () => {
    const nodes = [
      node("N1", [], { type: "TASK" }),
      node("N2", [], { type: "REVIEW" }),
      node("N3", [], { type: "GATE", gate: { type: "STRATEGIC_REVIEW", criteria: "still aligned" } }),
      node("N4", [], { type: "INVESTIGATION", question: "Q1" }),
    ];
    assert.deepEqual(rankActionable(nodes).map((n) => n.id), ["N3", "N2", "N4", "N1"]);
    assert.equal(nextActionable(nodes)!.id, "N3");
  });

  test("descendants include transitive dependents", () => {
    const nodes = [node("N1"), node("N2", ["N1"]), node("N3", ["N2"]), node("N4")];
    assert.deepEqual(descendants(nodes, "N1").map((n) => n.id), ["N2", "N3"]);
  });

  test("stats summarise status and readiness", () => {
    const nodes = [
      node("N1", [], { status: "COMPLETED" }),
      node("N2", ["N1"]),
      node("N3", [], { status: "BLOCKED" }),
    ];
    const stats = dagStats(nodes);
    assert.equal(stats.total, 3);
    assert.equal(stats.byStatus.COMPLETED, 1);
    assert.equal(stats.ready, 1);
    assert.equal(stats.blocked, 1);
  });

  test("superseded dependencies satisfy dependents, abandoned ones do not", () => {
    const superseded = [node("N1", [], { status: "SUPERSEDED" }), node("N2", ["N1"])];
    assert.deepEqual(readyNodes(superseded).map((n) => n.id), ["N2"]);
    const abandoned = [node("N1", [], { status: "ABANDONED" }), node("N2", ["N1"])];
    assert.deepEqual(readyNodes(abandoned).map((n) => n.id), []);
  });
});
