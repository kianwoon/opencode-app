# A/B telemetry eras partition by boot epoch, not by the latest counts

**Gotcha**: A/B eras over a live-writer jsonl cannot be read off "the tail" — the file keeps growing, so the newest lines are not the era boundary. Observed 2026-09-28: two consecutive extractions classified the SAME score line (0.65 at ts 1790575253512) differently; one eyeballed the tail and called it post-boot, the other applied the boot-epoch threshold and showed it was logged by the OLD process, during the shutdown window between the fix landing (13:59:36) and the boot (14:02:49). Same line, two eras, no error surfaced.

**Fix**: partition events by epoch-ms `ts >= <boot-epoch>`; re-derive the boot epoch from `ps` at EVERY extraction (it moves); a line whose ts falls in `[fix-mtime, boot-time)` belongs to the old process by definition, no matter where it sits in the file; report FIRST/LAST timestamps per era so the span is visible next to the count.

**Acceptance gate**: every era claim names its threshold epoch and the boot it was derived from, and counts agree between two consecutive extractions run at the same threshold.
