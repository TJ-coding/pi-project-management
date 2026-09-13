# Plan P1 (v1)

Draft plan

Rationale: Created implicitly when the first node was added.

## Nodes

- [PENDING] N1 TASK — Add rename for the project name {goal:G3 q:Q2}
    Rename without hand-editing project.yaml; keep the id and slug stable unless asked.
- [PENDING] N2 TASK — Show live word counters in entity forms {goal:G2}
    Count words and characters while typing, so a save is never refused by surprise.
- [PENDING] N3 INVESTIGATION — Decide the digest shape without dropping facts {goal:G3 q:Q1}
    Work out what the digest must carry and what moves to /project status.
- [PENDING] N4 REVIEW — k3 sign-off on the frames (after N1, N2, N3) {goal:G1 risk:R1}
    Frames at 40, 80 and 120 columns, tests green, smoke green, k3 says stop.
- [PENDING] N5 TASK — Forward options in every mutation {risk:R4}
    Pass MutateOptions through so commit:false really skips the commit; cover it with a test that runs two mutations and checks git log stays clean.

## Edges

N1 -> N4
N2 -> N4
N3 -> N4
