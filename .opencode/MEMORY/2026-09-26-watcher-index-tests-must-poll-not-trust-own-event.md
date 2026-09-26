# Watcher/index-driven tests must poll - a test's own event does not prove other PubSub consumers ran

- 2026-09-26, opencode repo (test harness behavior, project-agnostic)
- GOTCHA: a test that awaits its OWN `nextUpdate` (a `Deferred` resolved by its
  private `events.subscribe(...)` fiber) has proven only that ITS subscriber saw
  the watcher event. The service under test dirty-marks its index from a
  SEPARATE subscriber on the same EventV2 PubSub, and that consumer can run
  after the test's fiber resolves. The test then reads a stale index and fails
  while the feature is actually correct.
- SYMPTOM: intermittent N-1/N flip - the same file passes in isolation and in a
  full run, but fails once when several files run together and the timing shifts.
  Seen as `13 pass / 1 fail` then `14 pass / 0 fail` with no code change between
  runs (`packages/core/test/filesystem-search-list.test.ts`, "reflects a new file
  without waiting out the index TTL": expected the new path, received `[]`).
  A flip like this is NOT a regression verdict on the service - diff the two runs
  before blaming the implementation.
- FIX: poll for the EXACT expected state with a bounded loop instead of asserting
  on the first read after your own event fired. A service that derives state from
  a second subscriber needs the second subscriber's write to be observable, not
  merely its own event to have been observed. Pattern (used at
  `packages/core/test/filesystem-search-list.test.ts:99-109`,
  `packages/core/test/repo-symbols-incremental.test.ts`):
  `for (let attempt = 0; attempt < 100; attempt++) { const s = yield* svc.read(); if (s.includes(expected)) return s; yield* Effect.sleep("50 millis") }` then return one final read so a genuine failure still fails on the real assertion.
  Keep the poll's predicate EXACTLY as strict as the original assertion - poll for
  the precise value, never for "did not throw" or a bare completion.
- ALSO: distinguish a genuinely event-driven test from one that only looks like it.
  The kill-switch sibling test writes a file and asserts the index did NOT change
  - no watcher event drives it, so it must NOT be converted to a poll (polling for
  an absence is a no-op loop). Poll only the read that follows a `nextUpdate`.
- ACCEPTANCE GATE: three consecutive green runs of the single file from the
  package dir (`cd packages/core && bun test test/filesystem-search-list.test.ts`
  x3, each 9 pass / 0 fail), then the multi-file set once
  (`bun test test/repo-symbols.test.ts test/repo-symbols-incremental.test.ts
  test/filesystem-search-list.test.ts` -> 14 pass / 0 fail), and `bun typecheck`
  exiting 0 from `packages/core`. Never run these from the repo root.
