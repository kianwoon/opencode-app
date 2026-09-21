# Context-gate lossy system prefix rewrite invalidates prompt cache

- **Date**: 2026-09-21T21:45:41+0800
- **Type**: lesson

## What happened

context-gate parsed system[0] and re-serialized it every turn. The parse->join round-trip is LOSSY: stripProvenance (.opencode/plugin-lib/context-gate.ts:597) deletes a trailing '[Summarized from ~N words — original: ...]' marker and joinSections (:224) rebuilds each section as 'Instructions from: ${path}\n${text.replace(/\n+$/,"")}' joined by '\n' with a forced single-'\n' prologue separator, so input bytes != output bytes. applyCaching (packages/opencode/src/provider/transform.ts:366) pins cache breakpoints on the first 2 system parts + the latest user message, so a per-turn byte change to system[0] re-bills the whole prefix. Observed: warm turns dropping from ~62k cache_read to ~12k with ~54k fresh input.

## Root cause / fix

Return BEFORE ANY MUTATION when both scopingEnabled and summarizeEnabled are false — guard at .opencode/plugin-lib/context-gate.ts:950; sections.splice (:976) and applyGate (:980) run BELOW it and are mutations too. A guard placed AFTER the work it guards is inert (first fix sat below splice/applyGate and only skipped the memo/log tail) — verify placement by re-reading the exact lines, never by trusting a diff summary. Related inert-feature trap: packages/opencode/src/session/prompt.ts:2307 assigns the JEV verdict to turnTools, but :2537 emits tools: headTools (session-frozen via freezeHead, :2489) and no downstream reader feeds turnTools into the request, so jev.tool-routing applied {removed: N} (:2308) logs savings that never occurred. Acceptance gate: (1) zero new gate events in ~/.local/share/opencode/context-gate.jsonl after restart; (2) warm-turn hit rate cache_read/(cache_read+cache_write+input) from ~/.local/share/opencode/opencode.db >= 90%; (3) bun test context-gate-roundtrip.test.ts passes FROM .opencode/plugin-lib (never repo root); (4) before claiming any feature saves anything, grep for the READER of the variable it writes, not just the write site.
