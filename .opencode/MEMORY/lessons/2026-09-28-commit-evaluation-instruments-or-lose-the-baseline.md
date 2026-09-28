# Commit evaluation instruments, or lose the baseline

**Gotcha**: the response-gate plugin evolved v1 to v6.3 in the working tree only — git has it untracked, zero commits touch it. When the v6.1 merge folded the v3-era `gradeAnswer` away, the exact instrument that produced the 0.41 baseline (n=32) became unrecoverable: no revision, no working-tree history, nothing to re-run. Every later comparison carries an "instrument unverifiable" caveat.

**Fix**: commit each instrument version BEFORE the era it measures begins. The prod-rebuild rule already authorizes commits to main, a one-file commit is cheap, and a baseline report then cites a git hash instead of a working tree it can no longer reconstruct.

**Acceptance gate**: any reported baseline names a recoverable instrument revision (a hash), and `git log -- <instrument path>` is non-empty before the era starts.
