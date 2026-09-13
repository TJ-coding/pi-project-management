# Spec → implementation mapping

Traceability for [`spec/project-management-spec.md`](project-management-spec.md).
Every row names the implementation and the evidence that verifies it.

Evidence shorthand:

- `unit:` `test/*.test.ts` (node's test runner)
- `e2e:` `scripts/rpc-smoke.mjs` (real `pi --mode rpc`, real model, 19 tools)
- `tui:` `scripts/tui-smoke.py` (real `pi` in a pty)

| Spec | Requirement | Implementation | Evidence |
|---|---|---|---|
| 2.4 | Human and agent symmetry: humans can create goals/tasks, change plans, answer questions, create risks, modify direction | All operations exist as `project_*` tools for the agent and as direct human paths: form-based editing in the dashboard (`e`) or `/project edit <section>`, plus raw text editing (`E`, `raw`) through the same validation/history/Git path (`form.ts`, `entity-forms.ts`, `editing.ts`, `project.ts::replace*`/`delete*`) | unit: editing (round-trip per section, history, rejection, strategic approval), entity-forms (save/create/delete/link cleanup, computed exposure/score, document forms), form (navigation, inline edits, lists, link pickers, required fields); tui: real terminal creates a goal through the form and verifies the file, rejects invalid raw YAML |
| 3 | Six conceptual areas + iterative loop | `types.ts`, `format.ts::renderStatusText`, `context.ts::buildDigest`, `dashboard.ts` | unit: project/dashboard, e2e |
| 4.1 | Vision as prose, changes rarely | `Direction.vision`, `project_direction`, `direction.md` | unit: storage, e2e |
| 4.2 | Intent answers "why" | `Direction.intent`, direction view | unit: storage/context |
| 4.3 | Values guide decisions | `Direction.values`, injected digest, `before_agent_start` | unit: storage/context |
| 4.4 | Typed, arbitrary concepts | `Concept{type,text}`, `parseConcepts`/`renderConcepts` | unit: storage |
| 4.5 | Goals: description, priority, success criteria, status, parent, links; ACTIVE/COMPLETED/FAILED/ABANDONED/SUPERSEDED | `Goal`, `project_goal`, `setGoalStatus` | unit: project lifecycle, storage round-trip |
| 4.5 | Agents may propose goals; major changes recorded | `createGoal`, history `goal.created`, decisions | unit: project, e2e |
| 5 | Deliberately lightweight initial + current state | `ProjectState`, `project_state`, `state.md` | unit: storage/project |
| 6 | Intelligence primitive = question with answer/priority/confidence/evidence/status; UNKNOWN answer valid | `Question`, `intelligence.yaml`, `project_question`, `answerQuestion` | unit: storage/scoring/project |
| 6.1 | Priority = importance × uncertainty × decision impact; "most important thing we don't know" | `scoring.ts::questionScore`, `byQuestionPriority`; surfaced in `project_status`, digest, TUI | unit: scoring/project |
| 6 | Questions link to goals/risks/tasks/decisions/evidence | `Question.goals/risks/tasks/decisions/evidence`; validation checks links | unit: project/validate |
| 7 | Risk registry with probability, impact, exposure, status, mitigation, contingency, links | `Risk`, `riskExposure`, `project_risk`, `risks.yaml` | unit: scoring/storage/project |
| 7 | Prioritized risk registry ("how can this project fuck up") | `byRiskPriority`, TUI risks view, status report | unit: scoring/dashboard |
| 8 | Intelligence and risk linked; answering updates risk | `propagateQuestionToRisks` (called by `project_question answer` by default) | unit: project ("propagate into linked risk estimates") |
| 9 | Strategy: approach, hypotheses, priorities, rationale, alternatives; significant changes recorded | `Strategy`, `project_strategy`, `strategy.changed` history | unit: storage/project |
| 10 | Plans as hypotheses; goal → subgoal → DAG → tasks/investigations/experiments/decisions; depth justified by certainty | `Plan`/`PlanNode`, `analyzeReplan` (shallow plans), `Goal.parent` subgoals | unit: project/replan, e2e |
| 11 | Adaptive planning preserves previous plans and records prev/new/reason/trigger | `PlansFile.plans` + `.changes`, `plan.yaml`, `renderPlanEvolutionText`, TUI summary view | unit: project replanning, history |
| 12 | DAG node kinds, dependencies, status, description, outputs, failure reason, goal/risk/question links, modifiable during execution | `NODE_TYPES`, `PlanNode`, `project_plan`, `dag.ts`, plus the TUI DAG browser (`planGroups`/`renderPlanInteractive`) and node form (`nodeForm`) with dependency pickers, cycle-rejecting validation and delete-with-unlink | unit: dag, storage, dashboard (groups/cursor/actions), entity-forms (node form, cycle rejection), e2e; tui: real terminal opens the node form from the plan |
| 13 | Gates with types, PASS/FAIL/REPLAN/ESCALATE, failure triggers replan | `GATE_TYPES`, `project_gate`, `evaluateGate`, `Plan.gates` | unit: project gates, e2e |
| 13 | Strategic gates compare with vision/intent/values/concepts/goals | `renderReviewReport`, `project_review`, `/project review` | unit: reports; e2e `project_review` |
| 14 | Humans and agents share the interface; routine/significant/strategic authority | `checkAuthorization`, `withApproval`, `AuthorityLevel`, all `project_*` tools, plus human editing via `editing.ts` | unit: project ("strategic … require approval"), editing (strategic edit needs approval unless YOLO), e2e, tui |
| 15 | YOLO auto-accepts but records ("Pi automatically accepted …") | `meta.yolo`, `checkAuthorization`, history summaries; `/project yolo`, `project_init(yolo)` | unit: project (direction + goal YOLO), e2e |
| 16 | Long-running work independent of the session; full task status vocabulary; persisted; resumable | `Run`, `runs/RUN*.yaml`, `spawnDetached`, `project_run`, `project_resume`, `reconcileRuns`, `session_start` stale-run warning | unit: project runs/reconcile; e2e (detached `echo` run + completed run) |
| 16 | External resources referenced, not orchestrated | `ExternalRef`, `Run.environment`, `meta.resources`, `project_resource` | unit: storage/project/tools; e2e (`ssh` ref + `gpu` resource) |
| 17 | Project scope: repos, directories, machines, services, resources | `meta.repositories`, `meta.resources`, `project_resource`, `root` | unit: storage, tools; e2e |
| 18 | Local workspace grouping without complex hierarchy | `registerInWorkspace`, `loadWorkspace`, `/project projects`, `~/.pi/agent/project-manager.json` | unit: storage; smoke (init with workspace) |
| 19 | Filesystem + Git persistence, human readable, diffable, portable | `storage.ts` (atomic writes, derived documents), `commitProjectChanges` | unit: storage round-trip/idempotence, hand-edited files |
| 20 | Semantic history plus Git low-level history; reconstruct evolution | `HistoryEvent`, `history/events.jsonl`, `history/history.md`, `planEvolution`, `/project history`, `/project evolution` | unit: history, project |
| 21 | Completion via goals; final summary with honest outcomes | `project_complete`, `renderCompletionSummary`, `summary.md`, summary view | unit: project completion, history; e2e `project_review`/summary view |
| 22 | TUI is mandatory: dashboard + Direction/Goals/State/Intelligence/Risks/Strategy/Plan/History/Runs views | `dashboard.ts`: 11 views in bordered **containers** (`sectionHeader`/`containerRow`/`containerNote`/`containerClose`) so grouping is explicit, named view rail with count badges, 3-line quiet chrome, DAG browser with detail pane, **row cursor + full-text reading pane** (`rows`/`detail`/`renderViewLines`/`renderDetailDoc`: `Enter` on a row shows the untruncated entity wrapped and scrollable, so long goals/questions/risks/state/strategy are readable at any width), widget + footer status, and a documented 4-level emphasis system with one focal point per screen | unit: dashboard (all views, width, navigation, chrome height, containers open/close balance, named rail vs counted rail, plan cursor/actions, scroll reporting, **reading pane** for a row and for a prose section, cursor-driven row selection, wrapping bounds), form (single highlighted focused row); tui: real terminal in a pty with exact pyte frames on an empty and a content-rich project, including the plan browser, the node form and the reading pane |
| 23 | `/project …` commands + natural language | `commands.ts`: `SUBCOMMAND_INFO` is the single source of truth for `/project help [sub]`, `/project tools` and Tab completion (with descriptions); the browser's `?` shows the same reference in-place | tui/`rpc-commands` script (24 commands incl. help/tools), e2e, `pi -p "/project status"` |
| 24 | Targeted context instead of dumping the project | `context.ts::buildTargetedContext`, `buildDigest` (every capped list — e.g. `NEXT` ready nodes — states how many entries it hid and where to read them, so the injected digest never looks complete while withholding work), `project_context` | unit: project context; e2e: a natural-language question was answered correctly with **no tool calls** purely from the injected digest (node N1, question Q1, risk R1) |
| 25 | Replanning considers the 12 inputs and proposes updated strategy/goals/questions/risks/plan | `replan.ts::analyzeReplan` + `buildRecommendations`, `reports.ts::renderReplanAnalysis`, `project_replan` | unit: reports (all 12 headings), project replanning |
| 25 | Prefer the smallest useful plan supported by current knowledge | `analyzeReplan` carries only justified work and adds ≤3 investigations + review | unit: project replanning |
| 26 | Explicit non-goals (no Jira/orchestrator/DB/permissions DSL) | No database, no workflow DSL; single small authority model; runs only reference external environments | reviewed in code (README "How the loop works") |
| 27 | MVP primitives | Project, Direction, Goal, State, Question, Risk, Plan, Task, Gate, History — `types.ts` | unit: storage |
| 27 | MVP capabilities 1–16 | init ✔, direction ✔, goals ✔, state ✔, intelligence ✔, risks ✔, adaptive DAG ✔, execute via Pi ✔, persisted task state ✔ (`project_plan node_status`), DAG modification ✔, gates ✔, YOLO ✔, recorded changes ✔, TUI ✔, resume ✔, history/plan evolution ✔ | e2e (16 tools), tui, unit |
| 28 | Core experience (here's what I understand… what happened while away) | `before_agent_start` digest, `goalGlyph`/status reports, `summarizeSince` + `project_history away` | unit: history; e2e |
| 29 | Four questions + Act→Learn→Update→Replan loop | `renderStatusText`, `buildDigest`, `/project status` | unit: project/context |

## Known deliberate limitations

- The TUI is plain text; a web UI is explicitly outside the initial scope (spec 22).
- External environments are referenced (ssh/docker/gpu/cloud/api), never
  provisioned or orchestrated (spec 16, 26).
- No formal approval workflow engine: three authority levels plus YOLO, recorded
  in `decisions/` and `history/` (spec 14).
- YAML is written by the extension and read tolerantly (comments, CRLF, string
  numbers, hand edits) but the writer normalises formatting (spec 19).
