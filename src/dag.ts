/**
 * DAG utilities for executable plan nodes.
 *
 * The DAG is the currently executable portion of the plan (spec 12). It is
 * deliberately simple: nodes, dependencies, status. Cycle detection and
 * readiness computation live here so tools, the dashboard and the replanner
 * all agree on the same semantics.
 */

import { idNumber } from "./scoring.ts";
import type { NodeStatus, Plan, PlanNode } from "./types.ts";

export interface DagProblem {
  kind: "duplicate-id" | "missing-dependency" | "cycle";
  node?: string;
  message: string;
}

/** Statuses that are finished, for the purpose of dependency readiness. */
export function isTerminal(status: NodeStatus): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "ABANDONED" || status === "SUPERSEDED";
}

/** A dependency is satisfied when it completed (or was superseded by new work). */
export function isSatisfied(status: NodeStatus): boolean {
  return status === "COMPLETED" || status === "SUPERSEDED";
}

export function validateDag(nodes: readonly PlanNode[]): DagProblem[] {
  const problems: DagProblem[] = [];
  const byId = new Map<string, PlanNode>();

  for (const node of nodes) {
    if (byId.has(node.id)) {
      problems.push({ kind: "duplicate-id", node: node.id, message: `Duplicate node id ${node.id}` });
    }
    byId.set(node.id, node);
  }

  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!byId.has(dep)) {
        problems.push({
          kind: "missing-dependency",
          node: node.id,
          message: `${node.id} depends on unknown node ${dep}`,
        });
      }
    }
  }

  for (const cycle of findCycles(nodes)) {
    problems.push({ kind: "cycle", message: `Dependency cycle: ${cycle.join(" -> ")}` });
  }

  return problems;
}

/** All dependency cycles, each returned once as a node-id path. */
export function findCycles(nodes: readonly PlanNode[]): string[][] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const visit = (id: string): void => {
    const status = state.get(id);
    if (status === "done") return;
    if (status === "visiting") {
      const start = stack.indexOf(id);
      const cycle = stack.slice(start >= 0 ? start : 0).concat(id);
      const key = [...cycle].sort().join("|");
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(cycle);
      }
      return;
    }

    state.set(id, "visiting");
    stack.push(id);
    const node = byId.get(id);
    if (node) {
      for (const dep of node.dependsOn) {
        if (byId.has(dep)) visit(dep);
      }
    }
    stack.pop();
    state.set(id, "done");
  };

  for (const node of nodes) visit(node.id);
  return cycles;
}

/** Dependencies-satisfied PENDING nodes, deterministic order. */
export function readyNodes(nodes: readonly PlanNode[]): PlanNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes
    .filter((node) => node.status === "PENDING")
    .filter((node) => node.dependsOn.every((dep) => isSatisfied(byId.get(dep)?.status ?? "ABANDONED")))
    .sort(compareByPlanOrder);
}

/** PENDING nodes that cannot run yet (missing/unsatisfied dependencies). */
export function blockedByDependencies(nodes: readonly PlanNode[]): PlanNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes
    .filter((node) => node.status === "PENDING")
    .filter((node) => !node.dependsOn.every((dep) => isSatisfied(byId.get(dep)?.status ?? "ABANDONED")))
    .sort(compareByPlanOrder);
}

export function runningNodes(nodes: readonly PlanNode[]): PlanNode[] {
  return nodes.filter((node) => node.status === "RUNNING").sort(compareByPlanOrder);
}

export function nextActionable(nodes: readonly PlanNode[]): PlanNode | undefined {
  return rankActionable(nodes)[0];
}

/**
 * Ready nodes ranked for execution:
 *   1. gate/review/decision nodes (they unblock direction),
 *   2. nodes tied to critical questions or high risks,
 *   3. plan order.
 */
export function rankActionable(nodes: readonly PlanNode[]): PlanNode[] {
  const typeWeight = (node: PlanNode): number => {
    switch (node.type) {
      case "GATE":
        return 3;
      case "REVIEW":
      case "DECISION":
        return 2;
      case "EXPERIMENT":
      case "INVESTIGATION":
        return 1;
      default:
        return 0;
    }
  };

  return readyNodes(nodes).sort((a, b) => {
    const typeDiff = typeWeight(b) - typeWeight(a);
    if (typeDiff !== 0) return typeDiff;
    const linkDiff = linkWeight(b) - linkWeight(a);
    if (linkDiff !== 0) return linkDiff;
    return compareByPlanOrder(a, b);
  });
}

function linkWeight(node: PlanNode): number {
  return (node.question ? 1 : 0) + (node.risk ? 1 : 0) + (node.goal ? 0.5 : 0);
}

export function compareByPlanOrder(a: PlanNode, b: PlanNode): number {
  return idNumber(a.id) - idNumber(b.id);
}

/** Dependencies-then-node topological order (Kahn). */
export function topoOrder(nodes: readonly PlanNode[]): PlanNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const remaining = new Map(nodes.map((node) => [node.id, node.dependsOn.filter((dep) => byId.has(dep)).length]));
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!byId.has(dep)) continue;
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }

  const queue = nodes
    .filter((node) => (remaining.get(node.id) ?? 0) === 0)
    .map((node) => node.id)
    .sort((a, b) => idNumber(a) - idNumber(b));

  const out: PlanNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = byId.get(id);
    if (node) out.push(node);
    for (const dependent of dependents.get(id) ?? []) {
      const left = (remaining.get(dependent) ?? 1) - 1;
      remaining.set(dependent, left);
      if (left <= 0) {
        queue.push(dependent);
        queue.sort((a, b) => idNumber(a) - idNumber(b));
      }
    }
  }

  // Cycles: append remaining nodes so callers still see every node.
  if (out.length < nodes.length) {
    const included = new Set(out.map((node) => node.id));
    out.push(...nodes.filter((node) => !included.has(node.id)).sort(compareByPlanOrder));
  }
  return out;
}

export interface DagStats {
  total: number;
  byStatus: Record<NodeStatus, number>;
  ready: number;
  blocked: number;
  complete: number;
}

export function dagStats(nodes: readonly PlanNode[]): DagStats {
  const byStatus = {
    PENDING: 0,
    RUNNING: 0,
    BLOCKED: 0,
    COMPLETED: 0,
    FAILED: 0,
    INTERRUPTED: 0,
    ABANDONED: 0,
    SUPERSEDED: 0,
  } satisfies Record<NodeStatus, number>;

  for (const node of nodes) byStatus[node.status] = (byStatus[node.status] ?? 0) + 1;

  return {
    total: nodes.length,
    byStatus,
    ready: readyNodes(nodes).length,
    blocked: blockedByDependencies(nodes).length + byStatus.BLOCKED,
    complete: byStatus.COMPLETED,
  };
}

export function findNode(plan: Plan, id: string): PlanNode | undefined {
  return plan.nodes.find((node) => node.id === id);
}

/** Nodes that (transitively) depend on the given node. */
export function descendants(nodes: readonly PlanNode[], id: string): PlanNode[] {
  const direct = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      const list = direct.get(dep) ?? [];
      list.push(node.id);
      direct.set(dep, list);
    }
  }

  const out = new Set<string>();
  const stack = [...(direct.get(id) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (out.has(current)) continue;
    out.add(current);
    stack.push(...(direct.get(current) ?? []));
  }

  return nodes.filter((node) => out.has(node.id));
}
