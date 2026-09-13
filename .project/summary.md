# Pi Project — Project Summary

## Vision

Project management tool to manage Agent's project that lasts from weeks to months. Zero stress for humans, it's almost like playing a strategy game. Human and agent in complete sync on where we are and where we are going.

## Intent

Improve project maangement capability, and better utilize idle time, and allow agent to work on projects more autonomously.

## Final State

Seeded from the ACL26 review history. N1-N4 are ready; RUN1 tracks the k3 loop. Open: this project is shadowed by $HOME/.project, so sessions must start inside the repo.

## Goals

- → G1 Keep every panel readable at 80 columns (ACTIVE)
- → G2 Enforce brevity on every write (ACTIVE)
- → G3 Close the two known gaps (ACTIVE)
- → G4 Minimalism (ACTIVE)
- → G5 Visual DAG (ACTIVE)

## Major Risks

- R2 This project is shadowed by $HOME/.project — exposure 0.90 x 0.30, status OPEN
- R4 commit:false is ignored by several mutations — exposure 0.80 x 0.20, status OPEN
- R1 A panel regression ships without review — exposure 0.30 x 0.50, status OPEN
- R3 Budgets block legitimate long content — exposure 0.30 x 0.40, status OPEN

## Major Questions

- Q1 What belongs in the digest when long values cannot fit? — UNKNOWN (HIGH)
- Q2 Should rename touch only meta.name, or ids and paths too? — UNKNOWN (MEDIUM)
- Q3 Do budgets need per-project overrides in project.yaml? — UNKNOWN (MEDIUM)

## Major Decisions

- D1 Improve this extension through the k3 review loop (SIGNIFICANT)
- D2 Keep project state in the repo, committed with the code (ROUTINE)

## Plan Evolution

- P1 (v1) Draft plan

## Lessons / Findings

_None recorded._
