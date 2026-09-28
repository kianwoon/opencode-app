# Probing a built bundle for a changed identifier — type names are erased, so a zero count is not proof the fix is missing

- **Date**: 2026-09-29
- **Type**: lesson

## Pattern

After a build, "did my change actually ship" gets checked by grepping the shipped artifact for a name from the diff. Two of the three obvious probe strings are worthless, and both return 0 whether or not the code shipped:

- `interface Foo {}` and `type Bar = ...` are erased at compile time. A grep for a type name hits 0 even when the file is fully present.
- Import specifiers are resolved away by the bundler. `from "./mod"` and `from "./mod.ts"` both hit 0 in a bundled output regardless of whether the extension was fixed.

Only RUNTIME identifiers — `const` names and exported function names — survive into the output.

## Concrete instance

A 215MB Electron asar built at 22:36 returned 2 hits for a `const` identifier and 1 hit for an exported function name introduced by the commit under test, but 0 for three type names from the same commit. The first probe had grepped for the import specifier and also got 0, so it was inconclusive on every axis and a second probe was required. Reading the zeros as "the fix did not ship" would have been wrong in both directions.

## Fix

Probe a built artifact with a RUNTIME identifier introduced by the commit, and require a NON-ZERO count as the positive control. If a commit changed only types, the artifact cannot be probed for it at all — fall back to the functional acceptance check (does the app boot, does the log show the failure string) and say so explicitly rather than reporting a grep zero as evidence.

## Acceptance gate

A future agent can answer "is commit X in the binary" with one grep and knows that a zero result is inconclusive, not a negative.
