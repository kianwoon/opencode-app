# Markdown agent files override opencode.json for keys they define (prompt body, description/mode frontmatter)

- **Date**: 2026-10-01T19:42:58+0800
- **Type**: lesson

## What happened

packages/opencode/src/config/config.ts:482 merges ConfigAgent.load(dir) as the SECOND argument of mergeDeep, and remeda mergeDeep(a, b) lets b win. Empirically confirmed: with .opencode/opencode.json agent.x={description:json-desc,prompt:json-prompt,mode:primary} AND .opencode/agent/x.md (frontmatter description:md-desc, mode:subagent; body md-prompt), the loaded config yields description=md-desc, prompt=md-prompt, mode=subagent. Consequence: any UI that writes description/mode/prompt into opencode.json is silently SHADOWED for markdown-backed agents, including the desktop Settings-Subagent panel rows for those fields. Fields the markdown does not define (owned_tools, skills, permission, hidden, steps, temperature, disable) DO survive the merge.

## Root cause / fix

Fix options: (a) make config authoritative for agent entries by flipping the merge so opencode.json wins over markdown, but pair it with MINIMAL partial config writes because spreading the full effective config materializes markdown agents into opencode.json and would then shadow the files; or (b) edit the .md source directly, which the app cannot do (platform bridge is pickers/read-only, server file API is read-only). Acceptance gate: a config unit test that defines the same agent key in both sources and asserts the winner; and after editing description/prompt/mode on a markdown-backed agent via opencode.json, a config reload must reflect the change (currently it does NOT).
