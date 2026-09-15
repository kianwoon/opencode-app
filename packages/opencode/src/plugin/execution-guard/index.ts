// Execution Guard — plugin hooks (plan §5).
//
// Closes the evil-provider / malicious-package threat: a package install script
// (npm postinstall, pip setup.py, …) must NEVER observe a project `.env` value.
//
// Hook contract (packages/plugin/src/index.ts):
//   tool.execute.before   (input {tool,sessionID,callID}, output {args}) -> throw to block
//   shell.env             (input {cwd,sessionID,callID}, output {env})    -> mutate output.env
//
// `permission.ask` has no plugin trigger call sites, so git/URL dependency
// installs are HARD-DENIED here. Plain registry installs are instead gated by
// the live tool-side permission system: tool/shell.ts calls ctx.ask with
// `permission: "package_install"` (default rule `ask`) before exec. See
// policy.ts for the deny-tier rationale.
//
// ORDERING REQUIREMENT: this plugin must be registered AFTER the Secret Broker
// so its `shell.env` runs after the broker has assigned the allowlisted subset
// — the guard then deletes those keys for zero-secret classes, so deletion wins.
//
// FAIL-CLOSED: a recognised privileged shape that cannot be classified is
// denied (see policy.evaluate). A command that cannot be parsed/classified at
// all is treated as `package_install` (ZERO secrets), never `other` — a false
// install only withholds secrets, a false `other` would leak them.

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Classify } from "./classify"
import { Policy } from "./policy"
import { Stash } from "./stash"
import { zeroSecrets } from "./subsets"

const CLASSIFY_TOOL = "bash"

/** Audit record. Carries the class and KEY NAMES only — never values. */
function audit(event: "deny" | "zero-secret" | "allow", payload: Record<string, unknown>): void {
  console.error(`[execution-guard] ${event}`, payload)
}

/** Builds the plugin Hooks. Stateless beyond the callID→class stash. */
export async function executionGuardPlugin(_input: PluginInput): Promise<Hooks> {
  const stash = new Stash()

  return {
    "tool.execute.before": async (hookInput, output) => {
      if (hookInput.tool !== CLASSIFY_TOOL) return
      const command = (output.args as { command?: unknown } | undefined)?.command
      if (typeof command !== "string" || command.length === 0) return

      // DENY tier runs before classification so a privileged shape can never be
      // reinterpreted as an innocuous class.
      const denial = Policy.evaluate(command)
      if (denial) {
        audit("deny", { sessionID: hookInput.sessionID, code: denial.code })
        throw new Error(denial.message)
      }

      const cls = Classify.classify(command)
      stash.set(hookInput.callID, cls)
      audit("allow", { sessionID: hookInput.sessionID, callID: hookInput.callID, class: cls })
    },

    "shell.env": async (hookInput, output) => {
      const cls = hookInput.callID === undefined ? undefined : stash.getDelete(hookInput.callID)
      // No correlation (no callID, or a shell.env not preceded by a bash
      // before-hook — e.g. the PTY path in pty-environment.ts): the actor is the
      // user at an interactive terminal, not the model, so this is a PLAIN
      // UNKNOWN. Documented behaviour: allow the broker's full allowlisted
      // subset. Ambient process.env is never touched by this plugin. Privileged
      // MODEL-driven shapes are already hard-denied in the before-hook above.
      if (cls === undefined) return
      if (!zeroSecrets(cls)) return
      const names = Object.keys(output.env).sort()
      for (const key of names) delete output.env[key]
      if (names.length > 0) audit("zero-secret", { callID: hookInput.callID, class: cls, keys: names })
    },
  }
}

export default executionGuardPlugin

// Internals exposed for focused tests / advanced wiring.
export { classify, classifySegment, segments, CLASSES, type Class } from "./classify"
export { Stash } from "./stash"
export { evaluate, type Denial } from "./policy"
export { project, zeroSecrets } from "./subsets"
