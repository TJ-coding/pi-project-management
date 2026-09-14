# Plan P2 (v2)

P2 — close the eight open goals

Rationale: Four goals are already implemented but unclosed; three need building; G13 depends on the aggregation work in G14.

## Nodes

- [RUNNING] N13 REVIEW — Audit and close the met goals
    Confirm G1, G2, G5 and G9 against their success criteria and close the ones already met.
- [PENDING] N14 TASK — Add progress percent (after N13) {goal:G11}
    Add percent to node and goal, show it in the plan panel, refuse out-of-range values.
- [PENDING] N15 TASK — Add archiving (after N13) {goal:G12}
    Add meta.archived plus archive/unarchive commands; archived items leave active counts but stay readable.
- [PENDING] N16 TASK — Add a persistent objective (after N13) {goal:G14}
    Add one objective sentence per project, shown in the digest with progress and done-when.
- [PENDING] N17 TASK — Serve a phone dashboard (after N16) {goal:G13}
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
