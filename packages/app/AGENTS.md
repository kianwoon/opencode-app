## Priorities

- Prioritise, in this order: stability, simplicity, performance.
- Before changing session or timeline code, record a production benchmark baseline and compare it after the change.

## Model Visibility Semantics

- `visible()` in `src/context/models.tsx` is the single source of truth for both the Settings → Models switches and the session model dropdown.
- A provider is "manually curated" once `store.user` holds ANY explicit visibility entry (show or hide) for it — selecting a model also writes `show`. Untouched models of a curated provider are hidden; only explicit `show` entries appear.
- Providers with no explicit entries keep smart defaults (recent "latest" releases, plus models without a valid release date — which is why uncurated OpenRouter shows many models).
- Do not add a second visibility path for the dropdown; change `visible()` so settings switches and the dropdown can never disagree.

## Paste Screenshot Gotchas

- macOS surfaces copied images as `image/tiff` in `ClipboardEvent.clipboardData.items`; `ACCEPTED_IMAGE_TYPES` intentionally excludes TIFF (no provider accepts it on the wire). Never add `image/tiff` to the accepted set — convert to PNG instead.
- Conversion happens via `platform.readClipboardImage()` (Electron IPC `clipboard.readImage().toPNG()` on desktop, `navigator.clipboard.read()` on web, defined in `src/entry.tsx`). In both `src/components/prompt-input/attachments.ts` and `@opencode-ai/session-ui` v2 attachments, the paste handler must retry through `readClipboardImage` when `clipboardData` files are REJECTED — an early `return` after `addAttachments(files)` makes the native fallback unreachable and reintroduces the "paste screenshot does nothing" bug. Acceptance guard: `attachments.test.ts` "retries rejected clipboard images through the native PNG reader".

## Font Setting Gotchas

- Composite utility classes like `.text-14-regular` set `font-family` themselves and appear LATER in the compiled CSS than Tailwind arbitrary classes, so a class-based font override on the same element loses the cascade. When applying a user-configurable font to an element that uses composite utilities (legacy composer editor/placeholder), pass the font through inline `style` — inline styles beat every cascade rule. This mirrors how `terminal.tsx` feeds `terminalFontFamily(...)` into xterm options. Acceptance guard: live CDP check that `getComputedStyle(composer).fontFamily` reflects the configured Message Font.
- Every appearance setting needs BOTH an emitter and a consumer. Emitting `--font-family-message--weight/--color` without any CSS reading them makes the controls silently do nothing (this shipped once). New-layout rules can also hard-overwrite values at higher specificity (`body[data-new-layout] [data-component="user-message"] { font-weight: 440 }`) — parameterize those rules with the setting var instead of duplicating hardcoded values.
- Desktop persists app settings in `~/Library/Application Support/ai.opencode.desktop/default.dat` (JSON-in-JSON, escaped quotes) — NOT localStorage. Read it when debugging whether a settings change saved.

## Debugging

- NEVER try to restart the app, or the server process, EVER.

## Local Dev

- `opencode dev web` proxies `https://app.opencode.ai`, so local UI/CSS changes will not show there.
- For local UI changes, run the backend and app dev servers separately.
- Backend (from `packages/opencode`): `bun run ./src/index.ts serve --port 4096`
- App (from `packages/app`): `bun dev -- --port 4444`
- Open `http://localhost:4444` to verify UI changes (it targets the backend at `http://localhost:4096`).

## SDK client shape gotcha

- `@opencode-ai/sdk` is a workspace symlink; TypeScript resolves the BUILT `dist/v2` types, so newly generated SDK methods only appear in the app after `bun run build` in `packages/sdk/js`.
- On `OpencodeClient`, v1 routes hang off `client.app.*` (e.g. `client.app.skill.remove` → `DELETE /skill/:name`) while v2 `/api/*` routes hang off `client.v2.*` (e.g. `client.v2.skill.remove` → `DELETE /api/skill/:name`). A getter directly on `OpencodeClient` is the legacy v1 surface.
- `@opencode-ai/client` (the promise/effect `api.*` surface in `useServerSDK().api`) is a VENDORED tarball (`file:vendor/opencode-ai-client-*.tgz`); it does NOT gain newly added protocol endpoints until a new tarball is published and the dependency is bumped.

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## i18n parity gotcha

- Adding a NEW key to `src/i18n/en.ts` is not enough: `src/i18n/parity.test.ts` fails unless the key also exists in EVERY locale file in `src/i18n/` (~60 files). New user-visible strings (dialogs, commands, placeholders) must be added and translated to all locales, positioned consistently (near the related key) so the parity test passes.
- New plural families must use `.one`/`.other` suffixes in `en.ts` with `{{count}}` in BOTH, and the base key must be registered in the `PluralKey` union in `src/context/language.tsx`. Locales with extra CLDR plural categories (from `desktopNativePluralCategories`, e.g. `ru` needs `.few`/`.many`, `ar` needs `.zero`/`.two`/`.few`/`.many`, `sl` needs `.two`/`.few`) must carry those exact variants, and EVERY variant including duals like `ar`/`sl` `.two` must contain the `{{count}}` placeholder or the placeholder-parity test fails even when key parity passes.
- The `bun test` suite from `packages/app` currently has PRE-EXISTING failures unrelated to feature work: the i18n parity test (missing `settings.general.row.fontWeight.*` / `sidebar.vacuum.*` keys added to en.ts but not yet translated) and a solid-js SSR `SyntaxError: Export named 'use' not found` in `src/context/comments.test.ts`. Verify whether a failure is caused by your change by checking the specific missing keys / files before chasing it.

## Localization

- NEVER hardcode user-visible English strings in production code. ALWAYS use an i18n key for visible copy, placeholders, accessible labels, tooltips, menus, dialogs, toasts, empty states, and displayed errors.
- When migrating existing copy to i18n, preserve the English text byte-for-byte unless the task explicitly requests a copy change.
- NEVER change existing English text or English keys to facilitate translation. English is intentional, designer-written source copy; adapt locale-specific translations and i18n mechanics around it.
- Keep locale complexity behind the shared typed i18n APIs. Feature and component code should use `language.t(...)` for ordinary copy and `language.plural(baseKey, count, params)` for count-sensitive copy. It must not inspect the locale, call `Intl.PluralRules`, construct or select plural-category keys such as `.one` or `.other`, or branch on locale-specific grammar.
- Prefer complete translated phrases. Do not concatenate grammatical fragments or make call sites assemble sentences. Keep placeholders to irreducible dynamic values such as names, paths, and counts.
- If a translation cannot be expressed by the current API, deepen the shared language/UI i18n module so one typed call owns locale selection, plural resolution, fallback, and interpolation. Do not leak that machinery into product code.
- Do not translate from model knowledge alone. Verify terminology and grammar with Unicode CLDR locale/plural data, Microsoft Localization Style Guides and terminology, Apple localization/style guidance and localized platform UI, Mozilla localization style guides, Mozilla Pontoon, and the Firefox localization corpus at `github.com/mozilla-l10n/firefox-l10n`.
- For developer-facing terminology, prefer the words already used by the target language's developer community over literal dictionary translations. Cross-check maintained localized developer products such as Firefox, KDE, and VS Code; use at least two independent corpora when they are available. If established practice keeps an English loanword or acronym, keep it rather than inventing a translation.
- Translate complete UI phrases in context. A glossary hit is evidence, not permission to translate word-by-word. Check terse labels such as session, prompt, agent, model, fork, shell, terminal, workspace, and worktree in the same grammatical role before choosing a term.
- Before a locale is ready, audit recurring concepts for one consistent translation and review every value that still equals English. Classify retained English as a product name, provider/tool name, URL, code token, keyboard legend, acronym, asset name, or established borrowing; translate unexplained leftovers.
- In translation review notes, name the corpora used and call out uncertain or region-specific terminology so native speakers can focus review where it matters.
- Also use the relevant language authority or official dictionary for the locale (for example RAE/Fundéu, FranceTerme, Duden, TDK, Kotus/Kielitoimiston sanakirja, Språkrådet/Bokmålsordboka, Rada Języka Polskiego/PWN, the Russian and Arabic language academies, the Ukrainian Orthography, Taiwan MOE dictionaries, or the Royal Society of Thailand). Treat the English dictionary as the semantic source of truth and preserve placeholders, code identifiers, product names, and keyboard labels.

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.

## Browser Automation

Use `agent-browser` for web automation. Run `agent-browser --help` for all commands.

Core workflow:

1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes

## Titlebar tab strip gotchas

- Tab display order vs store order: `TitlebarTabStrip` renders `displayTabs()` (running/busy session tabs pinned rightmost), NOT the persisted store order from `useTabs()`. The persisted tabs store (`opencode.window.browser.dat:tabs` in localStorage) keeps open order; drag-reorder maps through `displayTabs`, so keep that mapping intact when touching ordering logic.
- A session tab's running state is read per-server: find the connection via `ServerConnection.key(item) === tab.server` in `global.servers.list()`, then `global.ensureServerCtx(conn).sync.session.data.session_working(tab.sessionId)`. `session_working` = `session_status[id]?.type !== "idle"`.
- Testing busy tabs WITHOUT a real model run: the app bootstraps `session_status` from GET `/session/status` (global-sync/bootstrap.ts), so a Playwright `context.route("**/session/status*")` returning a StatusMap `{ "<sessionID>": {"type":"busy"} }` + page.reload is the reliable stub. There is NO server-side event publish endpoint (POST /event and POST /api/event return the SPA fallback HTML — they are GET-only SSE streams), and Playwright `route.fulfill` cannot stream infinite SSE, so SSE-injection does NOT work. Wire shape (packages/schema/src/session-status-event.ts): `{type:"idle"} | {type:"busy"} | {type:"retry",attempt,message,...}`.
- Session tab routes: `/server/:serverKey/session/:id` where serverKey is the BASE64 of the server URL (`btoa("http://localhost:4096")`), not URL-encoding. Navigating there adds the tab (session.tsx ResolvedTargetSessionRoute effect). Tab slot selector: `[data-titlebar-tab-slot]` with `data-tab-key` = `server + "\n" + href` — match tabs by `dataset.tabKey.includes(sessionId)`.

## Project close paths (2026-09-04 lesson)

- There are THREE independent project-close entry points, and any tab/sidebar side effect must be wired into ALL of them: (1) legacy sidebar `closeProject` in `pages/layout.tsx`, (2) new-layout sidebar `closeProject` in `pages/layout/sidebar-v2.tsx`, (3) home screen project "..." menu → `project.close` in `pages/home/home-projects-controller.tsx` → `closeHomeProject` in `pages/layout/helpers.ts`. A fix applied to only the sidebar paths silently misses the home path (costed a full rebuild round-trip on 2026-09-04: user closed from home menu, tabs stayed open despite sidebar fixes being verified in the asar).
- Shared tab cleanup lives in `tabs.removeProjectTabs({ server, directories, sessionDirectory })` (context/tabs.tsx); pure matching logic is `projectSessionIDs` in `context/project-tabs.ts` (kept out of tabs.tsx because importing tabs.tsx in tests pulls in the router and explodes with "Client-only API called on the server side").
