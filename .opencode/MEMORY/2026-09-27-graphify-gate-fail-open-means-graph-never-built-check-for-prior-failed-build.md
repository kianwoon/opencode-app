---
# graphify-gate "fail-open" means the graph was never built — check graphify-out for a prior FAILED build before assuming breakage

**Symptom (2026-09-27, opencode repo):** every session's graphify-gate silently no-ops; `graphify-out/graph.json` absent. No error anywhere — the gate is DESIGNED to no-op when the file is missing (`graphify-gate.ts:19` "No-ops when graphify-out/graph.json doesn't exist"; `:97` walks up from CWD). Fail-open is a symptom, never a cause.

**Root cause:** a `/graphify .` run on 2026-09-05 failed partway and never wrote `graph.json`, while leaving `manifest.json`, `cache/`, and `cost.json` behind — the tree LOOKED graphified (README.md:42 even advertises `graphify-out/`) but had no graph. Rerun evidence: `re-queuing 168 manifest-stamped code file(s) with no nodes in graph.json (prior failed extraction)`. Second gap: `error: no LLM API key found` — with no GEMINI/GOOGLE/ANTHROPIC/OPENAI/DEEPSEEK key only CODE files extract (local AST, no key); docs/papers/images are skipped (1641 here).

**Fix:** rerun `graphify .` at the project root (workdir = root, so the gate's upward walk finds the graph from any subtree). The incremental cache made the rerun fast despite a ~6k-file repo. `--code-only` explicitly skips the key requirement.

**Acceptance gate:** `graphify-out/graph.json` exists and is large (49 MB / 40,819 nodes here); `graphify query "<codebase question>"` returns NODE lines, not an error; subsequent sessions stop failing open. For docs/image coverage, set one of the API key env vars and rerun.

**Meta-gotcha:** the inline glob/grep tools cannot see dot-dirs in this project — `.opencode/**` glob returns "No files found" while `ls -a` shows MEMORY/, plugin-lib/, skills/ etc. exist. Probe dot-dirs via a hand's `ls`, never trust a dot-dir glob negative.
---
