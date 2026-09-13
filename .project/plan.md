# Plan P1 (v1)

Draft plan

Rationale: Created implicitly when the first node was added.

## Nodes

- [COMPLETED] N1 TASK — Add rename for the project name {goal:G3 q:Q2}
    Rename without hand-editing project.yaml; keep the id and slug stable unless asked.
    outputs: project_rename tool and /project rename subcommand; Rename touches meta.name and slug only; ids and paths unchanged (Q2); Empty name refused; same-name rename is a no-op
- [COMPLETED] N2 TASK — Show live word counters in entity forms {goal:G2}
    Count words and characters while typing, so a save is never refused by surprise.
    outputs: Focused form row shows words/chars against its budget and flips to ⚠ when over; Counter reads the edit buffer, so the warning precedes the rejected save; 25 entity-form fields declare a budget
- [COMPLETED] N3 INVESTIGATION — Decide the digest shape without dropping facts {goal:G3 q:Q1}
    Work out what the digest must carry and what moves to /project status.
    outputs: A capped NEXT list names how many ready nodes it hid and where to read them; Digest answers Q1; test asserts the pointer appears only when something is hidden
- [PENDING] N4 REVIEW — k3 sign-off on the frames (after N1, N2, N3) {goal:G1 risk:R1}
    Frames at 40, 80 and 120 columns, tests green, smoke green, k3 says stop.
- [COMPLETED] N5 TASK — Forward options in every mutation {risk:R4}
    Pass MutateOptions through so commit:false really skips the commit; cover it with a test that runs two mutations and checks git log stays clean.
    outputs: All 37 mutate call sites forward options; Regression test: every mutation with commit:false leaves HEAD unmoved; updateDirection, recordDecision and setNodeStatus were the last three leaks
- [COMPLETED] N6 TASK — Draw DAG depth and parents {goal:G5}
    Show each node's depth and parents in the plan panel, in the same pane.
    outputs: Node rows carry parent ids (←N1✓) in a fixed column; links are never displaced; Selection pane names the ancestry chain at depth > 1; Dashboard says RUNNING or NEXT UP, not an ambiguous NOW; Two k3 review rounds; the second found a real badge-loss bug that is now tested
- [COMPLETED] N7 INVESTIGATION — Audit the 11 panels and features (after N6) {goal:G4}
    Name the reason each panel and feature exists; propose removals with evidence.
    outputs: Q4 answered: no panel is removable; each owns records nothing else shows; Summary no longer repeats History's plan reasons (22 -> 15 lines); Test asserts the reason appears in History and not in Summary
- [COMPLETED] N8 TASK — Reorder the panel rail (after N7) {goal:G8}
    Order panels by hierarchy and use, then remove what N7 found unused.
    outputs: Rail ordered by hierarchy with a documented grouping; 0 reaches the tenth view; the eleventh no longer advertises a dead key; TUI smoke finds views by name, so reorders cannot break it
- [RUNNING] N9 TASK — Offer to fill empty goal fields on save (after N2) {goal:G6 risk:R5}
    When a goal edit saves, offer to fill empty derived fields and write the accepted ones.
- [PENDING] N10 TASK — Publish the repo to GitHub (after N4) {goal:G7 risk:R6}
    Create a public GitHub repo, push, and confirm the checks pass from a clean clone.
- [COMPLETED] N11 TASK — Confirm before discarding a dirty form {goal:G9}
    Esc on a form with unsaved changes asks before discarding; unchanged forms close at once.
    outputs: Inline discard prompt on a dirty form; clean forms close at once; Only y/enter discard, so a stray key cannot lose work; Reverting a field edit counts as clean again
- [COMPLETED] N12 TASK — Add start and pause for the project {goal:G10 q:Q6}
    Add meta.paused plus a resume note; surface it in the digest, widget and status line.
    outputs: meta.paused/pausedAt/resumeNote with project_pause tool and /project pause|start; Resume note defaults to the next ready node; Paused shows in digest, widget and status line; resume clears it

## Edges

N1 -> N4
N2 -> N4
N3 -> N4
N6 -> N7
N7 -> N8
N2 -> N9
N4 -> N10
