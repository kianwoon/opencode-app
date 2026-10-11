# 2026-10-09 — DB hat-audit regex lesson

**Gotcha**: auditing the message DB for hat firings with regex `[Hh]at [a-z_-]+ 0\.\d+` false-positives on 'that a 0.6' (no word boundary), and orchestrator-session reasoning QUOTES of old traces ('Hat plain-explainer 0.84') match forever.

**Rule**: a firing counts only when (a) pattern uses \b[Hh]at\b AND (b) the same message carries ≥1 real jev_* tool part. Tool parts live in `part.data`, NOT `message.data` (role/model/tokens only).

**Evidence**: ses_edfd0bdb5f false positive; ses_ee3379756 13 quote-hits, 0 real.
