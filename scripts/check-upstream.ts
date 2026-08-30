#!/usr/bin/env bun
/**
 * Show what REAL upstream opencode commits we're missing.
 *
 * IMPORTANT: local version tags (v1.18.x) are bumped by us and are NOT reliable
 * references. This always compares against the genuine upstream (origin) so the
 * version numbers never mislead us again.
 *
 * Usage:
 *   bun scripts/check-upstream.ts            # compare against latest upstream tag
 *   bun scripts/check-upstream.ts v1.18.17   # compare against a specific tag
 *   bun scripts/check-upstream.ts --main     # compare against origin/main
 */
import { $ } from "bun"

const UPSTREAM = "origin"

async function run() {
  const arg = process.argv[2]
  const ref = arg === "--main" ? "dev" : (arg ?? "")

  // Fetch the real upstream ref (don't clobber any local tag with the same name).
  let target: string
  if (ref) {
    if (arg === "--main") {
      // Compare against the upstream default branch (dev).
      await $`git fetch ${UPSTREAM} dev`.quiet()
      target = `${UPSTREAM}/dev`
    } else if (ref.startsWith(UPSTREAM)) {
      await $`git fetch ${UPSTREAM} main`.quiet()
      target = ref
    } else {
      await $`git fetch ${UPSTREAM} refs/tags/${ref}:refs/tags/upstream-${ref}`.quiet()
      target = `refs/tags/upstream-${ref}`
    }
  } else {
    // No arg → latest upstream tag.
    const tags = (await $`git ls-remote --tags ${UPSTREAM}`.text())
      .split("\n")
      .map((line) => line.split("\t")[1])
      .filter((t) => t && /refs\/tags\/v\d+\.\d+\.\d+$/.test(t))
      .sort((a, b) => {
        const va = a.replace("refs/tags/v", "").split(".").map(Number)
        const vb = b.replace("refs/tags/v", "").split(".").map(Number)
        return va[0] - vb[0] || va[1] - vb[1] || va[2] - vb[2]
      })
    const latest = tags.at(-1)
    if (!latest) throw new Error("No upstream tags found")
    const tagName = latest.replace("refs/tags/", "")
    await $`git fetch ${UPSTREAM} refs/tags/${tagName}:refs/tags/upstream-${tagName}`.quiet()
    target = `refs/tags/upstream-${tagName}`
    console.log(`Comparing against real upstream tag: ${tagName} (${await gitRev(target)})`)
  }

  const head = await gitRev("HEAD")
  const targetRev = await gitRev(target)
  console.log(`  local HEAD:        ${head}`)
  console.log(`  upstream ref:      ${targetRev}`)
  console.log("")

  const missing = (await $`git log --oneline ${target} --not HEAD`.text()).trim().split("\n").filter(Boolean)
  if (missing.length === 0) {
    console.log("✅ We have ALL commits from this upstream ref. Nothing to pull.")
    return
  }

  // A commit may be "not in HEAD" by identity yet already applied via a
  // cherry-pick (different hash, same content). Detect those by checking
  // whether applying the commit's patch to HEAD is a no-op (already applied).
  const applied = new Set<string>()
  for (const line of missing) {
    const hash = line.split(/\s+/)[0]
    // If the commit's diff against its parent is already present in HEAD
    // (i.e. `git diff <commit>^ <commit>` matches HEAD's state for those files),
    // it was cherry-picked. Use `git cherry-pick --no-commit --dry-run`-style
    // detection via patch-id: compare the commit's patch-id to HEAD's history.
    const patchId = await $`git show ${hash} | git patch-id --stable`.text().then((s) => s.split(/\s+/)[0])
    const headPatchIds = await $`git log -p HEAD --not ${hash}^ | git patch-id --stable`.text()
    if (headPatchIds.includes(patchId)) applied.add(hash)
  }

  const trulyMissing = missing.filter((line) => !applied.has(line.split(/\s+/)[0]))
  const appliedCount = applied.size

  if (trulyMissing.length === 0) {
    console.log(`✅ All ${missing.length} upstream commit(s) are already applied (${appliedCount} via cherry-pick).`)
    return
  }

  console.log(
    `⚠️  ${trulyMissing.length} upstream commit(s) genuinely NOT applied${appliedCount ? ` (${appliedCount} already cherry-picked)` : ""}:`,
  )
  console.log("")
  const relevant: string[] = []
  const other: string[] = []
  for (const line of trulyMissing) {
    const subject = line.replace(/^[0-9a-f]+\s*/, "")
    if (/^fix\(|^feat\(/.test(subject)) relevant.push(line)
    else other.push(line)
  }
  if (relevant.length) {
    console.log("  RELEVANT (fix/feat):")
    for (const line of relevant) console.log(`    ${line}`)
    console.log("")
  }
  if (other.length) {
    console.log(`  Other (docs/chore/refactor/ci/stats — ${other.length}):`)
    for (const line of other.slice(0, 15)) console.log(`    ${line}`)
    if (other.length > 15) console.log(`    …and ${other.length - 15} more`)
  }
  console.log("")
  console.log("To pull a specific commit cleanly:  git cherry-pick <commit>")
}

function gitRev(ref: string) {
  return $`git rev-parse --short ${ref}`.text().then((s) => s.trim())
}

await run().catch((e) => {
  console.error("Error:", e.message)
  process.exit(1)
})
