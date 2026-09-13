// Execution Guard — per-callID classification stash.
//
// `tool.execute.before` sees the command and classifies it; `shell.env` runs
// LATER with NO command (only cwd/sessionID/callID), so the class must be
// correlated through a shared map keyed by callID. Bounded so a stream of
// unmatched calls cannot grow memory: the oldest entry is evicted on overflow.
// Never throws — a missing/colliding entry simply degrades to the default class.

import type { Class } from "./classify"

const MAX_ENTRIES = 4096

export class Stash {
  private entries = new Map<string, Class>()

  /** Records the class for a call. Evicts the oldest on overflow. */
  set(callID: string, cls: Class): void {
    if (!this.entries.has(callID)) {
      if (this.entries.size >= MAX_ENTRIES) {
        const oldest = this.entries.keys().next().value
        if (oldest !== undefined) this.entries.delete(oldest)
      }
    }
    this.entries.set(callID, cls)
  }

  /** Reads and deletes the class for a call (one-shot). */
  getDelete(callID: string): Class | undefined {
    const cls = this.entries.get(callID)
    this.entries.delete(callID)
    return cls
  }

  get size(): number {
    return this.entries.size
  }
}
