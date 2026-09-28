# verify-fork-integrations 22 false positives — measure the pre-merge baseline in a throwaway worktree before trusting it

**Slug:** verify-fork-integrations-baseline-worktree

**Gotcha:** `bun scripts/verify-fork-integrations.ts` reported `34 passed, 22 failed` plus `DO NOT PUSH` immediately after the v1.18.33 merge, and its header says a failure blocks every push. All 22 were ALREADY failing at the pre-merge HEAD — the script greps by signature pattern, so a function upstream relocated reads identically to a function the merge deleted. Trusting either the alarm (bogus recovery work) or the green "34 passed" (hides real losses) is wrong: the failure set needs a baseline to mean anything.

**Correct command:** run the same script at the pre-merge commit in a throwaway worktree, then diff the failure sets.

```
git worktree add /tmp/oc-baseline <pre-merge-sha>
cd /tmp/oc-baseline && bun scripts/verify-fork-integrations.ts
git worktree remove /tmp/oc-baseline
```

Identical failure set → nothing lost in the merge (stale patterns). Green at baseline but red now → a real loss.

**Acceptance gate (2026-09-29, v1.18.33 merge):** baseline at `ec011be4ea` printed the identical `34 passed, 22 failed` with the same 22 labels → zero fork features lost; merge pushed. OPEN FOLLOW-UP: the 22 stale signatures still need re-pinning — until then this guardrail is decorative for the next merge.

**Second gotcha, same merge:** upstream's `timeoutFetch` in `packages/opencode/src/provider/provider.ts` is NOT superseded by the fork's inline `options["fetch"]` superset in the resolveSDK loader — the cloudflare-ai-gateway `getModel` loader calls `timeoutFetch(options ?? {})` from a DIFFERENT code path (provider.ts:1048 post-merge). Deleting the "duplicated-looking" helper is a live ReferenceError at gateway-model load. Keep BOTH.

Acceptance gate: `grep -c 'timeoutFetch' packages/opencode/src/provider/provider.ts` ≥ 2 (definition + gateway call site), and `bun test test/provider/header-timeout.test.ts` green (15 pass, 0 fail) from `packages/opencode`.
