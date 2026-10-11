# 2026-10-09 — decisions.jsonl corruption: printf + multi-line strings

**Gotcha**: appending ledger rows via `printf '%s\n' '<hand-formatted JSON>'` corrupts
`~/.local/share/opencode/brain-shadow/decisions.jsonl` whenever the JSON string contains
literal newlines (multi-line hand formatting) — printf writes them raw, splitting one JSON
row across physical lines. Raw newlines inside JSON string values are ILLEGAL, so the rows
become unparseable. **Recurred twice**: 2026-10-06 (lines 55–57) and 2026-10-09 (lines
166–170, 197–203) — 15 corrupt lines total.

**Rule**: build ledger rows with `python3` + `json.dumps` (guarantees single-line, escaped)
or enforce strict single-line output before append. Never hand-format JSON across lines
inside a quoted printf argument. After any bulk append, validate: every line parses.

**Repair pattern** (used 2026-10-09, backup first): group continuation lines until the
candidate parses; groups that never parse → wrap raw text as
`{"ts":null,"event":"corrupt_row_salvaged","raw":"<json-escaped original>"}` — no content
invented, full parseability restored.

**Evidence**: 205 raw lines → 193 rows, 0 parse failures post-repair;
`decisions.jsonl.bak-repair` holds the pre-repair state.
