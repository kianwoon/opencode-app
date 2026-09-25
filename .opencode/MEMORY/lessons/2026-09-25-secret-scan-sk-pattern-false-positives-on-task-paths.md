# Secret-scan `sk-` pattern false-positives on task-* paths and doc examples

**Gotcha**: the prod-rebuild secret-scan pattern `sk-[A-Za-z0-9_-]{8,}` matches ordinary repo text — any word containing "sk-" followed by 8+ word chars, e.g. `task-effort-router.ts` ("ta**sk-effort-router**"), `task-list-item` ("**sk-list**"). Consequence: every commit-handoff scan in a repo with task-* strings/file names STOPs spuriously, costing adjudication rounds; hands may even half-execute (edit+commit done, stop reported after — observed 2026-09-25).

**Fix**: tighten the OpenAI-key shape to `\bsk-[A-Za-z0-9]{20,}\b` (real keys are sk- + 40+ alnum; 20 is a safe floor). `api_key[\"']? *[:=]` still needs human adjudication — code field names (`api_key: key,` passing a variable) are legitimate.

**Adjudication rule for any scan match**: read the matched LINE before stopping — a match inside a file path, a doc example, or a variable reference is a false positive, not a secret.

**Acceptance gate**: with the tightened pattern, a scan of AGENTS.md + README.md + bun.lock returns 0 matches in this repo, while a synthetic line `sk-abc123def456ghi789jkl012` still matches.
