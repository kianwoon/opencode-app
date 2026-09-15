// Execution Guard — policy evaluation (pure, no Effect).
//
// Two enforcement tiers, both fail-CLOSED for privileged shapes:
//
//   DENY  (throw from tool.execute.before):
//     - `curl … | sh` / `wget … | bash` / `… |& sh` (remote code executed unseen)
//     - `bash <(curl …)` / `sh -c "$(curl …)"` / `eval $(curl …)` (fetcher inside
//       a process/command substitution feeding a shell)
//     - a dependency resolved from a URL or git remote (`npm i github:…`,
//       `pip install git+https://…`, `pip install https://…whl`). These stay
//       HARD-DENIED: no plugin-side prompt path exists. Plain registry installs
//       ARE prompted — tool/shell.ts issues `ctx.ask({permission:
//       "package_install"})` before exec, default rule `ask`.
//
//   ALLOW (zero / allowlisted secrets decided by subsets.ts):
//     - plain registry installs, builds, tests, etc.
//
// Denial messages name the SHAPE only — never a value — so they are safe to
// surface to a potentially hostile model.

import { segments } from "./classify"

export type Denial = {
  readonly code: "pipe_to_shell" | "remote_dependency"
  readonly message: string
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"])
const FETCHERS = new Set(["curl", "wget"])
const URL_DEP = /^(?:git\+|github:|gitlab:|bitbucket:|https?:\/\/|git@|ssh:\/\/)/i

function tokens(segment: string): string[] {
  return (segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ""))
}

/** Basename of a token so `/bin/sh` and `/usr/bin/curl` are recognised. */
function basename(token: string): string {
  return token.split("/").pop() ?? token
}

function isShell(token: string | undefined): boolean {
  return token !== undefined && SHELLS.has(basename(token))
}

function isFetcher(token: string | undefined): boolean {
  return token !== undefined && FETCHERS.has(basename(token))
}

/** `curl … | sh` / `|&` style: a fetcher piped into a shell interpreter. */
function pipeToShell(command: string): boolean {
  // Inspect per operator so a `;`-separated chain does not create a false
  // positive (only a pipe connects producer to interpreter). `|&` (pipe stdout
  // AND stderr) is treated identically to `|`.
  return command
    .split(/&&|[;\n]/)
    .filter((part) => part.includes("|"))
    .some((part) => {
      const stages = part.split(/\|&?/).map((stage) => tokens(stage.trim()))
      let sawFetcher = false
      for (const stage of stages) {
        const head = stage[0]
        if (!head) continue
        if (isFetcher(head)) sawFetcher = true
        // A shell interpreter as a downstream stage of a fetcher is RCE.
        if (sawFetcher && (isShell(head) || (basename(head) === "sudo" && isShell(stage[1])))) return true
      }
      return false
    })
}

/** `bash <(curl …)` — process substitution feeding a shell; or a fetcher inside
 *  a `$(…)` command substitution adjacent to a shell/`eval` token
 *  (`sh -c "$(curl …)"`, `eval $(curl …)`). Both execute remote code unseen. */
function substitutionToShell(command: string): boolean {
  const list = tokens(command)
  const shellPresent = list.some((token) => isShell(basename(token)) || basename(token) === "eval")
  if (!shellPresent) return false
  // Process substitution: a `<(` (or `>(`) anywhere with a fetcher inside it.
  if (/[<>]\([^)]*\b(?:curl|wget)\b/.test(command)) return true
  // Command substitution: `$( … curl … )` or backtick form.
  if (/\$\([^)]*\b(?:curl|wget)\b/.test(command)) return true
  return false
}

/** A remote (git/URL) dependency in a package-manager install command. */
function remoteDependency(command: string): boolean {
  return segments(command).some((segment) => {
    const list = tokens(segment)
    const head = list[0]
    if (!head) return false
    const install = list.some((token) => token === "install" || token === "add" || token === "require" || token === "get")
    if (!install) return false
    return list.some((token) => URL_DEP.test(token))
  })
}

/** Evaluates the deny tier. Returns a Denial when the command must be blocked. */
export function evaluate(command: string): Denial | undefined {
  if (pipeToShell(command) || substitutionToShell(command))
    return {
      code: "pipe_to_shell",
      message:
        "Execution Guard blocked a curl/wget pipe into a shell interpreter. Download the script, review it, then run it from disk with an explicit tool call.",
    }
  if (remoteDependency(command))
    return {
      code: "remote_dependency",
      message:
        "Execution Guard blocked an install from a URL or git remote (dependency source is not a registry package). Automatic approval is unavailable, so approve manually: run the install yourself in the terminal, or pin a published registry version. Report to the user that this needs manual approval.",
    }
  return undefined
}

export * as Policy from "./policy"
