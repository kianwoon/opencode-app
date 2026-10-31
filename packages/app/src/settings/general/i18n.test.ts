import { describe, expect, test } from "bun:test"
import { dict } from "@/runtime/i18n/en"

// The settings panels render their copy from the catalog, so a referenced key
// that the catalog does not carry renders as empty text on a shipped page. This
// test is the contract that every key these panels ask for exists in English.
const PANELS = ["subagent.tsx", "permissions.tsx"]

// Keys built from a template at the call site rather than written as a literal:
// the mode and action pickers and the tool inventory rows.
const DYNAMIC_KEYS = [
  ...["subagent", "primary", "all"].map((mode) => `settings.subagent.mode.${mode}`),
  ...["allow", "ask", "deny"].map((action) => `settings.permissions.action.${action}`),
  ...[
    "read",
    "list",
    "glob",
    "grep",
    "edit",
    "write",
    "apply_patch",
    "bash",
    "external_directory",
    "task",
    "plan",
    "plan_enter",
    "plan_exit",
    "question",
    "todowrite",
    "todoread",
    "workflow",
    "doom_loop",
    "webfetch",
    "websearch",
    "skill",
    "lsp",
    "tool_search",
    "cua_batch",
    "ui_nav",
    "session_rename",
    "package_install",
  ].flatMap((tool) => [
    `settings.permissions.tool.${tool}.title`,
    `settings.permissions.tool.${tool}.description`,
  ]),
]

describe("settings panel copy", () => {
  test("every key the subagent and permissions panels reference is in en.ts", async () => {
    // Every quoted catalog literal in these files is a key, including the ones a
    // ternary picks between and the OWNS_GROUPS labels handed to language.t.
    const referenced = await Promise.all(
      PANELS.map(async (panel) => {
        const source = await Bun.file(new URL(panel, import.meta.url)).text()
        return [...source.matchAll(/"(settings\.[A-Za-z0-9_.]+|common\.[A-Za-z0-9_.]+)"/g)].map((match) => match[1])
      }),
    )

    const missing = [...referenced.flat(), ...DYNAMIC_KEYS].filter((key) => dict[key as keyof typeof dict] === undefined)

    expect([...new Set(missing)]).toEqual([])
  })
})
