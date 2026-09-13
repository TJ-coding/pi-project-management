# Strategy

## Current Approach

Ship small verified improvements: tests, the real-TUI smoke, then a k3 review of ANSI-stripped frames. Findings become plan nodes.

## Strategic Hypotheses

- External review finds usability defects that unit tests cannot.
- Enforcing budgets in mutate() covers every write path at once.
- One line per row plus a reading pane keeps panels scannable and complete.

## Priorities

- 1. Panel readability, k3-verified.
- 2. Enforced brevity everywhere text is written.
- 3. Close the rename and digest gaps.

## Rationale

The tool's value is that a human can read project state at a glance and trust it. Review-driven UI work has already found real bugs, so it stays the loop for any panel change.

## Major Alternatives Considered

- Rebuild the UI as a web app (out of scope, spec 22).
- Keep brevity as advice only (rejected: prose grew unbounded).
- Skip external review (rejected: it missed the selected-row overflow).

## Last Updated

2026-09-13T15:59:02.431Z
