# Node-probe baseline is per DIRECTORY, not per package

- **Date**: 2026-09-28
- **Type**: lesson

## Gotcha

The Node-resolvability probe gate is scoped PER DIRECTORY, not per package — two directories in the same Bun-bundled package can have opposite verdicts.

## Pattern

A repo mixes a Bun-bundler-resolved import graph with source-executed modules loaded by Node native ESM (Electron sidecar, external plugins). `bun build`, `bun test`, and `bun typecheck` ALL resolve extensionless relative imports, so none of them is evidence about Node ESM. The real check is `node --experimental-strip-types --input-type=module -e "await import('<abs path>')"`, which fails at `finalizeResolution` with `ERR_MODULE_NOT_FOUND` on an extensionless sibling specifier, and also on an unresolvable path alias (`Cannot find package '@/…'`).

## The mistake that cost time

Treating a red probe inside a Bun-bundled directory as a defect. In this repo `src/tool/` is Bun-bundled: untouched siblings fail the probe for TWO independent reasons — its own extensionless `./truncate` import AND an unresolvable `@/agent/agent` alias — while `src/jev/` in the SAME package is externalized/source-executed and every one of its modules must pass. A single package-level baseline is therefore meaningless.

## Fix

Before treating a red probe as a bug, run it on ONE untouched sibling in the SAME DIRECTORY (not the same package, not a different package). If that sibling also fails, the directory is bundler-tolerated and the gate does not apply — fix nothing there. If the sibling prints LOADED, the red is real. Classify per directory and record the verdict.

## Concrete instance

Four modules in one directory of a Bun-bundled package (`src/jev/`: `controller.ts`, `accept.ts`, `label.ts`, `rank.ts`) imported `"./client"` extensionlessly and were node-fatal while `bun typecheck` and the full test suite stayed green; adding the explicit `.ts` extension to each made the whole directory pass the probe with no other change.

## Acceptance gate

A future hand reading only this lesson can decide in one probe whether a given directory's red is a real defect, without re-deriving the Bun-vs-Node split.
