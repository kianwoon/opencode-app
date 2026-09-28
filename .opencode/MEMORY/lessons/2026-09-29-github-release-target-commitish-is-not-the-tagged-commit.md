# GitHub release API target_commitish is NOT the tagged commit — merge the tag, never the target_commitish

**Slug:** gh-release-target-commitish-vs-tag

**Gotcha:** `GET /repos/<o>/<r>/releases/tags/<v>` returns `target_commitish`, which reads like the release commit. It is not — it is the branch tip the release was cut FROM. For opencode-style release flows the tag points at a separate `release: vX.Y.Z` commit (often a sibling/child of the dev tip on a release branch), so merging the `target_commitish` SHA silently skips the version-bump commit and can diverge from what the release actually shipped.

Observed (v1.18.33, 2026-09-29): release `target_commitish` = `1eacc1bdb9` ("fix: use available model for release changelog") while tag `v1.18.33` = `51ef4be1d3` (`release: v1.18.33`). A handoff that hard-coded the target_commitish as the merge target failed its own SHA check and burned a full hand round trip.

**Correct command:** always resolve the tag, and assert the intended commit is inside it rather than equal to it.

```
git fetch upstream --tags
git rev-parse v1.18.33^{commit}
git merge-base --is-ancestor <suspected-sha> v1.18.33^{commit}
```

For the compare API, `compare/<a>...<b>` reports `ahead_by`/`behind_by` — a nonzero `behind_by` is the tell that the two tags sit on different branches (release commits are NOT ancestors of each other).

**Acceptance gate:** the merge target is `refs/tags/<v>^{commit}`, its subject is `release: <v>`, and `merge-base --is-ancestor` confirms any SHA you intended to include is inside it. Precedent to match: fork merge `051578307b` has the `release: v1.18.31` commit as its second parent.
