/**
 * Session-keyed verdict store for Phase 2 actuation.
 *
 * The detached shadow run publishes the classifier verdict here; the retry path
 * reads it SYNCHRONOUSLY so it never blocks on the classifier (an HTTP call with
 * a 20s timeout). A verdict is only meaningful for the exact failure state it
 * was computed from, so it is stored together with its `fingerprint` and the
 * attempt number that produced it.
 *
 * @module @opencode-ai/opencode/classifier/verdict
 */
export * as ClassifierVerdict from "./verdict"

import type { ReasonCode, RetryDecision } from "./schema"

export interface Verdict {
  decision: RetryDecision
  confidence: number
  reasonCode: ReasonCode
  /** Fingerprint of the decision state the verdict was computed from. */
  fingerprint: string
  attempt: number
}

/** Bound so a long-lived process cannot grow the map without limit. */
const MAX_ENTRIES = 256

// Insertion-ordered, so the first key is the oldest and can be evicted cheaply.
const store = new Map<string, Verdict>()

/** Publish the latest verdict for a session, evicting the oldest entry past the cap. */
export function put(sessionID: string, verdict: Verdict): void {
  store.delete(sessionID)
  store.set(sessionID, verdict)
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

/** Read the verdict for a session, or `undefined` when nothing was published. */
export function get(sessionID: string): Verdict | undefined {
  return store.get(sessionID)
}

/** Consume the verdict for a session (read-once), removing it. */
export function take(sessionID: string): Verdict | undefined {
  const verdict = store.get(sessionID)
  store.delete(sessionID)
  return verdict
}

/** Drop one session's verdict, or every entry when no session is given. */
export function clear(sessionID?: string): void {
  if (sessionID === undefined) {
    store.clear()
    return
  }
  store.delete(sessionID)
}
