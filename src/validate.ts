/**
 * Integrity checks for a project. Used by `/project review`, the status tool and
 * the test-suite. Returning issues instead of silently repairing data keeps the
 * user in control of their project files.
 */

import { validateDag } from "./dag.ts";
import type { Project } from "./types.ts";

export function validateProject(project: Project): string[] {
  const issues: string[] = [];
  const goals = new Set(project.goals.map((goal) => goal.id));
  const questions = new Set(project.questions.map((question) => question.id));
  const risks = new Set(project.risks.map((risk) => risk.id));
  const decisions = new Set(project.decisions.map((decision) => decision.id));
  const runs = new Set(project.runs.map((run) => run.id));
  const nodes = new Set(project.plans.plans.flatMap((plan) => plan.nodes.map((node) => node.id)));

  checkDuplicates(project, issues);

  for (const goal of project.goals) {
    if (goal.parent && !goals.has(goal.parent)) issues.push(`${goal.id}: parent goal ${goal.parent} does not exist`);
    if (goal.supersededBy && !goals.has(goal.supersededBy)) {
      issues.push(`${goal.id}: supersededBy ${goal.supersededBy} does not exist`);
    }
    for (const id of goal.questions) if (!questions.has(id)) issues.push(`${goal.id}: links to missing question ${id}`);
    for (const id of goal.risks) if (!risks.has(id)) issues.push(`${goal.id}: links to missing risk ${id}`);
    for (const id of goal.tasks) if (!nodes.has(id)) issues.push(`${goal.id}: links to missing node ${id}`);
  }

  for (const question of project.questions) {
    for (const id of question.goals) if (!goals.has(id)) issues.push(`${question.id}: links to missing goal ${id}`);
    for (const id of question.risks) if (!risks.has(id)) issues.push(`${question.id}: links to missing risk ${id}`);
    for (const id of question.tasks) if (!nodes.has(id)) issues.push(`${question.id}: links to missing node ${id}`);
    for (const id of question.decisions) {
      if (!decisions.has(id)) issues.push(`${question.id}: links to missing decision ${id}`);
    }
    for (const evidence of question.evidence) {
      if (evidence.run && !runs.has(evidence.run)) issues.push(`${question.id}: evidence references missing run ${evidence.run}`);
    }
  }

  for (const risk of project.risks) {
    for (const id of risk.goals) if (!goals.has(id)) issues.push(`${risk.id}: links to missing goal ${id}`);
    for (const id of risk.questions) if (!questions.has(id)) issues.push(`${risk.id}: links to missing question ${id}`);
    for (const id of risk.tasks) if (!nodes.has(id)) issues.push(`${risk.id}: links to missing node ${id}`);
  }

  for (const plan of project.plans.plans) {
    for (const problem of validateDag(plan.nodes)) {
      issues.push(`plan ${plan.id}: ${problem.message}`);
    }
    for (const node of plan.nodes) {
      if (node.goal && !goals.has(node.goal)) issues.push(`${plan.id}/${node.id}: missing goal ${node.goal}`);
      if (node.question && !questions.has(node.question)) {
        issues.push(`${plan.id}/${node.id}: missing question ${node.question}`);
      }
      if (node.risk && !risks.has(node.risk)) issues.push(`${plan.id}/${node.id}: missing risk ${node.risk}`);
      if (node.run && !runs.has(node.run)) issues.push(`${plan.id}/${node.id}: missing run ${node.run}`);
      if (node.type === "GATE" && !node.gate) issues.push(`${plan.id}/${node.id}: GATE node has no gate criteria`);
    }
    if (plan.supersededBy && !project.plans.plans.some((candidate) => candidate.id === plan.supersededBy)) {
      issues.push(`plan ${plan.id}: supersededBy ${plan.supersededBy} does not exist`);
    }
  }

  if (project.plans.active && !project.plans.plans.some((plan) => plan.id === project.plans.active)) {
    issues.push(`active plan ${project.plans.active} does not exist`);
  }
  for (const change of project.plans.changes) {
    if (!project.plans.plans.some((plan) => plan.id === change.to)) {
      issues.push(`plan change references missing plan ${change.to}`);
    }
  }

  const liveLinks = (refs: readonly string[], kind: string): void => {
    for (const ref of refs) {
      if (!/^RUN\d+$/.test(ref)) continue;
      if (!runs.has(ref)) issues.push(`${kind}: references missing run ${ref}`);
    }
  };
  for (const decision of project.decisions) {
    for (const id of decision.goals) if (!goals.has(id)) issues.push(`${decision.id}: links to missing goal ${id}`);
    for (const id of decision.questions) if (!questions.has(id)) issues.push(`${decision.id}: links to missing question ${id}`);
    for (const id of decision.risks) if (!risks.has(id)) issues.push(`${decision.id}: links to missing risk ${id}`);
    liveLinks(decision.evidence.map((evidence) => evidence.run ?? ""), decision.id);
  }

  if (!project.direction.vision) issues.push("direction: vision is empty");
  if (!project.state.current) issues.push("state: current state is empty");

  return issues;
}

function checkDuplicates(project: Project, issues: string[]): void {
  const seen = new Map<string, number>();
  const record = (id: string, kind: string): void => {
    const key = `${kind}:${id}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  };
  for (const goal of project.goals) record(goal.id, "goal");
  for (const question of project.questions) record(question.id, "question");
  for (const risk of project.risks) record(risk.id, "risk");
  for (const decision of project.decisions) record(decision.id, "decision");
  for (const run of project.runs) record(run.id, "run");
  for (const [key, count] of seen) {
    if (count > 1) issues.push(`duplicate id ${key}`);
  }
}
