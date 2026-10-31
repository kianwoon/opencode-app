import { expect, test } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/solid-query"
import { createRoot, createSignal } from "solid-js"
import { createConfigRetryBudget, loadGlobalConfigQuery } from "@/runtime/server/global-sync/bootstrap"
import { recoverConfigOnConnect } from "@/runtime/server/server-sync/config-recovery"
import type { ServerConnectionStatus } from "@/runtime/server/client"
import type { ServerScope } from "@/runtime/server/scope"

const scope = "local" as ServerScope
const document = { type: "document" as const, info: { agents: { build: { mode: "primary" } } } }
const unavailable = { _tag: "ServiceUnavailableError", message: "configuration is still activating" }

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// A cold server refuses config while its instances activate. The default three attempts give up inside that
// window, so the fourth refusal used to leave an error cached for the life of the window.
test("a config query outlasts a cold server instead of caching its refusal", async () => {
  const client = new QueryClient()
  let calls = 0
  const options = loadGlobalConfigQuery(scope, {
    get: async () => {
      calls += 1
      if (calls <= 4) throw unavailable
      return [document]
    },
  })

  try {
    const data = await client.fetchQuery({ ...options, retryDelay: 0 })

    expect(calls).toBe(5)
    expect(data).toEqual({ agents: { build: { mode: "primary" } } })
  } finally {
    client.clear()
  }
})

test("a config error cached before the handshake is refetched when the stream connects", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let failing = true
  const budget = createConfigRetryBudget()
  const options = loadGlobalConfigQuery(
    scope,
    {
      get: async () => {
        if (failing) throw new Error("config unavailable")
        return [document]
      },
    },
    budget,
  )
  const observer = new QueryObserver(client, { ...options, enabled: false, retry: false })
  const unsubscribe = observer.subscribe(() => {})

  try {
    await observer.refetch()
    expect(client.getQueryState(options.queryKey)?.status).toBe("error")

    failing = false
    let refetch: Promise<unknown> | undefined
    const root = createRoot((dispose) => {
      const [status, setStatus] = createSignal<ServerConnectionStatus>("connecting")
      recoverConfigOnConnect({
        status,
        resolved: () => observer.getCurrentResult().data !== undefined,
        errored: () => observer.getCurrentResult().isError,
        budget,
        refetch: () => (refetch = observer.refetch()),
      })
      return { setStatus, dispose }
    })

    try {
      expect(client.getQueryData(options.queryKey)).toBeUndefined()
      root.setStatus("connected")
      await refetch
      expect(client.getQueryData(options.queryKey)).toEqual({ agents: { build: { mode: "primary" } } })
    } finally {
      root.dispose()
    }
  } finally {
    unsubscribe()
    client.clear()
  }
})

// A first fetch still in flight is unresolved too, but it is healthy: refetching it made every handshake pay a
// duplicate, cancelled config request.
test("a healthy first fetch is not duplicated by the handshake", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const options = loadGlobalConfigQuery(scope, {
    get: async () => {
      calls += 1
      await gate
      return [document]
    },
  })
  const observer = new QueryObserver(client, { ...options, enabled: false })
  const unsubscribe = observer.subscribe(() => {})
  let refetches = 0

  try {
    const pending = observer.refetch()
    const root = createRoot((dispose) => {
      const [status, setStatus] = createSignal<ServerConnectionStatus>("connecting")
      recoverConfigOnConnect({
        status,
        resolved: () => observer.getCurrentResult().data !== undefined,
        errored: () => observer.getCurrentResult().isError,
        budget: createConfigRetryBudget(),
        refetch: () => {
          refetches += 1
          return observer.refetch()
        },
      })
      return { setStatus, dispose }
    })

    try {
      root.setStatus("connected")
      await tick()
      expect(refetches).toBe(0)
    } finally {
      release()
      await pending
      root.dispose()
    }

    expect(calls).toBe(1)
  } finally {
    unsubscribe()
    client.clear()
  }
})

// Recovery spends the query's own retry budget: a refetch must not restart the whole 12-attempt chain.
test("recovery shares the query's retry budget instead of re-arming it", async () => {
  const client = new QueryClient()
  const budget = createConfigRetryBudget(2)
  let calls = 0
  const options = loadGlobalConfigQuery(
    scope,
    {
      get: async () => {
        calls += 1
        throw unavailable
      },
    },
    budget,
  )
  const observer = new QueryObserver(client, { ...options, enabled: false, retryDelay: 0 })
  const unsubscribe = observer.subscribe(() => {})

  try {
    await observer.refetch()
    expect(calls).toBe(3)

    let refetches = 0
    const root = createRoot((dispose) => {
      const [status, setStatus] = createSignal<ServerConnectionStatus>("connected")
      recoverConfigOnConnect({
        status,
        resolved: () => observer.getCurrentResult().data !== undefined,
        errored: () => observer.getCurrentResult().isError,
        budget,
        refetch: () => {
          refetches += 1
          return observer.refetch()
        },
      })
      return { setStatus, dispose }
    })

    try {
      await tick()
      expect(refetches).toBe(0)
      expect(calls).toBe(3)
    } finally {
      root.dispose()
    }
  } finally {
    unsubscribe()
    client.clear()
  }
})

// A permanently unresolved store costs at most the budget per connection: no polling loop.
test("recovery is bounded per connection and re-armed by the next handshake", () => {
  let calls = 0
  const budget = createConfigRetryBudget(2)
  const root = createRoot((dispose) => {
    const [status, setStatus] = createSignal<ServerConnectionStatus>("connecting")
    const [errored, setErrored] = createSignal(false)
    recoverConfigOnConnect({
      status,
      resolved: () => false,
      errored,
      budget,
      refetch: () => {
        calls += 1
        setErrored(false)
      },
    })
    return { setStatus, setErrored, dispose }
  })

  try {
    root.setStatus("connected")
    root.setErrored(true)
    root.setErrored(true)
    root.setErrored(true)
    expect(calls).toBe(2)

    root.setStatus("reconnecting")
    root.setStatus("connected")
    root.setErrored(true)
    root.setErrored(true)
    root.setErrored(true)
    expect(calls).toBe(4)
  } finally {
    root.dispose()
  }
})
