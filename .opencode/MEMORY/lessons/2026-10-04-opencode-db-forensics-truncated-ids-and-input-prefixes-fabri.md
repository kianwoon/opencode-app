# opencode.db forensics: truncated ids and input prefixes fabricate results

- **Date**: 2026-10-04T13:11:18+0800
- **Type**: lesson

## What happened

Three broken scans while investigating a loop warning: (1) filtering part rows by a display-truncated session id (substr(id,1,24) output) matched zero rows, making the scan look legitimately empty; (2) comparing state.input by a 55-char prefix made same-file tool calls look 'identical' (all share the leading filePath JSON); (3) a dropped CTE alias broke a window query with 'no such column'.

## Root cause / fix

Filter via join: part.session_id = (SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 1) — never a substr'd display prefix. Compare the FULL json_extract(p.data,'state.input') for identity claims. Sanity-check every 'empty' scan with a LIMIT 5 tail first; claim 'absent' only after the sanity tail returns rows. Window-CTE rule: every column the outer query references must be projected in the CTE.
