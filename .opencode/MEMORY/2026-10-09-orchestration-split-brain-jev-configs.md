# Two unrelated "jev" toggles — split-brain config surfaces (2026-10-09)

## Gotcha
"Is jev enabled?" has TWO independent answers in two different files:
- `~/.config/opencode/opencode.json` `jev.enabled` — tool routing (currently `false`; every turn logs `jev.tool-routing skipped reason=disabled`).
- `~/.config/opencode/effort-router.json` `jev.enabled` — effort router (currently `true`; feeds Settings→Orchestration "Effort router status" tag + verdicts panel).

The Settings→Orchestration rows read DIFFERENT sources: the Tool routing switch reads opencode.json; the Effort router / Guardrail tags + verdicts read `effort-router.json` (plugin-owned, does NOT inherit `jevDefault.model`); the Context scoping/summarize/triage rows read `context-gate.json`. Config-absent ≠ disabled for tag rows — verify against the owning FILE, not the opencode.json namespace.

## Model-field consolidation
5 decider `model` fields exist (opencode.json: `jev`, `jevDefault`, `governor`, `brainBooster`; effort-router.json: `jev`, `guardrail`). Precedence in client.ts `resolveJevSurface`: feature block > `jevDefault.model` > built-in `JEV_DEFAULT_MODEL`. Setting `jevDefault.model` covers 4 of 5; effort-router.json is the only required second edit. All currently `typesafe/jev-1.13`.

## Threshold drift trap
Three "default" thresholds: client.ts `JEV_DEFAULT_THRESHOLD` = 0.7, httpapi `global.ts` `DEFAULT_JEV.threshold` = 0.5 (settings mirror), config value 0.6 (wins via `resolveJevSurface`). Never treat the httpapi mirror default as the runtime default.

## Acceptance gate
Before claiming a decider feature is off/on/dead: (a) name its OWNING config file, (b) check its log literal in `~/.local/share/opencode/log/opencode.log` filtered for `evaluated permission` (`jev.tool-routing`, `jev.booster`, `jev.governor dropped/restored` — governor logs ONLY on drop/restore, so zero events under small context is expected, not failure), (c) UI tags must match the owning file, not opencode.json.
