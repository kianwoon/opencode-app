# Desktop package notes

- Renderer process should only call `window.api` from `src/preload`.
- Main process should register IPC handlers in `src/main/ipc.ts`.
- NEVER hardcode user-visible English strings in production code. ALWAYS use an i18n key for native menus, picker titles, dialogs, buttons, accessible labels, and displayed errors.
- When migrating existing copy to i18n, preserve the English text byte-for-byte unless the task explicitly requests a copy change.
- NEVER change existing English text or English keys to facilitate translation. English is intentional, designer-written source copy; adapt locale-specific translations and i18n mechanics around it.
- Keep locale and grammar logic in the shared typed i18n layer. Renderer code should resolve copy through the app language API, and the main process should consume typed native-translation bundles through `nativeT(...)`; native menus, dialogs, and IPC handlers must not inspect locales, choose plural categories, or assemble translated sentence fragments.
- Prefer complete translated phrases with only irreducible dynamic placeholders. If native UI needs richer grammar, deepen the shared bundle/API instead of adding locale branches to desktop feature code.
- Do not translate from model knowledge alone. Verify terminology and grammar with Unicode CLDR locale/plural data, Microsoft Localization Style Guides and terminology, Apple localization/style guidance and localized platform UI, Mozilla localization style guides, Mozilla Pontoon, and the Firefox localization corpus at `github.com/mozilla-l10n/firefox-l10n`.
- For developer-facing terminology, prefer established usage in the target language's developer community over literal translations. Cross-check maintained Firefox, KDE, and VS Code localizations, using at least two independent corpora when available. Keep established English loanwords and acronyms instead of inventing unfamiliar terms.
- Translate whole native-menu and dialog phrases in context. Audit recurring concepts for consistency and review every exact-English value; retain it only when it is an intentional product/provider/tool name, URL, code token, keyboard legend, acronym, asset name, or established borrowing.
- Record the corpora used and flag uncertain or regional terminology in review notes.
- Also use the relevant language authority or official dictionary for the locale (for example RAE/Fundéu, FranceTerme, Duden, TDK, Kotus/Kielitoimiston sanakirja, Språkrådet/Bokmålsordboka, Rada Języka Polskiego/PWN, the Russian and Arabic language academies, the Ukrainian Orthography, Taiwan MOE dictionaries, or the Royal Society of Thailand). Treat the English dictionary as the semantic source of truth and preserve placeholders, code identifiers, product names, and keyboard labels.

## Packaging a production desktop build

- **`package:mac` does NOT run `prebuild`/`build` automatically.** It packages whatever is already in `out/`. Running it alone silently bundles a stale server with the wrong channel.
- The channel is baked into the server bundle by `prebuild` (via `OPENCODE_CHANNEL`), which runs `../opencode/script/build-node.ts`. The channel determines the app's database: prod → `opencode.db`, otherwise → `opencode-<channel>.db`.
- To produce a **correct production copy**, propagate the channel through the whole chain (both steps, in order):
  1. `OPENCODE_CHANNEL=prod bun run build`  (runs `prebuild` + electron-vite, baking `InstallationChannel = "prod"` into `out/main/chunks/node-*.js`)
  2. `OPENCODE_CHANNEL=prod bun run package:mac`  (packages `.app`/`.dmg`/`.zip`)
- **Acceptance gate**: the `verify-prod.ts` step must print `✅ Verified <channel> build: ... embeds channel "<channel>" and uses <db>`. It aborts (exit 1) on any mismatch — a passing verification is required, never skip or ignore it.
- A dev build and a prod build are visually identical in the UI and file outputs; only `verify-prod.ts` reveals which DB the app connects to. Always confirm the verification output before declaring the build done.
