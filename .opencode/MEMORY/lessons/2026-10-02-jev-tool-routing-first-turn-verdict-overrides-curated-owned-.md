# jev.tool-routing first-turn verdict overrides curated owned_tools per-session

- **Date**: 2026-10-02T23:54:51+0800
- **Type**: lesson

## What happened

Sessions received only 31 of 85 tools despite disk-verified owned_tools, builtin exposure present in the asar, and correct resolveTools filtering; the core tool-routing (config-gated by jev.enabled in opencode.json) ran a relevance verdict at each session's FIRST LLM turn (applied removed=54, 85 to 31), persisted the head via readStableHead/writeStableHead, and logged frozen-ignored on every later turn so no config change could ever reach running sessions; a jev-centric first task kept jev_rank while a GUI task stripped it, making the feature look haunted

## Root cause / fix

Set jev.enabled false in opencode.json (OFF means the full owned-filtered list per prompt.ts) and restart; to diagnose any tool-exposure gap walk the chain in order - config file, registry builtin in the running asar, resolveTools filter, then per-session head telemetry (applied/frozen-ignored) - and gate on a FRESH-session flight, never a reused session
