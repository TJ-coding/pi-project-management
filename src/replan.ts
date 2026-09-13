/**
 * Replanning (spec 10, 11, 25).
 *
 * The deterministic part of replanning lives here: carry forward only work that
 * is still justified by current knowledge, supersede work invalidated by new
 * evidence, and add the smallest investigation/review steps for the highest
 * priority unknowns. The agent can accept this proposal, edit it, or supply its
 * own plan; either way the change is recorded as a plan version with a reason.
 */

import { readyNodes } from "./dag.ts";
import { appendHistory } from "./history.ts";
import { nextId } from "./ids.ts";
import { byQuestionPriority, byRiskPriority, questionScore, riskScore, scoreBand } from "./scoring.ts";
import type {
  GateSpec,
  NodeStatus,
  NodeType,
  Plan,
  PlanChange,
  PlanNode,
  Project,
  Strategy,
} from "./types.ts";

export interface ReplanInputs {
  /** Why replanning is happening (new evidence, gate failure, goal change...). */
  trigger: string;
  /** Free-form evidence lines the agent wants recorded. */
  evidence?: string[];
  /** Optional requested plan title. */
  title?: string;
}

/** A plan node as expressed in a proposal, before ids are finalized. */
export interface ProposedNode {
  /** Local reference (N3 keeps its id; I1/R1 map to a fresh id). */
  ref?: string;
  title: string;
  type: NodeType;
  description?: string;
  dependsOn?: string[];
  goal?: string | null;
  risk?: string | null;
  question?: string | null;
  gate?: GateSpec | null;
  assignee?: "agent" | "human";
  status?: NodeStatus;
  outputs?: string[];
  created?: string;
  started?: string | null;
  finished?: string | null;
  run?: string | null;
}

export interface ReplanProposal {
  trigger: string;
  rationale: string;
  title: string;
  strategy?: Partial<Strategy>;
  nodes: ProposedNode[];
  /** Human-readable list of what changed. */
  notes: string[];
  superseded: string[];
  carried: string[];
  /** Evidence lines supplied by the caller (spec 25 input 12). */
  evidenceHints?: string[];
}

/**
 * Build the smallest useful plan supported by current knowledge.
 */
export function analyzeReplan(project: Project, inputs: ReplanInputs): ReplanProposal {
  const current = activePlan(project);
  const notes: string[] = [];
  const superseded: string[] = [];
  const carried: string[] = [];
  const nodes: ProposedNode[] = [];

  const goalStatus = new Map(project.goals.map((goal) => [goal.id, goal.status]));
  const questionById = new Map(project.questions.map((question) => [question.id, question]));
  const riskById = new Map(project.risks.map((risk) => [risk.id, risk]));

  // 1. Carry forward completed work (keeps DAG history inside the plan).
  if (current) {
    for (const node of current.nodes) {
      if (node.status === "COMPLETED") {
        nodes.push(carryNode(node));
        carried.push(`${node.id} (completed)`);
      }
    }
  }

  // 2. Decide what unfinished work still survives.
  if (current) {
    for (const node of current.nodes) {
      if (node.status === "COMPLETED") continue;

      if (node.status === "FAILED" || node.status === "ABANDONED" || node.status === "SUPERSEDED") {
        superseded.push(`${node.id} ${node.title} (${node.status.toLowerCase()})`);
        notes.push(`Superseded ${node.id} (${node.title}) — previous attempt ${node.status.toLowerCase()}.`);
        continue;
      }

      const reasons: string[] = [];
      const goal = node.goal ? goalStatus.get(node.goal) : undefined;
      if (node.goal && goal && goal !== "ACTIVE") reasons.push(`goal ${node.goal} is ${goal}`);
      const question = node.question ? questionById.get(node.question) : undefined;
      if (question && question.status === "INVALIDATED") reasons.push(`question ${question.id} was INVALIDATED`);
      const risk = node.risk ? riskById.get(node.risk) : undefined;
      if (risk && (risk.status === "RESOLVED" || risk.status === "CLOSED")) {
        reasons.push(`risk ${risk.id} is ${risk.status}`);
      }

      if (reasons.length > 0) {
        superseded.push(`${node.id} ${node.title} (${reasons.join("; ")})`);
        notes.push(`Dropped ${node.id} (${node.title}) — ${reasons.join("; ")}.`);
        continue;
      }

      nodes.push(carryNode(node));
      carried.push(node.id);
    }
  }

  // 3. Add investigation work for the most important things we do not know,
  //    unless that question is already being investigated.
  const alreadyInvestigating = new Set(nodes.filter((node) => node.question).map((node) => node.question as string));
  const topQuestions = byQuestionPriority(
    project.questions.filter((question) => question.status === "UNKNOWN" || question.status === "PARTIAL"),
  ).filter((question) => questionScore(question) >= 0.15 && !alreadyInvestigating.has(question.id));

  const addedRefs: string[] = [];
  let added = 0;
  for (const question of topQuestions.slice(0, 3)) {
    added += 1;
    const ref = `I${added}`;
    addedRefs.push(ref);
    nodes.push({
      ref,
      title: `Investigate: ${question.question}`,
      type: "INVESTIGATION",
      description: `Answer ${question.id} with evidence. Priority ${scoreBand(questionScore(question))}.`,
      question: question.id,
      risk: question.risks[0] ?? null,
      goal: question.goals[0] ?? null,
    });
    notes.push(`Added investigation for ${question.id} (${scoreBand(questionScore(question))}): ${question.question}`);
  }

  // 4. Add a risk-reduction step for the highest unresolved risk with no work.
  const linkedRisks = new Set(nodes.filter((node) => node.risk).map((node) => node.risk as string));
  const topRisk = byRiskPriority(project.risks).find(
    (risk) =>
      riskScore(risk) >= 0.25 &&
      !linkedRisks.has(risk.id) &&
      (risk.status === "OPEN" || risk.status === "MITIGATING"),
  );
  if (topRisk) {
    added += 1;
    const ref = `I${added}`;
    addedRefs.push(ref);
    nodes.push({
      ref,
      title: `Reduce risk ${topRisk.id}: ${topRisk.title}`,
      type: "TASK",
      description: topRisk.mitigation || "Apply mitigation or gather evidence to update probability/impact.",
      risk: topRisk.id,
      goal: topRisk.goals[0] ?? null,
    });
    notes.push(`Added mitigation work for ${topRisk.id} (exposure ${(topRisk.probability * topRisk.impact).toFixed(2)}).`);
  }

  // 5. Close the plan with a strategic review when there is real uncertainty.
  const hasOpenWork = nodes.some((node) => node.status !== "COMPLETED");
  if (hasOpenWork && !nodes.some((node) => node.type === "REVIEW")) {
    added += 1;
    const ref = `R${added}`;
    nodes.push({
      ref,
      title: "Strategic review of results",
      type: "REVIEW",
      description: "Compare evidence against vision/intent/values/concepts/goals; continue or replan (spec 13).",
      dependsOn: [...addedRefs],
    });
    notes.push("Added a strategic review step so the plan re-evaluates direction after evidence arrives.");
  }

  const rationale =
    notes.length > 0
      ? `Smallest plan justified by current knowledge. ${notes.join(" ")}`
      : "No changes needed; the current plan is still the smallest plan justified by current knowledge.";

  return {
    trigger: inputs.trigger,
    rationale,
    title: inputs.title ?? (current ? `${current.title} (replanned)` : "Initial plan"),
    nodes,
    notes,
    superseded,
    carried,
    evidenceHints: inputs.evidence ?? [],
  };
}

export interface ApplyResult {
  plan: Plan;
  change: PlanChange;
  notes: string[];
}

/** Apply a proposal (or an agent-supplied node list) as a new plan version. */
export function applyReplan(
  project: Project,
  proposal: ReplanProposal,
  options: { by?: string; at: string; pivot?: boolean },
): ApplyResult {
  const current = activePlan(project);
  const id = nextId("plan", project.plans.plans.map((plan) => plan.id));
  const version = (current?.version ?? 0) + 1;
  const by = options.by ?? "agent";

  const taken = new Set<string>(current?.nodes.map((node) => node.id) ?? []);
  let counter = 0;
  const freshNodeId = (): string => {
    do {
      counter += 1;
    } while (taken.has(`N${counter}`));
    const candidate = `N${counter}`;
    taken.add(candidate);
    return candidate;
  };

  const refToId = new Map<string, string>();
  const ids: string[] = [];
  for (const proposed of proposal.nodes) {
    const ref = proposed.ref;
    const keepExisting = ref !== undefined && /^N\d+$/.test(ref) && !ids.includes(ref);
    const nodeId = keepExisting ? ref : freshNodeId();
    if (ref !== undefined) refToId.set(ref, nodeId);
    ids.push(nodeId);
  }
  const idSet = new Set(ids);
  const notes = [...proposal.notes];
  const droppedDeps: string[] = [];

  const nodes: PlanNode[] = proposal.nodes.map((proposed, index) => {
    const nodeId = ids[index]!;
    const dependsOn = (proposed.dependsOn ?? [])
      .map((dep) => refToId.get(dep) ?? dep)
      .filter((dep) => {
        if (idSet.has(dep)) return true;
        droppedDeps.push(`${nodeId} -> ${dep}`);
        return false;
      });
    return {
      id: nodeId,
      title: proposed.title,
      description: proposed.description ?? "",
      type: proposed.type,
      status: proposed.status ?? "PENDING",
      dependsOn,
      goal: proposed.goal ?? null,
      risk: proposed.risk ?? null,
      question: proposed.question ?? null,
      outputs: proposed.outputs ?? [],
      failureReason: null,
      assignee: proposed.assignee ?? "agent",
      gate: proposed.gate ?? null,
      run: proposed.run ?? null,
      created: proposed.created ?? options.at,
      updated: options.at,
      started: proposed.started ?? null,
      finished: proposed.finished ?? null,
    };
  });

  if (droppedDeps.length > 0) {
    notes.push(`Removed dangling dependencies: ${droppedDeps.join(", ")}.`);
  }

  const plan: Plan = {
    id,
    version,
    title: proposal.title,
    rationale: proposal.rationale,
    createdAt: options.at,
    supersededBy: null,
    nodes,
    gates: [],
  };

  if (current) {
    current.supersededBy = id;
    for (const node of current.nodes) {
      const stillLive =
        node.status === "COMPLETED" && nodes.some((candidate) => candidate.id === node.id);
      if (!stillLive && !["SUPERSEDED", "ABANDONED", "FAILED", "COMPLETED"].includes(node.status)) {
        node.status = "SUPERSEDED";
      }
    }
  }

  project.plans.plans.push(plan);
  project.plans.active = id;
  project.meta.activePlan = id;

  const change: PlanChange = {
    from: current?.id ?? null,
    to: id,
    reason: proposal.rationale,
    trigger: proposal.trigger,
    at: options.at,
    by,
  };
  project.plans.changes.push(change);

  appendHistory(
    project,
    {
      kind: options.pivot ? "pivot" : current ? "plan.changed" : "plan.created",
      summary: current
        ? `Plan ${current.id} -> ${id}: ${proposal.rationale}`
        : `Plan ${id} created: ${proposal.rationale}`,
      by,
      refs: [id, ...(current ? [current.id] : [])],
      details: { notes, superseded: proposal.superseded, carried: proposal.carried },
      at: options.at,
    },
    options.at,
  );

  return { plan, change, notes };
}

function carryNode(node: PlanNode): ProposedNode {
  return {
    ref: node.id,
    title: node.title,
    type: node.type,
    description: node.description,
    dependsOn: node.dependsOn,
    goal: node.goal,
    risk: node.risk,
    question: node.question,
    gate: node.gate,
    assignee: node.assignee,
    status: node.status,
    outputs: node.outputs,
    created: node.created,
    started: node.started,
    finished: node.finished,
    run: node.run,
  };
}

export function activePlan(project: Project): Plan | undefined {
  if (project.meta.activePlan) {
    const found = project.plans.plans.find((plan) => plan.id === project.meta.activePlan);
    if (found) return found;
  }
  if (project.plans.active) {
    const found = project.plans.plans.find((plan) => plan.id === project.plans.active);
    if (found) return found;
  }
  return project.plans.plans[project.plans.plans.length - 1];
}

/** Nodes ready to execute right now. */
export function nextSteps(project: Project): PlanNode[] {
  const plan = activePlan(project);
  return plan ? readyNodes(plan.nodes) : [];
}

/** True when a plan has open work but nothing can execute. */
export function isPlanStuck(project: Project): boolean {
  const plan = activePlan(project);
  if (!plan) return true;
  const open = plan.nodes.some(
    (node) => node.status === "PENDING" || node.status === "RUNNING" || node.status === "BLOCKED",
  );
  if (!open) return false;
  return readyNodes(plan.nodes).length === 0;
}
