// Execution Guard — per-class secret projection.
//
// Zero-secret classes receive NO project secrets at all: their commands run
// with the ambient process environment only. This is the core defence against
// an evil-provider / malicious-package threat — an install script (npm
// postinstall, pip setup.py) must never observe a `.env` value.
//
// The broker injects its allowlisted subset into `shell.env`; the guard runs
// AFTER the broker in plugin order and DELETES every broker-injected key for a
// zero-secret class, so deletion wins.

import type { Class } from "./classify"

/** Classes that must run with zero project secrets. */
const ZERO_SECRET = new Set<Class>(["package_install", "build", "unit_test"])

/** True when the class must receive NO project secrets. */
export function zeroSecrets(cls: Class): boolean {
  return ZERO_SECRET.has(cls)
}

/** Projects the broker's allowlisted subset down to what a class may receive.
 *  Zero-secret classes get `{}`; every other class passes the subset through
 *  unchanged. Exported as the seam for future per-class config (e.g. a
 *  `production` class receiving a narrower subset); kept even though the guard
 *  currently branches only on `zeroSecrets`. */
export function project(cls: Class, subset: Readonly<Record<string, string>>): Record<string, string> {
  if (zeroSecrets(cls)) return {}
  return { ...subset }
}

export * as Subsets from "./subsets"
