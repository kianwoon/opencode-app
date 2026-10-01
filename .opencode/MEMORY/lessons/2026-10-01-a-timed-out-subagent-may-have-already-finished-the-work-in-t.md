# A timed-out subagent may have already finished the work in the tree

- **Date**: 2026-10-01T15:24:03+0800
- **Type**: lesson

## What happened

A hand timed out at 30 minutes and returned no report, but the full intended changeset was present and every spec marker grepped true; re-firing would have redone finished work. Before re-firing any timed-out hand, check git status file set plus the spec's distinctive identifiers.

## Root cause / fix

git status shows exactly the intended files AND the spec's distinctive markers grep present before any re-fire.
