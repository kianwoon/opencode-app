# Disabling an opencode plugin requires a directory move, not just config-array removal

## Gotcha

Removing a `plugin[]` entry from `opencode.json` does NOT disable a plugin.
`ConfigPlugin.load(dir)` globs `{plugin,plugins}/*.{ts,js}` in each config dir
(`packages/opencode/src/config/plugin.ts:28`) and auto-loads every match — the
explicit `plugin[]` array is additive, not the load path. `.test.`/`.spec.`
files are excluded from discovery (they historically killed the server at
module scope). Discovery is memoized per process, so an already-running
desktop/server keeps the old set until restart.

## Fix pattern

1. Timestamped backup of the config first (directory convention:
   `opencode.json.bak-<reason>-<ts>`).
2. Remove the stale `plugin[]` entry (hygiene; it references the same file).
3. Move the plugin file out of the auto-globbed dir into `plugins-disabled/`
   (this config's established toggle convention). `plugin-lib/` modules are
   NOT globbed (only literal `plugin`/`plugins` dirs match) and can stay.

## Acceptance gate

1. `JSON.parse` of `opencode.json` exits 0 and grep finds zero references to
   the disabled plugin in it.
2. Loader-equivalent check:
   `Bun.Glob("{plugin,plugins}/*.{ts,js}").scan({cwd: <config-dir>})` returns
   no hit for the plugin.
3. Next fresh session: no gate block fired and no new rows in the plugin's
   log (e.g. `~/.local/share/opencode/premise-gate.log`).

## Cost of missing it

2026-10-21: removing only the array entry would have left the premise-gate
active in every new session while looking fixed — caught by reading the loader
source before declaring done.
