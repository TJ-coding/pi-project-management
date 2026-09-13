# Direction

## Vision

Make pi-project-management the project tool I run every day: readable panels, findable text, honest state.

## Intent

Ship what the reviews found: enforced brevity, readable panels, a rename path, a leaner digest. Each verified by tests and a k3 review.

## Values

- Readable first: if a panel needs a second look, it is broken.
- Enforced, not advised: limits live in code and refuse bad writes.
- Every UI change gets a k3 review before it ships.
- Verified: unit tests, the real-TUI smoke, and measured frames.
- Short by construction: budgets keep entries tweet-sized.

## Concepts

- [principle] Checks live in mutate(), so every write path obeys them.
- [principle] One line per row; full text behind Enter in the reading pane.
- [constraint] A session started in $HOME attaches to ACL26, not this project.
- [metric] Over-budget fields, tests passing, k3 rounds, width overflow.
- [artifact] ~/Projects/pi-project-management (TypeScript pi extension, docs/SPEC-MAPPING.md).

## Last Updated

2026-09-13T15:59:01.000Z
