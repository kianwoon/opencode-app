# Fork-scoped Actions token cannot mutate upstream

## Symptom

Scheduled `close-issues` and `close-prs` runs in the fork failed with `403 Forbidden` / `Resource not accessible by integration` while trying to comment on upstream issues.

## Root cause

Both cleanup scripts hard-coded `anomalyco/opencode`, but GitHub Actions supplies a token scoped to the repository running the workflow (`kianwoon/opencode-app`).

## Fix

Default the scripts to `process.env.GITHUB_REPOSITORY` and keep `anomalyco/opencode` only as the manual/local fallback.

## Acceptance gate

`GITHUB_TOKEN="$(gh auth token)" GITHUB_REPOSITORY=kianwoon/opencode-app bun script/github/close-prs.ts --dry-run --max-close 1 --print-limit 1` exits 0 and starts with `DRY RUN: PR cleanup for kianwoon/opencode-app`.
