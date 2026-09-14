#!/bin/sh
# Run the k3 frame review for a given prompt file and write the reply.
# Kept as a script so it can be launched by project_run (which survives the
# pi session) rather than by a shell call that dies with its tmux session.
PROMPT="${1:?usage: run-k3-review.sh <prompt-file> <out-file>}"
OUT="${2:?usage: run-k3-review.sh <prompt-file> <out-file>}"
pi --print --no-session --no-extensions --no-tools --no-context-files \
   --provider opencode-go --model kimi-k3 --thinking medium "$(cat "$PROMPT")" > "$OUT" 2>&1
echo "exit=$?" >> "$OUT"
