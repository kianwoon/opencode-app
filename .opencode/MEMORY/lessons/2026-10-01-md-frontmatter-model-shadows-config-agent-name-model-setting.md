# md frontmatter model: shadows config agent.<name>.model (Settings model row silently no-ops)

- **Date**: 2026-10-01T23:56:32+0800
- **Type**: lesson

## What happened

The Settings->Subagent Model row writes agent.<name>.model to opencode.json. For an .md-backed agent the .md frontmatter WINS that key: config.ts:482 merges ConfigAgent.load(dir) as the 2nd arg of mergeDeep (md wins) and config/agent.ts:24-28 loads {name, ...md.data, prompt}. Putting model: into an .md therefore makes the UI's model change a silent no-op with no error - a migration that moved brain.*_model values into .md frontmatter caused exactly this. Symptom: pick a model, nothing changes.

## Root cause / fix

Keep ONE source per key: if the UI must edit it, the .md must NOT declare it. Fix = remove the model: line from the .md; keep the value in opencode.json agent.<name>.model (the UI write path). External config edits are NOT hot-reloaded (restart required; only a Settings-UI write calls Config.invalidate()). Acceptance: grep -c '^model:' <the .md> is 0 AND opencode.json agent.<name>.model carries the value.
