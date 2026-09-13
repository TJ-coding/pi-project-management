# Pi Project — Project Summary

## Vision

Project management tool to manage Agent's project that lasts from weeks to months. Zero stress for humans, it's almost like playing a strategy game. Human and agent in complete sync on where we are and where we are going.

## Intent

Improve project maangement capability, and better utilize idle time, and allow agent to work on projects more autonomously.

## Final State

6 of 11 original nodes done (N1, N2, N3, N5, N6, N11) plus N12 for G10. G3 and G10 closed; R4 resolved. 108 tests, TUI smoke and a pause round-trip pass. Ready: N7, N9; N4/N10 blocked behind reviews and publishing.

## Goals

- → G1 Keep every panel readable at 80 columns (ACTIVE)
- → G2 Enforce brevity on every write (ACTIVE)
- → G3 Close the two known gaps (ACTIVE)
- → G4 Minimalism (ACTIVE)
- → G5 Visual DAG (ACTIVE)
- → G6 Auto complete / Propagate (ACTIVE)
- → G7 Upload the project to github repository (ACTIVE)
- → G8 Reconsider ordering of panels. (ACTIVE)
- → G9 Warn when exiting change without saving. (ACTIVE)
- ✓ G10 Start / Pause Project (COMPLETED)

## Major Risks

- R5 Propagation overwrites human text — exposure 0.40 x 0.40, status OPEN
- R1 A panel regression ships without review — exposure 0.30 x 0.50, status OPEN
- R3 Budgets block legitimate long content — exposure 0.30 x 0.40, status OPEN
- R6 Publishing leaks secrets or private project data — exposure 0.10 x 0.70, status MITIGATING
- R2 This project is shadowed by $HOME/.project — exposure 0.00 x 0.30, status RESOLVED
- R4 commit:false is ignored by several mutations — exposure 0.80 x 0.20, status RESOLVED

## Major Questions

- Q1 What belongs in the digest when long values cannot fit? — UNKNOWN (HIGH)
- Q4 Which panels can go without losing a spec requirement? — UNKNOWN (MEDIUM)
- Q6 Is pause a new status or a view of existing state? — ANSWERED (LOW)
- Q2 Should rename touch only meta.name, or ids and paths too? — ANSWERED (LOW)
- Q5 Does the tree or git history hold anything unfit to publish? — ANSWERED (LOW)
- Q3 Do budgets need per-project overrides in project.yaml? — ANSWERED (LOW)

## Major Decisions

- D1 Improve this extension through the k3 review loop (SIGNIFICANT)
- D2 Keep project state in the repo, committed with the code (ROUTINE)
- D3 Absorb the six new goals into the plan (SIGNIFICANT)
- D4 Remove the other project's name from live state (ROUTINE)

## Plan Evolution

- P1 (v1) Draft plan

## Lessons / Findings

- project_plan add_node ignores an explicit id, so node ids are assigned in insertion order.
- No credentials anywhere in the tracked tree or git history, so G7 is safe to publish.
