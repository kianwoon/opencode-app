# Glob/Read tools respect .gitignore - build artifacts under dist/ are invisible

- 2026-09-26, opencode repo (harness behavior, project-agnostic)
- GOTCHA: glob patterns against gitignored paths (e.g. `packages/desktop/dist/...`,
  `**/*.dmg`) return "No files found" even when the artifacts exist - the search
  tools honor ignore files. A successful build hand's report was nearly treated
  as false because two glob checks came back empty.
- FIX: verify artifact existence with filesystem commands through a hand
  (`ls`, `stat -f "%N %z bytes" <path>`), never with glob/grep, for anything
  under an ignored path (dist/, node_modules/, build outputs).
- ACCEPTANCE GATE: artifact checks on gitignored paths quote `stat` output
  (path + byte size); a "missing" verdict from glob alone is never accepted.
