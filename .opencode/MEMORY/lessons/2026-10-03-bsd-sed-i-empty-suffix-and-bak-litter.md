# bsd-sed-i-empty-suffix-and-bak-litter

- **Date**: 2026-10-03T03:03:43+0800
- **Type**: lesson

## What happened

A hand's first sed attempt used a backup suffix and reported success while writing nothing: BSD sed on macOS does not support Perl-style \s in patterns (the match silently failed), and the .bak copies it created inflated a later grep verification count (127 hits counted .bak files), making the failed write look verified.

## Root cause / fix

On macOS use sed -i '' with POSIX character classes ([[:space:]] not \s), then verify by grepping ONLY the real target files (git status --short first to spot .bak litter) with an exact per-file assertion, not a directory-wide count; delete any .bak litter before committing.
