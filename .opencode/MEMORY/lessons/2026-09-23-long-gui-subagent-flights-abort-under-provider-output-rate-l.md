# long GUI subagent flights abort under provider output rate limits

- **Date**: 2026-09-23T14:01:50+0800
- **Type**: lesson

## What happened

Three flights aborted today (Tool execution aborted / output token rate limit exceeded) on long GUI handoffs — each bundling channel-toggle + probe + reload + extraction with a 40-line report demand. The flights that completed were 1-2 call explorer reads with bounded raw reports.

## Root cause / fix

Split GUI/browser work into micro-flights: one section per flight, report <=10 lines, raw output. For read-only browser reads prefer direct shell osascript (probe execute-javascript 1+1, then targeted innerText read) over a full computer-aid flight. 2 consecutive flight aborts = switch channel, never re-spawn the same flight.
