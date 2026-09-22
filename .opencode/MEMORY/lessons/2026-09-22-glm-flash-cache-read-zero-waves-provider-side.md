# 2026-09-22 — glm-5.3-flash cache_read=0 waves are provider-side; exonerate the client with 2 queries

Pattern: warm turns show `tokens.cache.read = 0` for hours, then caching resumes — same code path, same session.

Fix/diagnosis order (before re-opening a prefix-mutation hunt):
1. Same-session exoneration from `~/.local/share/opencode/opencode.db`: if ANY assistant row has nonzero `$.tokens.cache.read`, usage parsing (packages/opencode/src/session/llm/ai-sdk.ts:65) AND the post-fix system head are proven fine.
2. Per-hour per-model split: `select substr(datetime(time_created/1000,'unixepoch'),1,13), json_extract(data,'$.modelID'), count(*), sum(json_extract(data,'$.tokens.cache.read')), sum(json_extract(data,'$.tokens.input')) from message where json_extract(data,'$.role')='assistant' group by 1,2` — other models caching in the SAME hour while the suspect model is 0 → server-side, model-specific.

2026-09-22 data: glm-5.3-flash hour 11 = 8 turns, 776k input, 0 read, while other models cached normally in the same hours; flash itself hit ~65% at hour 09 and read 76,224 twice consecutively at 12:31-12:32. Verdict: zai-coding-plan implicit caching for glm-5.3-flash is best-effort with hour-scale all-miss windows (~24% warm hit rate for the day). Not fixable in this repo; the ≥90% warm hit-rate acceptance gate is unmeetable on this model/tier.

Acceptance gate: a cache investigation may only end "client bug" with a NOVEL post-transform system head (diag-prefix re-enabled from ~/.config/opencode/plugins-disabled/) or ZERO nonzero-read rows in the session; otherwise classify provider-side and stop.
