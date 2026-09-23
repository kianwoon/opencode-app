# grep count gates must span naming variants snake only gate false

- **Date**: 2026-09-22T23:46:24+0800
- **Type**: lesson

## What happened

An acceptance gate that greps for the snake_case tool id alone false-STOPped a correct registration and blocked a prod build at pre-flight: grep -c jev_decide registry.ts >= 3 expected the import line to match, but the import is PascalCase (JevDecideTool from ./jev-decide, kebab file) and the local var is lowerCamel (jevdecide) — only the registry map key and the toolset emit entry matched (2), so a fully-registered, typecheck-green tool looked broken.

## Root cause / fix

Fix: gate on a separator/case-insensitive pattern spanning all naming variants (grep -icE 'jev[-_.]?decide'), or assert only the two sites that prove registration (the Tool.init map key + the toolset emit). Rule: before a count-based gate STOPs a build, re-run the count with the variant-insensitive pattern and report both counts; a gate calibrated from a report's line list must normalize naming conventions first. Acceptance gate: registration is proven by (a) Tool.init map entry, (b) toolset emit entry, (c) bun typecheck exit 0 — not by a raw grep count of one casing.
