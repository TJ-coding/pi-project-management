# Pi Project — Project Summary

## Vision

Project management tool to manage Agent's project that lasts from weeks to months. Zero stress for humans, it's almost like playing a strategy game. Human and agent in complete sync on where we are and where we are going.

## Intent

Improve project maangement capability, and better utilize idle time, and allow agent to work on projects more autonomously.

## Final State

All 12 nodes done and G7/G3/G10/G4/G6/G8/G1 are closed. The repo is public at github.com/TJ-coding/pi-project-management: 119 tests pass from a clean clone. Eight goals remain open (G2, G5, G9, G11-G14); R7 is the known correctness gap.

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

- R7 Id lookups cross plan versions — exposure 0.35 x 0.60, status OPEN
- R5 Propagation overwrites human text — exposure 0.40 x 0.40, status OPEN
- R1 A panel regression ships without review — exposure 0.30 x 0.50, status OPEN
- R3 Budgets block legitimate long content — exposure 0.30 x 0.40, status OPEN
- R2 This project is shadowed by $HOME/.project — exposure 0.00 x 0.30, status RESOLVED
- R4 commit:false is ignored by several mutations — exposure 0.80 x 0.20, status RESOLVED
- R6 Publishing leaks secrets or private project data — exposure 0.02 x 0.70, status RESOLVED

## Major Questions

- Q1 What belongs in the digest when long values cannot fit? — UNKNOWN (HIGH)
- Q10 What does done mean for G13 and G14? — ANSWERED (MEDIUM)
- Q6 Is pause a new status or a view of existing state? — ANSWERED (LOW)
- Q9 Do any other lookups resolve an id across plan versions? — ANSWERED (LOW)
- Q4 Which panels can go without losing a spec requirement? — ANSWERED (LOW)
- Q2 Should rename touch only meta.name, or ids and paths too? — ANSWERED (LOW)
- Q5 Does the tree or git history hold anything unfit to publish? — ANSWERED (LOW)
- Q7 Hierarchy or frequency for the panel rail order? — ANSWERED (LOW)

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

- A text dump embedded with image syntax renders as a broken image on GitHub; fenced code preserves the TUI layout.
