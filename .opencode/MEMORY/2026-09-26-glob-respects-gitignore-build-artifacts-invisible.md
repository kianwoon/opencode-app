# Glob/Read tools respect .gitignore - build artifacts under dist/ are invisible

- 2026-09-26, opencode repo (harness behavior, project-agnostic)
- GOTCHA: glob patterns against gitignored paths (e.g. `packages/desktop/dist/...`,
  `**/*.dmg`) return "No files found" even when the artifacts exist - the search
  tools honor ignore files. A successful build hand's report was nearly treated
  as false because two glob checks came back empty.
- FIX: verify artifact existence with filesystem commands through a hand
  (`ls`, `stat -f "%N %z bytes" <path>`), never with glob/grep, for anything
  under an ignored path (dist/, node_modules/, build outputs).
- ALSO HIDDEN: plain `git status --short` is a THIRD hider (2026-09-26). A plan
  file written to `.opencode/plans/` (ignored by `.opencode/.gitignore:2:plans`)
  made `git status --short .opencode/plans/` return EMPTY although `ls` showed
  4296 bytes on disk — a correctly written file that looks untracked-nothing.
  "file missing" and "file ignored" MUST be distinguished before any
  missing-verdict; the empty result is a claim about visibility, not existence.
  Discriminate with `git check-ignore -v <path>` (names the exact rule that
  matched) or `git status --short --ignored <path>` (shows `!!` entries).
- ACCEPTANCE GATE: artifact checks on gitignored paths quote `stat` output
  (path + byte size). Before ANY missing-verdict on any path, run
  `git check-ignore -v <path>` (names the rule) or `git status --short --ignored`
  (shows `!!`) — a single tool's empty result is NEVER a missing-verdict, whether
  that tool is glob, Read, or plain `git status`.
