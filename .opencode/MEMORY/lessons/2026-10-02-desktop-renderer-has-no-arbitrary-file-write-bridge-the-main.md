# Desktop renderer has no arbitrary file-write bridge (the main process does)

- **Date**: 2026-10-02T00:37:13+0800
- **Type**: lesson

## What happened

The app is Electron and the MAIN process has full fs (it writes settings default.dat, logs, export-debug-logs). The RENDERER only gets what packages/desktop/src/preload/index.ts exposes: file PICKING (openFilePicker/openDirectoryPicker/saveFilePicker), readPickedFile, store-*, draft-*, openPath, revealPath, readClipboardImage - and saveFilePicker returns a PATH but nothing writes content to it. The server file API is list/read/status only, also no write. That is why the Settings -> Subagent System prompt row was read-only for md-backed agents: the md BODY IS the prompt (config/agent.ts sets prompt: md.content.trim(), and md wins over config via config.ts:482), and the panel had no write path. Stating 'the app cannot write a file' is WRONG - the main process can; the renderer has no wired path.

## Root cause / fix

To let a UI control edit a user file: (1) expose the file PATH from the server (Agent.Info.originPath, set post-decode in config/agent.ts so it stays out of the user config surface); (2) add a SCOPED IPC pair in packages/desktop/src/main/ipc.ts (read-file/write-file, guarded to agent markdown under a config agent/ root) + preload/index.ts + preload/types.ts ElectronAPI; (3) surface it via the app platform context (PlatformBase optional readFile?/writeFile? in packages/app/src/context/platform.tsx). Preserve md frontmatter: split /^---\r?\n[\s\S]*?\r?\n---\r?\n?/ off and PREPEND it back, never regenerate. External writes are not hot-reloaded - force Config.invalidate() with a no-op config write (the panel's commit/updateConfig path) after saving.
