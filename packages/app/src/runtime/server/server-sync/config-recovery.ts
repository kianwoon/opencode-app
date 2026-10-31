import { createEffect, type Accessor } from "solid-js"
import type { ConfigRetryBudget } from "../global-sync/bootstrap"
import type { ServerConnectionStatus } from "../client"

/**
 * The global config query is enabled by connection status, so it starts once the stream connects -- but a
 * failure it caches (a cold server refusing the document, or an endpoint race) then outlives every later
 * handshake: `enabled` is already true, so nothing re-runs it, and the panels read an empty config forever
 * while the provider catalog recovers through its own retry loop.
 *
 * Only a FAILED query is recovered: a first fetch still in flight also has no value, and refetching it made
 * every healthy handshake pay a duplicate, cancelled request. Recovery spends the query's own retry budget
 * (bootstrap.ts), so both mechanisms share one cap instead of multiplying it.
 */
export function recoverConfigOnConnect(input: {
  status: Accessor<ServerConnectionStatus>
  resolved: () => boolean
  errored: () => boolean
  budget: ConfigRetryBudget
  refetch: () => unknown
}) {
  createEffect(() => {
    if (input.status() !== "connected") {
      input.budget.reset()
      return
    }

    // A resolved store refills the budget; a still-pending one is left to its own fetch.
    if (input.resolved()) {
      input.budget.reset()
      return
    }

    if (!input.errored()) return
    if (!input.budget.spend()) return

    void input.refetch()
  })
}
