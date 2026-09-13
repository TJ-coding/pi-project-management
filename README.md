# pi-project-management

A Pi extension that adds a **persistent project-management and adaptive-planning
layer** above individual Pi sessions, so humans and agents can run a project for
hours, days or weeks together.

> Direction is relatively stable. Plans are hypotheses. Execution generates
> information. New information changes the plan.

This repository implements the specification in
[`spec/project-management-spec.md`](spec/project-management-spec.md). Every
concept in the spec (Direction, State, Intelligence, Risks, Strategy, Plan/DAG,
Gates, History, YOLO, long-running runs, workspace, completion) is implemented
and tested — see [`docs/SPEC-MAPPING.md`](docs/SPEC-MAPPING.md) for the
requirement-by-requirement traceability.

![Dashboard in a real Pi terminal](docs/dashboard-tui.txt)

## Install

```bash
# from a local checkout (recommended while developing)
pi install /path/to/pi-project-management

# or try it without installing
pi -e /path/to/pi-project-management/src/index.ts

# verify, then remove if you change your mind
pi list
pi remove /path/to/pi-project-management
```

The package declares `pi.extensions = ["./src/index.ts"]`, so `pi install` also
installs its runtime dependency (`yaml`).

## Quick start

Inside any directory:

```
/project init          # create .project/, optionally describe vision + intent
/project               # open the dashboard (TUI)
```

Then simply talk to the agent:

> Here's what I want to achieve and why.
> …
> Go ahead.

The agent reads the project through `project_*` tools, records goals, questions,
risks, strategy, a minimal plan and its execution state. Come back later and run
`/project resume` or ask:

> What happened while I was away?

## What gets stored

```
<project>/.project/
├── project.yaml        # metadata: name, yolo, workspace, repos, active plan
├── direction.md        # vision / intent / values / concepts
├── goals.yaml          # goals with priority, success criteria, status, links
├── state.md            # initial state + current state + capabilities, facts, ...
├── intelligence.yaml   # questions: answer, status, importance/uncertainty/impact, evidence
├── risks.yaml          # risks: probability, impact, status, mitigation, contingency
├── strategy.md         # approach, hypotheses, priorities, rationale, alternatives
├── plan.yaml           # active plan + all previous plans + why they changed
├── plan.md             # derived human-readable DAG sketch
├── summary.md          # derived project summary (goals, risks, decisions, lessons)
├── decisions/D1.md     # one file per decision (YAML front matter + prose)
├── history/events.jsonl # append-only semantic history
├── history/history.md  # derived narrative history
└── runs/RUN1.yaml      # one file per run (+ RUN1.log for detached processes)
```

Everything is plain markdown, YAML and JSONL: readable, diffable, Git-friendly
and editable by hand. If the project lives in a Git repository the extension
auto-commits `.project/` changes (disable via `autoCommit` in `project.yaml`).

## Commands

| Command | Purpose |
|---|---|
| `/project` | open the dashboard |
| `/project init [name]` | initialize a project here |
| `/project edit <section>` | edit a section as text (direction, state, strategy, goals, intelligence, risks, plan) |
| `/project status` | the four core questions: where we are / going / believe / doing |
| `/project direction` `/goals` `/state` `/intelligence` `/risks` `/strategy` | per-area views |
| `/project plan` | active DAG, readiness, gate results |
| `/project history` `/evolution` | semantic history and how the plan changed |
| `/project runs` | long-running work records |
| `/project summary` | final summary: goal outcomes, risks, decisions, lessons |
| `/project review` | strategic review against direction, goals and plan readiness |
| `/project replan [apply]` | analyze (and optionally apply) the smallest useful plan |
| `/project resume` | inspect unfinished work after an interruption |
| `/project yolo [on\|off]` | auto-accept strategic decisions (still recorded) |
| `/project complete` | mark the project complete and render the summary |
| `/project watch [on\|off]` | toggle the editor widget |
| `/project projects` | list projects in the local workspace |
| `/project tools` | list the `project_*` tools the agent can call |
| `/project help [sub]` | full reference, or details for one subcommand |
| `/pm` | shorthand for `/project` |

Discovery, without leaving the TUI: press `?` inside the dashboard for the same
reference, and type `/project ` then Tab for subcommands with descriptions.

## Editing directly (human operations)

Humans and agents share the same operations (spec 2.4). Besides asking the agent,
you can edit the project yourself:

- **In the dashboard:** press **`e`** on Direction, State, Strategy, Goals,
  Intelligence, Risks or Plan.
- **By command:** `/project edit goals`, `/project edit direction`, …
- **In your own editor:** the section's on-disk text is loaded into Pi's editor;
  `Ctrl+G` opens `$EDITOR` for larger YAML edits.

Editor keys: **Enter** save · **Shift+Enter** newline · **Esc** cancel ·
**Ctrl+G** external editor.

Saving goes through exactly the same path as an agent change: the text is parsed,
new structural errors are rejected (with your text kept so you can fix it),
strategic changes (vision/intent/values) ask for confirmation, and the change is
recorded in history and committed to Git. Editing `markdown` sections shows the
format of `direction.md`/`state.md`/`strategy.md`; the YAML sections show
`goals.yaml`/`intelligence.yaml`/`risks.yaml`/`plan.yaml`. Keep existing `id`s to
preserve links.

While the dashboard is open: `tab`/arrows switch views, `1-9` jump, `j`/`k` or
arrows scroll, `space`/`pgdn` page, `g`/`G` jump to the top/bottom, `e` edit the
current section, `?` show the command/tool reference, `r` reload from disk, `q`
close. The footer always shows the visible line range, e.g.
`↓ Risks  Lines 7-29/45 · j/k ↑↓ scroll · …`, or `nothing more to scroll` when
the view already fits.

## Tools available to the agent

`project_init`, `project_status`, `project_context`, `project_direction`,
`project_goal`, `project_state`, `project_question`, `project_risk`,
`project_strategy`, `project_plan`, `project_gate`, `project_decision`,
`project_history`, `project_run`, `project_replan`, `project_review`,
`project_complete`, `project_resume`, `project_resource`.

Humans and agents share the same operations (spec 2.4). The difference is
authority: routine work is automatic, significant work is recorded, and
strategic changes (vision, intent, values, major goals, pivots, completion)
require human approval unless YOLO mode is on. In every case the change is
recorded in history — YOLO means "don't interrupt me", not "don't keep records".

## How the loop works

```
Direction → State → Intelligence + Risks → Strategy → Plan/DAG → Execution
     ↑                                                                ↓
     └────────────── replanning ← Results / Evidence ←────────────────┘
```

- **Intelligence** (what we don't know) and **Risks** (what could go wrong) are
  separate but linked. Answering a question can update the probability of the
  risks it is linked to.
- The **DAG** is only the currently executable part of the plan. Nodes are
  `TASK`, `INVESTIGATION`, `EXPERIMENT`, `DECISION`, `REVIEW`, `GATE` or `WAIT`,
  with dependencies, status, outputs, failure reasons and links to
  goals/questions/risks.
- **Gates** produce `PASS`, `FAIL`, `REPLAN` or `ESCALATE`. A failed gate is not
  project failure; it usually just triggers replanning.
- **Replanning** considers the twelve inputs in spec 25 and proposes the
  smallest useful plan plus suggested updates to strategy, goals, questions and
  risks. Every plan version is kept, together with the reason and evidence that
  replaced it.
- **Runs** persist execution outside the conversation. `project_run` can launch
  a detached local command whose output goes to `runs/<id>.log`, and Pi can
  inspect or resume it in a later session. External machines, containers, GPUs
  and APIs are referenced, not orchestrated.

## Development

```bash
npm install
npm run check        # typecheck + unit/integration tests (node --test, native TS)
npm run demo         # generate a content-rich demo project at /tmp/pi-pm-demo
npm run smoke:rpc    # real `pi --mode rpc` run exercising tools end to end
npm run smoke:commands  # run every /project command through real pi in RPC mode
npm run smoke:tui    # real `pi` TUI in a pty (self-bootstraps a pyte venv)
```

Layout:

```
src/
├── types.ts       domain model
├── storage.ts     filesystem + Git persistence, markdown/YAML parsing
├── project.ts     ProjectManager: mutations, locking, authority, history
├── dag.ts         DAG validation, readiness, ordering
├── scoring.ts     exposure + question/risk priority models
├── replan.ts      adaptive replanning
├── context.ts     targeted context assembly (spec 24)
├── history.ts     semantic history + completion summary
├── reports.ts     replan analysis + strategic review reports
├── format.ts      plain-text renderers for tools
├── dashboard.ts   TUI views + browser component + widget
├── tools.ts       LLM-facing tools
├── commands.ts    /project commands
└── index.ts       extension entry point
```

## License

MIT
