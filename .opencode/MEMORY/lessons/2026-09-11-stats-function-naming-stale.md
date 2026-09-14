# 2026-09-11: stats package function naming vs stale README

**Symptom**: `packages/stats/AGENTS.md` line 3 intro claimed Lambda entrypoints live in a `function/` dir, but no such directory exists — stale README naming.
**Glob proof**: `ls packages/stats/` shows only `app/`, `core/`, `server/` — no `function/`.
**Fix**: One-word edit in AGENTS.md line 3: `function` → `server`.
**Acceptance gate**: `head -5 packages/stats/AGENTS.md` shows `server`; `ls packages/stats/` confirms the dir exists.
