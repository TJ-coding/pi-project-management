# Plan P1 (v1)

Draft plan

Rationale: Created implicitly when the first node was added.

## Nodes

- [PENDING] N1 TASK — Add rename for the project name {goal:G3 q:Q2}
    Rename without hand-editing project.yaml; keep the id and slug stable unless asked.
- [PENDING] N2 TASK — Show live word counters in entity forms {goal:G2}
    Count words and characters while typing, so a save is never refused by surprise.
- [COMPLETED] N3 INVESTIGATION — Decide the digest shape without dropping facts {goal:G3 q:Q1}
    Work out what the digest must carry and what moves to /project status.
    outputs: A capped NEXT list names how many ready nodes it hid and where to read them; Digest answers Q1; test asserts the pointer appears only when something is hidden
- [PENDING] N4 REVIEW — k3 sign-off on the frames (after N1, N2, N3) {goal:G1 risk:R1}
    Frames at 40, 80 and 120 columns, tests green, smoke green, k3 says stop.
- [PENDING] N5 TASK — Forward options in every mutation {risk:R4}
    Pass MutateOptions through so commit:false really skips the commit; cover it with a test that runs two mutations and checks git log stays clean.
- [PENDING] N6 TASK — Draw DAG depth and parents {goal:G5}
    Show each node's depth and parents in the plan panel, in the same pane.
- [PENDING] N7 INVESTIGATION — Audit the 11 panels and features (after N6) {goal:G4}
    Name the reason each panel and feature exists; propose removals with evidence.
- [PENDING] N8 TASK — Reorder the panel rail (after N7) {goal:G8}
    Order panels by hierarchy and use, then remove what N7 found unused.
- [PENDING] N9 TASK — Offer to fill empty goal fields on save (after N2) {goal:G6 risk:R5}
    When a goal edit saves, offer to fill empty derived fields and write the accepted ones.
- [PENDING] N10 TASK — Publish the repo to GitHub (after N4) {goal:G7 risk:R6}
    Create a public GitHub repo, push, and confirm the checks pass from a clean clone.
- [PENDING] N11 TASK — Confirm before discarding a dirty form {goal:G9}
    Esc on a form with unsaved changes asks before discarding; unchanged forms close at once.
- [PENDING] N12 TASK — Add start and pause for the project {goal:G10 q:Q6}
    Add meta.paused plus a resume note; surface it in the digest, widget and status line.

## Edges

N1 -> N4
N2 -> N4
N3 -> N4
N6 -> N7
N7 -> N8
N2 -> N9
N4 -> N10
