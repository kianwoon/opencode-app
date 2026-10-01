# task tool silently re-adopts the newest same-agent child session unless reuse is passed false

- **Date**: 2026-10-02T03:45:16+0800
- **Type**: lesson

## What happened

five consecutive GUI-verification handoffs to computer-aid died without performing work. Each call omitted reuse, so the task engine re-adopted the newest same-agent child session every time (every result header read 'Reusing subagent session <id> - re-running inside it; pass reuse as the boolean false for a fresh spawn'), inheriting an exhausted cua-driver call counter (30/30) that is keyed to the driver's daemon lease - it survived session revival AND new handoffs, and could not be reset by any hand because cua-driver_set_config is denied for computer-aid. Symptom signature: '[cua-budget] 26+/30 tool calls this handoff' on arrival, death before the first real action, while the underlying GUI path was fully proven (navigation, panel, Edit all reached in earlier runs).

## Root cause / fix

for any handoff that must start with a clean budget or clean context, pass reuse as the boolean false explicitly - omitting task_id is NOT enough, the engine still auto-adopts. Recognize the trap from the result header ('Reusing subagent session ...') plus a budget notice that opens high. For the cua-driver specifically: the per-handoff counter is daemon-leased; reset it only via a cua-driver_set_config grant to the hand or a driver-side change - re-firing hands cannot. Cost of the miss: five dead runs and a furious user.
