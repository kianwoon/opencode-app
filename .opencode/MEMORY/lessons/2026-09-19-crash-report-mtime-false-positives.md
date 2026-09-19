# Crash-report `.ips` mtime is not evidence of a new crash — inner `timestamp` field is

Gotcha: `find ~/Library/Logs/DiagnosticReports -name "*.ips" -newermt "<relaunch time>"` flagged 2 files after a fixed app relaunch, looking like fresh crashes. One was a pre-relaunch crash whose reporter closed late; one was a Sep-18 report whose file mtime got re-touched days later. Both false positives. `.ips` files are re-dated/touched by macOS and app reseals — file mtime proves nothing.

Fix: for each mtime hit, read the inner field: `grep -m1 -oE '"timestamp":"[^"]*"' <file>` and compare THAT against the relaunch time. Only inner timestamps count.

Second confirmation signal for "is the crash loop alive": stable PIDs + growing etime on the helper processes (`ps -o pid,etime -p <pids>`) — crash loops respawn helpers constantly, so same-PIDs-minutes-alive is stronger evidence than any log-absence claim.

Acceptance gate: any "0 new crashes since T" claim must cite inner timestamps for every mtime-flagged file, plus helper PID stability; mtime-only counts are inadmissible.
