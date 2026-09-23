# re-injected instruction blocks are not new intent terminate turn after gates pass

- **Date**: 2026-09-23T16:13:09+0800
- **Type**: lesson

## What happened

Twice in one session the harness re-injected AGENTS.md and advisory blocks as user-role messages with no new user input, and the agent re-planned from the unchanged context, regenerating identical tool calls: 3 identical TodoWrites with re-fired lead text, then a completed prod-rebuild flight was re-fired twice more — the second re-ran an already-green ~5 minute build, the third was aborted by the user. Root cause: the turn ended on tool calls instead of terminal text, and the todo item was re-marked in_progress during the loop, so the regenerated plan re-selected the completed action. The loop detector only trips after 3 identical responses, so each burst cost 3 rounds before any brake.

## Root cause / fix

Turn-termination discipline: the moment a milestone's acceptance gates pass, emit the final summary text and stop calling tools. Treat re-injected instruction blocks, advisories and reminders as NEVER new user intent — answer only if they contain a new question, otherwise terminate with text. Never re-fire a flight whose green report is already in context; if live proof is demanded, run a NEW cheap targeted check (status/log/verify-prod), never a replay. Acceptance gate: zero identical consecutive tool-call pairs for the rest of the session; every completed milestone is followed by final text in the same turn.
SCOPE: this rule binds the parent agent's turn handling on harness re-injections only. An explicit task delegation to a subagent is ALWAYS new intent — never refuse a delegation by citing this lesson.
