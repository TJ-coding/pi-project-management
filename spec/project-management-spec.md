# Project Management Spec

> Reference copy of the specification this extension implements.
> Converted from `Project Management Spec.rtf` (RTF v1.0, ANSI).

Pi Project Management Extension
1. Overview
A Pi extension for managing long-running projects collaboratively between humans and AI agents.
The extension provides a persistent project-management layer that sits above individual Pi sessions. It allows humans and agents to:
    - define project direction;
    - establish goals;
    - record the current state of the project;
    - maintain project intelligence as questions and answers;
    - identify and manage risks;
    - develop and execute plans;
    - dynamically change plans as new information becomes available;
    - run work for hours or days without requiring a single continuous Pi session;
    - inspect how a project evolved over time;
    - use Git and normal filesystem primitives as durable storage.
The system is intentionally not a fully formal project-management methodology.
Its fundamental philosophy is:
Direction is relatively stable. Plans are hypotheses. Execution generates information. New information changes the plan.
The system should remain understandable to both humans and capable-but-imperfect AI agents.

2. Design Principles
2.1 Direction over prescription
The system should clearly communicate where the project is going without requiring the entire project to be planned in advance.
A user should be able to say:
"This is what I want to achieve and why."
without knowing exactly how it will be achieved.
2.2 Plans are provisional
A plan represents the current best understanding of how to achieve the project's goals.
Plans may be:
    - modified;
    - extended;
    - reordered;
    - partially abandoned;
    - replaced;
    - pivoted.
Changing a plan is normal project progress, not an error.
2.3 Progressive planning
The system should plan as far ahead as is sensible given current knowledge.
Highly uncertain projects should have shallow plans.
Well-understood work can have deeply specified DAGs.
The system must not encourage agents to fabricate detailed long-term plans when the underlying information is insufficient.
2.4 Human and agent symmetry
Humans and agents should be able to perform essentially the same project-management operations.
Humans can:
    - create goals;
    - create tasks;
    - change plans;
    - answer questions;
    - create risks;
    - modify direction.
Agents can do the same.
The difference is primarily authority and approval, not capability.
2.5 Persistent project state
The project must survive:
    - Pi session termination;
    - agent context-window limits;
    - machine restarts;
    - failed agents;
    - multi-day execution.
A project is not synonymous with a Pi session.
2.6 Keep it simple
The system should optimize for:
"Can a human understand this?"
and:
"Can an LLM reliably operate it?"
over theoretical completeness.
Avoid introducing elaborate ontology, workflow languages, permissions systems, or databases unless they solve a demonstrated problem.
2.7 History matters
Failed approaches, abandoned goals, previous plans and pivots should remain visible.
The system should make it possible to answer:
"How did we get here?"

3. Project Model
A project consists of six primary conceptual areas:
Direction
State
Intelligence
Risks
Strategy
Plan
These are connected by an iterative loop:
Direction
    ↓
State
    ↓
Intelligence + Risks
    ↓
Strategy
    ↓
Plan
    ↓
Execution
    ↓
Results / Evidence
    ↓
State + Intelligence + Risks
    ↓
Replanning
    ↺

4. Direction
Direction defines the relatively stable orientation of the project.
It consists of:
Vision
Intent
Values
Concepts
Goals
4.1 Vision
Vision describes what the user envisions the future project becoming.
It should be expressed naturally, primarily as prose.
Example:
Build an autonomous research environment capable of conducting multi-day research investigations with minimal human intervention.
Vision is intentionally not a specification or implementation plan.
It should change rarely.

4.2 Intent
Intent describes why the project exists.
It answers:
Why am I doing this?
Intent may explain how the project fits into broader personal, professional, scientific, or strategic objectives.
Example:
Develop infrastructure for autonomous scientific research while reducing the amount of manual experimentation required from researchers.
Intent should prevent projects from becoming activities performed merely because they are interesting.
Intent does not need to reference a formal global "life strategy" hierarchy.
It may simply contain human-written context.

4.3 Values
Values are persistent considerations that should remain in the agent's reasoning throughout the project.
Examples:
Simple
YAGNI
Reliable
Reproducible
Maintainable
Values are not necessarily hard constraints.
They provide guidance when multiple technically valid choices exist.
For example:
Prefer the simpler implementation unless complexity produces a meaningful benefit.
Agents should consider values when making decisions and planning work.

4.4 Concepts
Concepts describe the basic ideas behind the approach.
They are higher-level design/strategy concepts rather than implementation details.
Examples:
Strategic Concept:
Focus on autonomous experimentation rather than autonomous writing.

Design Concept:
Everything should be resumable after interruption.

Technical Concept:
Use Git as the durable project state.

Architecture Concept:
Separate planning from execution.
Concepts may be typed, but arbitrary types should be supported.
Concepts describe how we currently think the problem should be approached.
Unlike values, concepts may change substantially when a project pivots.

4.5 Goals
Goals describe desired end states.
They answer:
What are we ultimately trying to accomplish?
Goals may have:
    - description;
    - priority;
    - success criteria;
    - status;
    - parent goal;
    - relationships to risks/questions/tasks.
Possible statuses:
ACTIVE
COMPLETED
FAILED
ABANDONED
SUPERSEDED
Goals may be created or proposed by either humans or agents.
Agents are allowed to propose new goals.
Changing major goals should normally produce a visible decision/history entry.

5. Current State
State describes where the project is now.
There should be two primary concepts:
Initial State
Current State
Initial state provides the baseline from which the project began.
Current state describes the latest known situation.
State should remain deliberately lightweight.
It may include:
    - current capabilities;
    - current implementation;
    - known facts;
    - completed work;
    - active problems;
    - current constraints;
    - current understanding;
    - important discoveries.
The extension should not attempt to construct an exhaustive formal state model.
State is primarily a human/agent-readable summary.

6. Intelligence
Intelligence is the project's evolving knowledge base.
The fundamental primitive is a question.
Each intelligence item is essentially:
Question
Answer
Priority
Confidence
Evidence
Status
Example:
Q17

Question:
Can architecture X scale to 100,000 records?

Answer:
Unknown.

Priority:
Critical

Confidence:
0.15

Evidence:
None.

Status:
OPEN
An unknown answer is valid.
Possible answer states include:
UNKNOWN
PARTIAL
ANSWERED
CONFIRMED
INVALIDATED
The exact state vocabulary should remain small.
6.1 Prioritization
Questions are ordered by priority.
A default priority model should consider:
Importance
×
Uncertainty
×
Decision impact
The implementation may use a simpler scoring model initially.
The important property is that the system can answer:
What is the most important thing we currently don't know?
Agents may create questions automatically.
Questions may generate work:
Question
    ↓
Investigation
    ↓
Experiment
    ↓
Evidence
    ↓
Answer
Questions may be linked to:
    - goals;
    - risks;
    - tasks;
    - decisions;
    - evidence.

7. Risk Management
Risk management tracks ways in which the project could fail or suffer an undesirable outcome.
A risk should contain approximately:
Risk
Description
Probability
Impact
Exposure
Status
Mitigation
Contingency
Related Questions
Related Goals
Related Tasks
Probability and impact should preferably be represented numerically where practical.
For example:
Probability: 0.4
Impact: 0.9
Exposure: 0.36
The system should maintain a prioritized risk registry.
The important question is:
How can this project fuck up, and which ways are most important?
Risks may be:
    - discovered by humans;
    - discovered by agents;
    - generated from unanswered intelligence questions;
    - resolved through work;
    - reduced through mitigation;
    - increased when new evidence appears.

8. Relationship Between Intelligence and Risk
Intelligence and Risk remain separate concepts.
Intelligence
What do we know or not know?
Risk
What could go wrong?
They are linked.
For example:
Risk:
Architecture may fail at scale.

        ↓ caused partly by

Question:
Can architecture X scale to 100k records?

        ↓

Investigation

        ↓

Evidence

        ↓

Answer

        ↓

Risk probability updated
This allows the planner to prioritize work that simultaneously increases knowledge and reduces risk.

9. Strategy
Strategy is the current answer to:
Given our direction, current state, knowledge and risks, what appears to be the best way forward?
Strategy is more mutable than Direction.
It may contain:
    - current approach;
    - strategic hypotheses;
    - priorities;
    - rationale;
    - major alternatives considered.
Strategy is not necessarily a formal document.
It is primarily a persistent snapshot of the project's current thinking.
Agents may update strategy when new information warrants it.
Significant changes should be recorded in project history.

10. Plans
A Plan is a current hypothesis for achieving the goals.
It is not assumed to be complete.
A plan may contain:
Goal
    ↓
Subgoal
    ↓
DAG
    ↓
Tasks / Investigations / Experiments / Decisions
Plans should be generated to the depth justified by current certainty.
For uncertain work:
Goal
  ↓
Investigation
  ↓
Review
is preferable to inventing 100 hypothetical future tasks.
For well-understood work:
A → B → C → D → E
is appropriate.

11. Adaptive Planning
The active plan is expected to change during execution.
Example:
Plan V1
    ↓
Experiment
    ↓
New evidence
    ↓
Plan V2
    ↓
New evidence
    ↓
Pivot
    ↓
Plan V3
The system should preserve previous plans.
Each meaningful replanning event should record:
Previous Plan
New Plan
Reason
Evidence / trigger
Git history may provide much of the underlying implementation.
The extension should provide a concise human-readable representation of significant plan changes.

12. DAG
The DAG is the currently executable portion of the plan.
It is not the permanent representation of the entire project.
A DAG node may represent:
Task
Investigation
Experiment
Decision
Review
Gate
Wait
Nodes should support:
    - dependencies;
    - status;
    - description;
    - outputs;
    - failure reason;
    - associated goal;
    - associated risk;
    - associated intelligence question.
Example:
Q17
 ↓
Investigate scalability
 ↓
Run benchmark
 ↓
Analyze results
 ↓
Strategic review
 ↓
Continue / Replan
The DAG may be modified while execution is underway.
Completed work should remain in history even when the active DAG changes.

13. Gates
Gates are points at which the project evaluates whether execution should continue.
Gates should remain conceptually simple.
Potential gate types include:
Validation
Test
Evaluation
Review
Approval
Strategic Review
Risk Review
A gate may produce:
PASS
FAIL
REPLAN
ESCALATE
A gate failure should not necessarily mean the project failed.
It may simply trigger replanning.
For example:
Implementation
      ↓
Evaluation
      ↓
FAIL
      ↓
REPLAN
      ↓
Alternative implementation
Strategic gates should evaluate whether the current approach remains consistent with:
Vision
Intent
Values
Concepts
Goals

14. Agent Autonomy
Humans and agents share the project-management interface.
The system should allow an agent to:
    - create goals;
    - create subgoals;
    - create tasks;
    - create questions;
    - create risks;
    - update answers;
    - update state;
    - modify plans;
    - replan;
    - execute DAG nodes;
    - perform reviews;
    - propose strategic changes.
The system should distinguish between routine and significant decisions.
A simple authority model is preferred:
Routine
    ↓
Agent may perform automatically

Significant
    ↓
Agent may perform and record

Strategic
    ↓
Normally request human approval
Examples of strategic changes:
    - changing major goals;
    - changing the fundamental vision;
    - changing intent;
    - changing important values;
    - fundamentally pivoting the project.
The exact approval model should remain lightweight.

15. YOLO Mode
The extension must support an autonomous/YOLO operating mode.
In YOLO mode, decisions that would normally interrupt the user may be automatically accepted.
However, decisions should still be recorded.
Example:
Pi automatically accepted:

Plan P4 → P5
Reason: scalability experiment invalidated architecture assumption.

Goal G3 abandoned.
Reason: superseded by G7.

Q14 reprioritized from Medium → Critical.
Reason: discovered dependency.
YOLO means:
Don't interrupt me.
It does not mean:
Don't keep a record of what you did.

16. Long-Running Execution
The system must support work lasting:
    - hours;
    - days;
    - potentially weeks.
Execution must not depend on an active conversational Pi session.
A task may enter:
PENDING
RUNNING
BLOCKED
COMPLETED
FAILED
INTERRUPTED
ABANDONED
SUPERSEDED
The system should persist execution state.
A restarted Pi instance should be able to inspect the project and resume/recover execution.
Long-running tasks may involve external resources such as:
Local machine
SSH VM
GPU server
Docker container
Cloud service
External API
The project manager should not become an infrastructure orchestration system.
It should allow work to reference external environments while leaving actual infrastructure management to appropriate tools.

17. Project Scope
A project may be associated with:
    - a Git repository;
    - multiple repositories;
    - a local directory;
    - external machines;
    - external services;
    - arbitrary project resources.
A project is therefore not equivalent to a Git repository.
Git is a useful persistence/history mechanism, but the project abstraction is broader.

18. Workspace
Projects may be grouped into a local workspace.
Conceptually:
Workspace
├── Project A
├── Project B
└── Project C
A project can also exist independently.
The initial implementation should avoid building a complicated hierarchy between projects.
A workspace is primarily a convenient container.

19. Persistence
The preferred architecture is filesystem + Git, rather than requiring a database.
The project should be human-readable outside Pi.
A possible initial structure:
.project/
├── direction.md
├── state.md
├── intelligence.yaml
├── risks.yaml
├── strategy.md
├── plan.yaml
├── decisions/
├── history/
└── runs/
The exact file structure is an implementation detail and may be revised.
The important properties are:
	1	human-readable;
	2	agent-readable;
	3	Git-friendly;
	4	diffable;
	5	portable;
	6	resilient to Pi session loss.
The project should not require the Pi extension to understand its own data.

20. History
The system should retain enough information to reconstruct project evolution.
Important historical events include:
Goal completed
Goal failed
Goal abandoned
Goal superseded
Risk created
Risk resolved
Question answered
Plan changed
Strategy changed
Major decision made
Pivot occurred
Gate failed
Gate passed
Git should provide the low-level history.
The extension should provide a higher-level semantic history.
Example:
PROJECT HISTORY

P1
Initial approach:
Use architecture A.

↓ Experiment E4

P2
Architecture A failed scalability test.

↓ Strategic review

P3
Pivoted to architecture B.

↓ Benchmark

P4
Architecture B validated.

Current:
Implementation underway.
This allows the user to understand not just what files changed, but why the project changed direction.

21. Completion
A project is not considered complete simply because every task in a DAG is finished.
Completion is determined primarily through goals.
A project may finish with a mixture of:
Completed goals
Failed goals
Abandoned goals
Superseded goals
The project should retain these outcomes.
A final project summary should allow the user to see:
Vision

Final State

Goals
✓ Completed
✗ Failed
⊘ Abandoned
↪ Superseded

Major Risks

Major Questions

Major Decisions

Plan Evolution

Lessons / Findings
A project can therefore represent an unsuccessful project honestly without losing the knowledge generated by it.

22. TUI
The TUI is a mandatory part of the initial extension.
The primary interface should provide a project dashboard.
Conceptually:
┌─ PROJECT ──────────────────────────────────────────────┐
│ Autonomous Research Agent                              │
│                                                        │
│ Vision                                                 │
│ Build an autonomous research environment...            │
├─ GOALS ────────────────────────────────────────────────┤
│ ✓ Build prototype                                      │
│ → Autonomous experiment selection                      │
│ → Demonstrate useful research output                   │
│ ✗ Original architecture                                │
├─ STATE ────────────────────────────────────────────────┤
│ Prototype operational; evaluator remains uncertain.    │
├─ RISKS ────────────────────────────────────────────────┤
│ ! Evaluation reliability                    HIGH       │
│ ! Compute cost                              MEDIUM     │
├─ INTELLIGENCE ─────────────────────────────────────────┤
│ ? Does evaluator correlate with humans?     CRITICAL   │
│ ? Can the loop converge reliably?           HIGH       │
├─ ACTIVE PLAN ──────────────────────────────────────────┤
│ ● Benchmark evaluator                                 │
│ ├─ Human comparison                 RUNNING             │
│ ├─ Analyze results                   PENDING            │
│ └─ Strategic review                  BLOCKED            │
└────────────────────────────────────────────────────────┘
The TUI should provide views for:
Dashboard
Direction
Goals
State
Intelligence
Risks
Strategy
Plan / DAG
History
Runs
The interface should remain usable inside Pi's terminal environment.
A future web UI may provide a richer visualization but is explicitly outside the initial scope.

23. Pi Integration
The extension should expose project operations naturally through Pi.
Possible commands:
/project
/project init
/project status
/project direction
/project goals
/project risks
/project intelligence
/project plan
/project history
/project review
/project replan
/project resume
The exact command names are not final.
Natural-language interaction should also be supported.
For example:
"What are our highest priority risks?"
"What's the most important thing we don't know?"
"Replan the next stage."
"Why did we abandon the original architecture?"
"Show me how the plan changed."
"What should we do next?"
These should operate against the same persistent project model.

24. Agent Context
The extension should make the appropriate project context available to Pi without requiring the entire project to be injected into every context window.
At minimum, an agent working on a task should have access to:
Relevant Direction
Relevant Goals
Current State
Relevant Risks
Relevant Intelligence
Current Strategy
Relevant Plan/DAG context
The extension should prefer targeted context over dumping the entire project into the model.
For example, an implementation task should not necessarily receive every historical decision ever made.

25. Replanning Algorithm — Conceptual
When asked to replan, the agent should consider:
1. Vision
2. Intent
3. Values
4. Concepts
5. Goals
6. Current State
7. Highest-priority Intelligence
8. Highest-priority Risks
9. Previous work
10. Current strategy
11. Current plan
12. New evidence
It then proposes:
Updated Strategy
Updated Goals (if necessary)
Updated Questions
Updated Risks
Updated Plan
The agent should prefer the smallest useful plan supported by current knowledge.

26. Non-Goals
The first version should explicitly avoid becoming:
    - Jira;
    - a generic issue tracker;
    - a full enterprise PM system;
    - an infrastructure orchestration system;
    - a replacement for Git;
    - a complex permissions framework;
    - a formal knowledge graph;
    - an elaborate workflow DSL;
    - an autonomous "life management" system;
    - a database-heavy SaaS product.
The extension is primarily:
A persistent project-management and adaptive planning layer for Pi.

27. MVP
The first implementation should be substantially smaller than the complete vision.
MVP primitives
Project
Direction
Goal
State
Question
Risk
Plan
Task
Gate
History
MVP capabilities
	1	Initialize a project.
	2	Define/edit direction.
	3	Create and manage goals.
	4	Maintain current state.
	5	Maintain prioritized intelligence questions.
	6	Maintain prioritized risks.
	7	Create an adaptive DAG.
	8	Execute tasks through Pi.
	9	Persist task state.
	10	Allow DAG modification.
	11	Support basic gates.
	12	Support YOLO/non-YOLO behavior.
	13	Record significant changes.
	14	Display everything through a TUI.
	15	Resume projects after Pi/session interruption.
	16	Show project history and plan evolution.

28. Fundamental User Experience
The ideal interaction should eventually feel like:
Human: Here's what I want to achieve and why.
Pi: Here's what I understand the project to be.
Human: Correct.
Pi: Here's what I think we should do first, and the things I'm most uncertain about.
Human: Go ahead.
Pi: I discovered that our original assumption was wrong. I've stopped the current branch of work, updated the relevant risk and intelligence items, and proposed a new plan.
Human: Continue.
Pi: Done.
Human: What happened while I was away?
Pi: We completed two goals, failed one approach, answered four critical questions, reduced two major risks, and pivoted the implementation from Plan P2 to P4. Here's why.
This is the core experience the extension should optimize for.

29. Core Principle
The system should ultimately answer four questions at any time:
Where are we?
State
Where are we going?
Direction + Goals
What do we currently believe?
Intelligence + Strategy
What are we doing about it?
Plan + DAG
And continuously:
Act → Learn → Update → Replan.
That loop is the heart of the system.
