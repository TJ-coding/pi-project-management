# Pi Project — Project Summary

## Vision

Project management tool to manage Agent's project that lasts from weeks to months. Zero stress for humans, it's almost like playing a strategy game. Human and agent in complete sync on where we are and where we are going.

## Intent

Improve project maangement capability, and better utilize idle time, and allow agent to work on projects more autonomously.

## Final State

All 15 goals closed (14 COMPLETED, G15 the smoke artifact archived). R7 resolved: goal links now resolve against the active plan. 167 tests pass, TUI smoke passes, published at 0c9106f and verified from a clean clone. N18 is waiting only on the k3 round-2 frame review.

## Goals

- ✓ G1 Keep every panel readable at 80 columns (COMPLETED)
- ✓ G2 Enforce brevity on every write (COMPLETED)
- ✓ G3 Close the two known gaps (COMPLETED)
- ✓ G4 Minimalism (COMPLETED)
- ✓ G5 Visual DAG (COMPLETED)
- ✓ G6 Auto complete / Propagate (COMPLETED)
- ✓ G7 Upload the project to github repository (COMPLETED)
- ✓ G8 Reconsider ordering of panels. (COMPLETED)
- ✓ G9 Warn when exiting change without saving. (COMPLETED)
- ✓ G10 Start / Pause Project (COMPLETED)
- ✓ G11 Progress percent on tasks and goals (COMPLETED)
- ✓ G12 Archive anything (COMPLETED)
- ✓ G13 Phone view of all projects (COMPLETED)
- ✓ G14 One persistent objective (COMPLETED)
- → G15 Validate tools (ACTIVE)

## Major Risks

- R5 Propagation overwrites human text — exposure 0.40 x 0.40, status OPEN
- R1 A panel regression ships without review — exposure 0.30 x 0.50, status OPEN
- R3 Budgets block legitimate long content — exposure 0.30 x 0.40, status OPEN
- R2 This project is shadowed by $HOME/.project — exposure 0.00 x 0.30, status RESOLVED
- R4 commit:false is ignored by several mutations — exposure 0.80 x 0.20, status RESOLVED
- R6 Publishing leaks secrets or private project data — exposure 0.02 x 0.70, status RESOLVED
- R7 Id lookups cross plan versions — exposure 0.05 x 0.60, status RESOLVED

## Major Questions

- Q1 What belongs in the digest when long values cannot fit? — UNKNOWN (HIGH)
- Q10 What does done mean for G13 and G14? — ANSWERED (MEDIUM)
- Q6 Is pause a new status or a view of existing state? — ANSWERED (LOW)
- Q4 Which panels can go without losing a spec requirement? — ANSWERED (LOW)
- Q2 Should rename touch only meta.name, or ids and paths too? — ANSWERED (LOW)
- Q5 Does the tree or git history hold anything unfit to publish? — ANSWERED (LOW)
- Q7 Hierarchy or frequency for the panel rail order? — ANSWERED (LOW)
- Q8 Should the rail drop to ten views so every key works? — ANSWERED (LOW)

## Major Decisions

- D1 Improve this extension through the k3 review loop (SIGNIFICANT)
- D2 Keep project state in the repo, committed with the code (ROUTINE)
- D3 Absorb the six new goals into the plan (SIGNIFICANT)
- D4 Remove the other project's name from live state (ROUTINE)
- D5 Verify the uncommitted active-plan fix (SIGNIFICANT)
- D6 Redact paths, not names (SIGNIFICANT)

## Plan Evolution

- P1 (v1) Draft plan → superseded by P2
- P2 (v2) P2 — close the eight open goals
    why: Four goals are already implemented but unclosed; three need building; G13 depends on the aggregation work in G14.

## Lessons / Findings

- A `git push` can hang forever in git-credential-osxkeychain with no output; push with the gh token to avoid it.
- k3's frame review finds defects tests cannot see: its first pass found 8, including four panels disagreeing about the same count.
- Q9 CONFIRMED: No lookup leaks across plans now. The two that did are fixed: node mutations prefer the active plan, and goal links resolve against it.
