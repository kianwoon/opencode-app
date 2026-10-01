# Inline config agent prompts shadow .md agent bodies (dual source)

- **Date**: 2026-10-01T22:26:49+0800
- **Type**: lesson

## What happened

opencode.json can carry agent.<name>.prompt, and a config prompt OVERRIDES the corresponding agent/<name>.md body. A discovery-driven brain.md rewrite was silently inert because an inline agent.brain.prompt (5358 chars) still carried a fixed subagent roster: grepping the .md read clean while the LIVE prompt was the config string. Also this session deleted brain.hands_model/reviewer_model/guru_model/computer_aid_model, so prose in those prompts naming them is stale.

## Root cause / fix

Edit the file that is actually loaded: remove agent.<name>.prompt from opencode.json so the .md body wins. External config edits are NOT hot-reloaded (restart required). Acceptance: grep the LIVE config (not just the .md) for the roster tokens; python3 json.load exits 0; after restart the rendered system prompt matches the .md.
