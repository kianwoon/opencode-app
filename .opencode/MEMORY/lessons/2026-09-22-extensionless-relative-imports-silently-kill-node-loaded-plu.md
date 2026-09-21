# Extensionless relative imports silently kill Node-loaded plugins

- **Date**: 2026-09-22T04:14:34+0800
- **Type**: lesson

## What happened

Three extensionless relative specifiers in .opencode/plugin-lib broke ALL external plugin loading. opencode resolves external plugins through Node native ESM (Plugin.load -> node:internal/modules/esm/loader), which requires explicit file extensions; a relative specifier without .ts throws Cannot find module ... at finalizeResolution (node:internal/modules/esm/resolve:275:11) and the whole plugin is silently dropped from boot - no crash, no user-visible error, just one message="failed to load external plugin" line in ~/.local/share/opencode/log/opencode.log (observed ~36767, 2026-09-21T17:39). Files: .opencode/plugin-lib/context-gate.ts:4 "./compaction-triage", .opencode/plugin-lib/task-effort-router.ts:18 "../../packages/opencode/src/session/arbitrate", .opencode/plugin-lib/compaction-triage.ts:16 "./jev-effort" (latent - would have failed the next restart); all now import the .ts path (fixed 2026-09-22). Blast radius: JEV tool routing, guardrail, effort routing and compaction triage were all dead from boot while each still logged plausible telemetry.

## Root cause / fix

Root cause is a runtime-loader mismatch: the file is executed by Node ESM but verified with Bun. BOTH standard checks PASS on an extensionless import - bun build --no-bundle and bun test resolve it (Bun is extension-tolerant) and tsc/bun typecheck also accept it - so neither the build nor the test is evidence for this class of bug, and a bundler tolerance is exactly what hides the failure. Correct check is the REAL loader, same finalizeResolution that fails in production: node --experimental-strip-types --input-type=module -e "await import(\"<abs>/.opencode/plugin-lib/<name>.ts\")" (Node v24.6.0) -> exit 0. General rule: before claiming a plugin/hook change is verified, (1) grep the HOST APP for the loader that executes the file, (2) exercise THAT loader with a minimal probe on the real entry path, (3) read the host own error/log sink rather than assuming a silent success. Acceptance gate: the node probe exits 0 for every edited/added plugin-lib/*.ts AND after a restart grep -c "failed to load external plugin" ~/.local/share/opencode/log/opencode.log shows no NEW lines (historical lines remain - compare timestamps, not the raw count).
