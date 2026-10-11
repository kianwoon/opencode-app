// INVARIANT: external plugin code under evaluation or init must never be able
// to terminate the host process. Termination attempts are contained as
// catchable errors, and implicit discovery never executes test/spec files.
//
// The proven ocu-guards.test.ts crash (an auto-discovered *.test.ts calling
// process.exit(0) at module scope) is one instance; the same guard also covers
// an npm plugin whose module scope exits, and a *.spec.ts file dropped into a
// plugin directory.
//
// Runtime constraint: this guard must work in BOTH Bun and the desktop app's
// Node sidecar, so it uses no `Bun` global and no Bun-only APIs (same boundary
// as loader.ts bustFileEntry).
//
// Honest boundary: this contains synchronous exits raised while external plugin
// code is being evaluated or initialized — the proven ocu-guards.test.ts class,
// an auto-discovered *.test.ts calling process.exit(0) at module scope. Delayed
// escapes (e.g. setTimeout(() => process.exit())) and full isolation require
// running plugins in a subprocess. This is a best-effort guard, NOT a security
// sandbox.

export class PluginExitAttemptError extends Error {
  constructor(code?: number) {
    super(`Plugin attempted process.exit(${code ?? ""}) during load; exit contained`)
    this.name = "PluginExitAttemptError"
  }
}

let depth = 0
let original: typeof process.exit | undefined

// Reference-counted: the first guarded section installs the override, the last
// one restores it. Concurrent guarded sections therefore share ONE install and
// can never restore the real exit while another section is still running.
export async function guardProcessExit<T>(fn: () => Promise<T>): Promise<T> {
  if (depth === 0) {
    original = process.exit
    process.exit = ((code?: number): never => {
      throw new PluginExitAttemptError(code)
    }) as typeof process.exit
  }
  depth++
  try {
    return await fn()
  } finally {
    depth--
    if (depth === 0) {
      const restore = original
      if (restore) process.exit = restore
      original = undefined
    }
  }
}
