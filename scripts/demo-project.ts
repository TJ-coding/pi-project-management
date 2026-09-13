#!/usr/bin/env node
/**
 * Generate a content-rich demo project so the dashboard, plan view and
 * scrolling can be explored without waiting for a real project to grow.
 *
 *   node scripts/demo-project.ts /tmp/pm-demo
 *   python3 scripts/tui-smoke.py --cwd /tmp/pm-demo
 *
 * Uses the extension's own core modules, so it is also a small integration test
 * of the public ProjectManager API.
 */

import { mkdir, rm } from "node:fs/promises";
import { ProjectManager } from "../src/project.ts";

const root = process.argv[2] ?? "/tmp/pm-demo";
const force = process.argv.includes("--force");

await mkdir(root, { recursive: true });
const existing = await ProjectManager.discover(root, { by: "human" });
if (existing) {
  if (!force) {
    console.error(`A project already exists at ${existing.root} (pass --force to replace it)`);
    process.exit(1);
  }
  await rm(`${existing.root}/.project`, { recursive: true, force: true });
}

const manager = await ProjectManager.init(root, {
  name: "Autonomous Research Agent",
  vision:
    "Build an autonomous research environment capable of conducting multi-day research investigations with minimal human intervention.",
  intent:
    "Develop infrastructure for autonomous scientific research while reducing the amount of manual experimentation required from researchers.",
  values: ["Simple", "YAGNI", "Reliable", "Reproducible", "Maintainable"],
  concepts: [
    { type: "strategic", text: "Focus on autonomous experimentation rather than autonomous writing." },
    { type: "design", text: "Everything should be resumable after interruption." },
    { type: "technical", text: "Use Git as the durable project state." },
    { type: "architecture", text: "Separate planning from execution." },
  ],
  repos: ["https://github.com/example/autonomous-research"],
  by: "human",
});

const m = await manager.updateDirection({}, { approved: true, commit: false });
void m;

await manager.updateState(
  {
    initial: "Paper repository and evaluation harness existed, but nothing was automated.",
    current: "Prototype operational; evaluator remains uncertain.",
    capabilities: ["paper ingestion", "experiment runner", "result store"],
    facts: ["Human annotation costs ~2 minutes per paper"],
    problems: ["Evaluator agreement with humans is unmeasured"],
    constraints: ["Single 8-core workstation", "No external API budget"],
    discoveries: ["Reusing the existing parser removed two weeks of work"],
  },
  { commit: false },
);

const goals = [
  { title: "Build prototype", priority: 5, successCriteria: ["end-to-end run completes unattended"] },
  { title: "Autonomous experiment selection", priority: 4, successCriteria: ["agent picks next experiment"] },
  { title: "Demonstrate useful research output", priority: 4, successCriteria: ["one novel finding reproduced"] },
  { title: "Original architecture", priority: 2 },
];
for (const goal of goals) await manager.createGoal(goal, { commit: false });
await manager.setGoalStatus("G1", "COMPLETED", { commit: false });
await manager.setGoalStatus("G4", "FAILED", { commit: false, reason: "did not scale past 10k records" });

const questions = [
  {
    question: "Does the evaluator correlate with human judgement?",
    importance: 1,
    uncertainty: 1,
    decisionImpact: 0.9,
  },
  { question: "Can the loop converge reliably?", importance: 0.8, uncertainty: 0.9, decisionImpact: 0.8 },
  { question: "Is a 10k-record index enough for a real corpus?", importance: 0.7, uncertainty: 0.8, decisionImpact: 0.6 },
  { question: "Which experiment does the planner pick first?", importance: 0.5, uncertainty: 1, decisionImpact: 0.4 },
  { question: "Do we need a GPU at all?", importance: 0.4, uncertainty: 0.7, decisionImpact: 0.5 },
];
for (const question of questions) await manager.createQuestion(question, { commit: false });
await manager.answerQuestion(
  "Q3",
  { answer: "At 10k records the index degrades sharply.", status: "PARTIAL", confidence: 0.6 },
  { commit: false },
);

await manager.createRisk(
  {
    title: "Evaluation reliability",
    description: "The loop optimises against a proxy that humans may not agree with.",
    probability: 0.4,
    impact: 0.9,
    mitigation: "Run a human comparison on 100 sampled outputs.",
    contingency: "Fall back to human-in-the-loop approval for high-impact experiments.",
    questions: ["Q1"],
  },
  { commit: false },
);
await manager.createRisk(
  { title: "Compute cost", probability: 0.5, impact: 0.5, mitigation: "Cap nightly runs at 6 hours." },
  { commit: false },
);
await manager.createRisk(
  { title: "Reproducibility drift", probability: 0.3, impact: 0.7, mitigation: "Pin environments and hash inputs." },
  { commit: false },
);
await manager.createRisk(
  { title: "Original architecture fails at scale", probability: 0.8, impact: 0.8, status: "OCCURRED" },
  { commit: false },
);

await manager.setStrategy(
  {
    approach: "Focus on autonomous experimentation rather than autonomous writing.",
    hypotheses: [
      "A better evaluator is the highest-leverage improvement",
      "Resumability matters more than raw speed",
    ],
    priorities: ["Validate the evaluator", "Harden the runner against interruption"],
    rationale: "The evaluator gates every other decision, and unattended runs must survive failures.",
    alternatives: ["Improve paper generation instead", "Buy a GPU and scale the old architecture"],
  },
  { commit: false },
);

const first = manager.analyzeReplan({ trigger: "kickoff" });
await manager.applyReplan(first, { commit: false });

await manager.addNode(
  { title: "Benchmark evaluator against human annotations", type: "EXPERIMENT", question: "Q1", risk: "R1" },
  { commit: false },
);
await manager.addNode({ title: "Analyze benchmark results", type: "TASK", dependsOn: ["N1"] }, { commit: false });
await manager.addNode(
  {
    title: "Strategic review of evaluation approach",
    type: "GATE",
    dependsOn: ["N2"],
    gate: { type: "STRATEGIC_REVIEW", criteria: "Still consistent with vision, intent and values?" },
  },
  { commit: false },
);

await manager.recordDecision(
  {
    title: "Validate the evaluator before scaling",
    decision: "Invest in evaluator validation before adding compute.",
    rationale: "Every downstream result depends on evaluator quality.",
    alternatives: ["Scale first, validate later"],
    authority: "SIGNIFICANT",
    questions: ["Q1"],
    risks: ["R1"],
  },
  { commit: false },
);

await manager.recordDecision(
  {
    title: "Abandon the original index architecture",
    decision: "Replace the in-memory index with a sharded on-disk format.",
    rationale: "The scalability experiment invalidated the architecture assumption at 10k records.",
    alternatives: ["Keep the in-memory index and cap corpus size"],
    authority: "SIGNIFICANT",
    evidence: [{ description: "Scalability benchmark", kind: "experiment", ref: "bench/2026-01-14" }],
    risks: ["R4"],
  },
  { commit: false },
);

const run = await manager.startRun(
  { title: "Human comparison batch", node: "N1", environment: [{ kind: "ssh", target: "workstation-8c" }] },
  { commit: false },
);
await manager.logRun(
  run.id,
  [
    { kind: "progress", text: "40/100 annotations collected" },
    { kind: "progress", text: "80/100 annotations collected" },
    { kind: "output", text: "agreement r=0.71 (95% CI 0.62-0.78)" },
  ],
  { commit: false },
);
await manager.finishRun(
  run.id,
  {
    status: "COMPLETED",
    outputs: [{ description: "Human/evaluator agreement r=0.71", kind: "measurement", ref: "bench/human-comparison" }],
    notes: "Agreement is promising but not yet sufficient for unattended high-impact runs.",
  },
  { commit: false },
);

const second = manager.analyzeReplan({ trigger: "evaluator benchmark returned partial evidence", evidence: ["agreement r=0.71"] });
await manager.applyReplan(second, { commit: false });
await manager.setNodeStatus("N1", "COMPLETED", { commit: false, outputs: ["agreement r=0.71"] });

console.log(`Demo project created at ${root}`);
console.log("Open it with:  cd " + root + " && pi   then run /project");
