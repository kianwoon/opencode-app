# read truncates silently — never rewrite a whole file from a read that reported truncation

- **Date**: 2026-10-01T22:10:34+0800
- **Type**: lesson

## What happened

Rewriting ~/.config/opencode/agent/brain.md wholesale from a read whose output ended with 'Tool output truncated for context' silently DELETED 5 of the file's 6 'Standing operating procedures' bullets (graphify-first, TodoWrite, inline budget, needs-split, cheap-diagnostics). The rewrite passed its own acceptance gate and looked complete, because a shorter file trivially contains every forbidden token 0 times. Recovered only by diffing against 'git -C ~/.config/opencode show HEAD:agent/brain.md' (the config dir is a git repo).

## Root cause / fix

Before rewriting a file from a read, compare the line count you actually received against the file's real length (wc -l). If the read reported truncation, re-read the missing range with offset/limit or consult version control BEFORE writing. Then diff the untouched sections of the new file against HEAD to prove nothing else was dropped. Acceptance gate: git diff of the rewritten file shows only intended hunks, and 'wc -l' of the result matches the original modulo the intended deletions.
