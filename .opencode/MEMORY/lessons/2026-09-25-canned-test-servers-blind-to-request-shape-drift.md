# Canned test servers are blind to request-shape drift

**Gotcha**: a Bun.serve test server that returns canned answers WITHOUT reading the request cannot catch request-shape bugs. Observed 2026-09-25: `jev_label` passed 8/8 while the live call returned measured:false — its decide request omitted the separate `noul` question row (`{ type: "noul", instructions: ... }`, the `gate_ok`-style row accept.ts requests); the endpoint only returns noul when asked, so the fold fail-opened on the missing field. Green tests + live failure, no error surfaced.

**Fix**: when the bug class lives in the REQUEST, the test server must parse and assert on the request body: `expect(body.questions?.["noul"]).toEqual({ type: "noul", instructions: expect.any(String) })` — mirror request-inspecting patterns from sibling test files, and respond with the REAL full answer shape (every row the endpoint returns when properly asked).

**Acceptance gate**: the request-asserting transport test fails red while the request omits the row, passes green after the fix, AND a live call against the real endpoint returns a measured result.
