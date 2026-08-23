#!/usr/bin/env bun
/**
 * Verify that fork-specific enhancements survive an upstream merge.
 *
 * This script checks that every file/feature our fork intentionally
 * maintains is still present after merging upstream changes. If any
 * signature is missing, it fails loudly — preventing the "silent
 * fork enhancement loss" bug from happening again.
 *
 * Usage:
 *   bun scripts/verify-fork-integrations.ts
 *
 * Guardrail: run this BEFORE pushing any upstream merge to the fork.
 * If it fails, do NOT push — resolve the missing signatures first.
 */
import { $ } from "bun"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")

// ── Fork enhancement signatures ──────────────────────────────────────
// Each entry is a { label, check } pair. The check function returns true
// if the enhancement is still present. These are the features that MUST
// survive every upstream merge; if one is missing, the merge is wrong.
const CHECKS: Array<{ label: string; check: () => boolean | Promise<boolean> }> = [
  // ── App UI enhancements ──────────────────────────────────────────
  {
    label: "sidebar-v2.tsx",
    check: () => existsSync(resolve(ROOT, "packages/app/src/pages/layout/sidebar-v2.tsx")),
  },
  {
    label: "sidebar-shell.tsx",
    check: () => existsSync(resolve(ROOT, "packages/app/src/pages/layout/sidebar-shell.tsx")),
  },
  {
    label: "per-project session cleanup (last 5)",
    check: () => grep("packages/app/src/app.tsx", "cleanupSession"),
  },
  {
    label: "collapse option after expanding all",
    check: () => existsSync(resolve(ROOT, "packages/app/src/components/session-list-collapse.tsx")),
  },
  {
    label: "session status indicators",
    check: () => grep("packages/app/src/components/session-status.tsx", "SessionStatus"),
  },
  {
    label: "window-title.ts (desktop window labels)",
    check: () => {
      const f = resolve(ROOT, "packages/app/src/components/window-title.ts")
      return existsSync(f) && grep(f, "windowTitle")
    },
  },
  {
    label: "window-title.test.ts",
    check: () => existsSync(resolve(ROOT, "packages/app/src/components/window-title.test.ts")),
  },
  {
    label: "desktop-menu.ts",
    check: () => existsSync(resolve(ROOT, "packages/app/src/desktop-menu.ts")),
  },
  {
    label: "dialog-search.tsx",
    check: () => existsSync(resolve(ROOT, "packages/app/src/components/dialog-search.tsx")),
  },
  {
    label: "titlebar.tsx",
    check: () => existsSync(resolve(ROOT, "packages/app/src/components/titlebar.tsx")),
  },

  // ── Desktop enhancements ─────────────────────────────────────────
  {
    label: "RAM memory management",
    check: () => existsSync(resolve(ROOT, "packages/desktop/src/main/memory.ts")),
  },
  {
    label: "database vacuum button",
    check: () => grep("packages/app/src/app.tsx", "vacuumDatabase"),
  },
  {
    label: "file:// chat links clickable",
    check: () => grep("packages/desktop/src/main/apps.ts", "file://"),
  },
  {
    label: "sidecar stop before quit",
    check: () => grep("packages/desktop/src/main/apps.ts", "sidecar"),
  },
  {
    label: "auto-updater disabled for local builds",
    check: () => grep("packages/desktop/package.json", "autoUpdater") || grep("packages/desktop/src/main/updater.ts", "disabled"),
  },
  {
    label: "channel propagation in prebuild",
    check: () => grep("packages/desktop/scripts/prebuild.ts", "channel"),
  },

  // ── Provider / Core enhancements ─────────────────────────────────
  {
    label: "@ai-sdk/deepseek provider",
    check: () => grep("packages/opencode/src/provider/provider.ts", "@ai-sdk/deepseek"),
  },
  {
    label: "prompt cache affinity (openrouter)",
    check: () => grep("packages/core/src/session/runner/llm.ts", "openrouter: { promptCacheKey }"),
  },
  {
    label: "retry truncated provider streams",
    check: () => grep("packages/opencode/src/session/provider.ts", "retryTruncated"),
  },
  {
    label: "MCP retry on transient spawn failures",
    check: () => grep("packages/opencode/src/mcp/client.ts", "spawn.*retry") || grep("packages/opencode/src/mcp/client.ts", "retry"),
  },
  {
    label: "dedupe permission requests (Chinese)",
    check: () => {
      // Search for the deduplication logic
      return grep("packages/opencode/src/permission/permission.ts", "dedupe")
    },
  },
  {
    label: "external plugin changes after startup batch",
    check: () => grep("packages/core/src/v1/plugin.ts", "batch"),
  },
  {
    label: "ignore failed compaction summaries",
    check: () => grep("packages/core/src/session/compaction.ts", "ignore.*failed"),
  },
  {
    label: "output token limit truncation error",
    check: () => {
      const f = resolve(ROOT, "packages/opencode/src/session/llm/ai-sdk.ts")
      return existsSync(f) && (grep(f, "output.*token.*limit") || grep(f, "truncat"))
    },
  },
  {
    label: "PowerShell command encoding",
    check: () => grep("packages/opencode/src/shell/shell.ts", "PowerShell") || grep("packages/opencode/src/shell/shell.ts", "powershell"),
  },
  {
    label: "keep shell tail on oversized lines",
    check: () => grep("packages/opencode/src/shell/tail.ts", "tail"),
  },
  {
    label: "child process exit signal resolution",
    check: () => grep("packages/core/src/v1/state.ts", "exit.*signal"),
  },
  {
    label: "skip tool files that fail to load",
    check: () => grep("packages/opencode/src/tool/tool.ts", "skip.*fail"),
  },
  {
    label: "V2 messages.transform plugin domain",
    check: () => grep("packages/core/src/v1/plugin.ts", "messages.transform"),
  },

  // ── Compaction enhancement ───────────────────────────────────────
  {
    label: "compaction: keep complete recent turns",
    check: () => grep("packages/core/src/session/compaction.ts", "complete.*recent"),
  },

  // ── IME/composer enhancements ────────────────────────────────────
  {
    label: "hide placeholder during IME composition (app)",
    check: () => grep("packages/app/src/components/prompt-input.tsx", "composingText"),
  },
  {
    label: "hide placeholder during IME composition (session-ui)",
    check: () => grep("packages/session-ui/src/v2/components/prompt-input/index.tsx", "composingText"),
  },
  {
    label: "guard v2 Enter against Safari IME confirm",
    check: () => grep("packages/session-ui/src/v2/components/prompt-input/index.tsx", "isComposing"),
  },
  {
    label: "track IME composition end (app)",
    check: () => grep("packages/app/src/components/prompt-input.tsx", "compositionend"),
  },
  {
    label: "preserve caret after prompt editor rebuild",
    check: () => existsSync(resolve(ROOT, "packages/app/e2e/regression/prompt-caret-after-mention.spec.ts")),
  },
  {
    label: "keep v2 editor inert during IME composition",
    check: () => grep("packages/session-ui/src/v2/components/prompt-input/index.tsx", "inert"),
  },

  // ── Message font feature ─────────────────────────────────────────
  {
    label: "messageFont in settings interface",
    check: () => grep("packages/app/src/context/settings.tsx", "messageFont"),
  },
  {
    label: "messageFontFamily helper",
    check: () => grep("packages/app/src/context/settings.tsx", "messageFontFamily"),
  },
  {
    label: "fontColor helper",
    check: () => grep("packages/app/src/context/settings.tsx", "fontColor"),
  },
  {
    label: "fontWeightSelectProps helper",
    check: () => grep("packages/app/src/components/settings-general.tsx", "fontWeightSelectProps"),
  },
  {
    label: "FontColorControls component",
    check: () => grep("packages/app/src/components/settings-general.tsx", "FontColorControls"),
  },
  {
    label: "messageFont in prompt-input (composer font)",
    check: () => grep("packages/app/src/components/prompt-input.tsx", "messageFont"),
  },
  {
    label: "session-ui markdown CSS font-family",
    check: () => grep("packages/session-ui/src/components/markdown.css", "font-family-message"),
  },
  {
    label: "session-ui message-part CSS font-family",
    check: () => grep("packages/session-ui/src/components/message-part.css", "font-family-message"),
  },
  {
    label: "session-ui v2 prompt-input font-family",
    check: () => grep("packages/session-ui/src/v2/components/prompt-input/index.tsx", "font-family-message"),
  },
  {
    label: "session-ui v2 attachments.css font-family",
    check: () => grep("packages/session-ui/src/v2/components/prompt-input/attachments.css", "font-family-message"),
  },
  {
    label: "ui theme.css font-family-message",
    check: () => grep("packages/ui/src/v2/styles/theme.css", "font-family-message"),
  },
  {
    label: "settings-font.test.ts",
    check: () => existsSync(resolve(ROOT, "packages/app/src/context/settings-font.test.ts")),
  },
  {
    label: "messageFont i18n keys in en.ts",
    check: () => grep("packages/app/src/i18n/en.ts", "messageFont"),
  },
  {
    label: "fontWeight i18n keys in en.ts",
    check: () => grep("packages/app/src/i18n/en.ts", "fontWeight"),
  },
  {
    label: "fontColor i18n keys in en.ts",
    check: () => grep("packages/app/src/i18n/en.ts", "fontColor"),
  },
  {
    label: "sidebar.vacuum i18n keys in en.ts",
    check: () => grep("packages/app/src/i18n/en.ts", "sidebar.vacuum"),
  },
  {
    label: "desktop.toast.memory.recovered i18n keys in en.ts",
    check: () => grep("packages/desktop/src/renderer/i18n/en.ts", "desktop.toast.memory"),
  },

  // ── Review enhancements ──────────────────────────────────────────
  {
    label: "route review diffs through workspace",
    check: () => grep("packages/app/src/components/review.tsx", "workspace"),
  },
  {
    label: "scope review panel to session's own file changes",
    check: () => grep("packages/app/src/components/review.tsx", "session"),
  },

  // ── check-upstream script ────────────────────────────────────────
  {
    label: "check-upstream.ts script",
    check: () => existsSync(resolve(ROOT, "scripts/check-upstream.ts")),
  },
]

function grep(filePath: string, pattern: string): boolean {
  try {
    const resolved = resolve(ROOT, filePath)
    const content = readFileSync(resolved, "utf8")
    return content.includes(pattern)
  } catch {
    return false
  }
}

async function main() {
  console.log("🔍 Verifying fork enhancement signatures after upstream merge...")
  console.log("")

  let passed = 0
  let failed = 0
  const failures: string[] = []

  for (const { label, check } of CHECKS) {
    const ok = await Promise.resolve(check())
    if (ok) {
      console.log(`  ✅ ${label}`)
      passed++
    } else {
      console.log(`  ❌ ${label} — MISSING or modified`)
      failed++
      failures.push(label)
    }
  }

  console.log("")
  console.log(`Results: ${passed} passed, ${failed} failed`)

  if (failed > 0) {
    console.log("")
    console.log("⚠️  FORK ENHANCEMENTS ARE MISSING!")
    console.log("   The following fork-specific features were lost during the upstream merge:")
    for (const f of failures) {
      console.log(`     - ${f}`)
    }
    console.log("")
    console.log("   DO NOT PUSH. Recover the missing files before proceeding.")
    console.log("   See: packages/opencode/AGENTS.md 'Upstream Merge Protocol'")
    process.exit(1)
  }

  console.log("")
  console.log("✅ All fork enhancements survived the upstream merge.")
}

await main()