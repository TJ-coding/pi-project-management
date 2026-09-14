# Plan P2 (v2)

P2 — close the eight open goals

Rationale: Four goals are already implemented but unclosed; three need building; G13 depends on the aggregation work in G14.

## Nodes

- [COMPLETED] N13 REVIEW — Audit and close the met goals
    Confirm G1, G2, G5 and G9 against their success criteria and close the ones already met.
    outputs: G1 closed: width test at 40/80/120 covers all views, reading pane tested, k3 PASS in gate N4; G2 closed: over-budget write rejected, grandfathering tested, digest prints the budgets live; G5 closed: parents render in the node row and depth in the detail pane; G9 closed: dirty form prompts, clean form closes at once, only y/enter discard
- [COMPLETED] N14 TASK — Add progress percent (after N13) {goal:G11}
    Add percent to node and goal, show it in the plan panel, refuse out-of-range values.
    outputs: percent is number|null on both Goal and PlanNode, round-tripping through the YAML; Out-of-range writes throw before anything is saved and the old value survives; Row shows a percent badge, reading pane and forms show the bar; 129 tests pass (10 new), TUI smoke passes
- [COMPLETED] N15 TASK — Add archiving (after N13) {goal:G12}
    Add meta.archived plus archive/unarchive commands; archived items leave active counts but stay readable.
    outputs: archived is a boolean on goals, questions, risks and nodes; never a status; Archived items leave active counts but keep their record and links; Panels state how many are hidden and v toggles them back without writing; Archiving a node does not rewire the DAG for its dependants; 138 tests pass (9 new), TUI smoke passes
- [COMPLETED] N16 TASK — Add a persistent objective (after N13) {goal:G14}
    Add one objective sentence per project, shown in the digest with progress and done-when.
    outputs: meta.objective plus objectiveSetAt, round-tripping through project.yaml; The digest leads with OBJECTIVE and OBJECTIVE PROGRESS naming what done means; project_objective tool, /project objective command, dashboard and widget; Changing it is recorded in history with the previous value; 146 tests pass (8 new), command smoke and TUI smoke pass
- [RUNNING] N17 TASK — Serve a phone dashboard (after N16) {goal:G13}
    Serve a read-only page listing all projects, their current task and aggregated pending decisions.
- [PENDING] N18 REVIEW — Verify and publish everything (after N14, N15, N16, N17)
    Full check, TUI smoke, k3 frame review, then push and verify from a clean clone.

## Edges

N13 -> N14
N13 -> N15
N13 -> N16
N16 -> N17
N14 -> N18
N15 -> N18
N16 -> N18
N17 -> N18

## Plan Changes

- 2026-09-14T10:35:38.403Z P1 -> P2: Four goals are already implemented but unclosed; three need building; G13 depends on the aggregation work in G14.
