# desktop prebuild: missing OPENCODE_VERSION → server reports 0.0.0 → Zen 426

**Gotcha / symptom:** Packaged desktop server hit Zen free tier and was rejected with
HTTP `426 UpgradeRequired` ("1.17.0 or newer required"). Server User-Agent reported
`0.0.0-<channel>-<timestamp>` instead of the real version.

**Root cause:** `packages/desktop/scripts/prebuild.ts` exported `OPENCODE_CHANNEL` into
`script/build-node.ts` but NOT `OPENCODE_VERSION`. build-node's Script preview fallback
treats a non-dev channel as a preview and derives `0.0.0-<channel>-<ts>` when
OPENCODE_VERSION is unset, so the version define baked 0.0.0 into the bundle. Zen parses
that as < 1.17.0 and rejects the request. Channel alone is insufficient.

**Fix (packages/desktop/scripts/prebuild.ts):**
```ts
const version = Bun.env.OPENCODE_VERSION ?? pkg.version
await $`cd ../opencode && OPENCODE_VERSION=${version} OPENCODE_CHANNEL=${channel} bun script/build-node.ts`
```
`OPENCODE_VERSION` is resolved from env first (CI release builds win) then the desktop
package.json version. Both vars are propagated on the same build-node invocation.

**Acceptance gate:**
```
cd packages/opencode
OPENCODE_VERSION=$(bun -e "console.log(require('.../packages/desktop/package.json').version)") \
  OPENCODE_CHANNEL=prod bun script/build-node.ts
grep -c "0.0.0-prod" dist/node/node.js   # must be 0
```
Confirmed 2026-09-17: build succeeded, `dist/node/node.js` contains `1.18.31` and zero
`0.0.0-prod` occurrences.

**Pattern:** When a script bakes identity/version metadata into an artifact, every
consumed env var must be explicitly forwarded; silent fallbacks produce a plausible but
wrong version that only fails against an external version gate.
