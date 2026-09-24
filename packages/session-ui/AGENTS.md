# session-ui

Session-rendering UI package (`@opencode-ai/session-ui`): message parts, session diffs, markdown streaming, prompt input, and shared session context. Consumed by `app` and desktop; built on top of `ui`.

## Scope ownership

- `session-ui` owns session-specific rendering: message parts, session diff, markdown stream/cache, prompt input (incl. `v2/`), session context providers, and the vendored `pierre/` code.
- `packages/ui` owns generic components, theming, icons, and i18n infrastructure. Do not copy or re-implement `ui` primitives here; import from `@opencode-ai/ui` instead.
- `packages/app` owns pages/routing/app shell, not session rendering internals.

## Import direction

- `session-ui` may import `ui`; never the reverse. `app` may import both. Keep `session-ui` free of app-specific state/routing.

## Commands

- `bun typecheck` from this package dir (never `tsc` directly, never from repo root).
- `bun test src --only-failures` from this package dir.

## Localization

Follow `packages/ui/AGENTS.md` (## Localization) — full i18n rules live there and apply here unchanged; do not duplicate them. In short: never hardcode user-visible English strings, use i18n keys, preserve English copy byte-for-byte, verify translations against the corpora listed in `ui`'s guide.

## SelectV2 / Kobalte gotcha

The Kobalte Select VIRTUAL-focus / `onFocusOutside` dismissal gotcha is documented in `packages/ui/AGENTS.md` (## SelectV2 / Kobalte focus gotcha). Read it before touching any Select usage here; do not remove the `preventDefault` guard.

## Bun test seam for message-part

Importing `message-part.tsx` from a Bun unit test transitively loads the Vite-only `markdown.worker.ts?worker&url` module and fails before assertions. Keep pure task-session resolution and left-click logic in `message-part-task.ts`, and test that module directly; do not mock the worker.

Acceptance gate:

`cd packages/session-ui && bun test src/components/message-part-task.test.ts --only-failures && bun typecheck`

The focused test must report 1 passed/0 failed, typecheck must exit 0, and no worker-module load error may occur.
