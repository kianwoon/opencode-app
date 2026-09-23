# Parallel opencode sessions share one working tree — your "git add explicit files" commit can already be swept by another session's commit

Gotcha: while an implementer handoff was running `git add <explicit files>` + `git commit` for reviewed fixes, a SECOND concurrent opencode session committed its own work and swept those same files into its commit (`b549f42bff` carried 10 files: its task.ts work + our 6 app files + memory lessons). The commit handoff then found "nothing to commit" against a clean tree, and the branch sat ahead of origin by 12 commits. Symptom to recognise: `git status --short` clean + `git diff` empty + work you know is uncommitted visible in `git show --stat HEAD` under a foreign subject.

Fix: before any commit handoff, check `git log --oneline -5` and `git show --stat HEAD` for foreign sweeps; if the work is already committed, do NOT rewrite history for attribution (never amend/force-push) — report the commit hash that carries it instead.

Acceptance gate: the intended files are present in `git show --stat HEAD` (or the relevant commit), `git status --short` clean, and the report names the hash that carries each file set.
