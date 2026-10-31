import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createConfigUnavailable } from "@/settings/general/config-availability"

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function setup(options: { agents?: number; settled?: boolean; serverAgents: () => Promise<number> }) {
  const refetches: number[] = []
  return createRoot((dispose) => {
    const [agents, setAgents] = createSignal(options.agents ?? 0)
    const [settled, setSettled] = createSignal(options.settled ?? true)
    const unavailable = createConfigUnavailable({
      agents,
      settled,
      serverAgents: options.serverAgents,
      refetch: () => {
        refetches.push(Date.now())
      },
    })
    return { unavailable, setAgents, setSettled, refetches, dispose }
  })
}

test("the probe waits until the config store settles instead of flashing on mount", async () => {
  let probes = 0
  const root = setup({
    settled: false,
    serverAgents: async () => {
      probes += 1
      return 16
    },
  })

  try {
    await tick()
    expect(root.unavailable()).toBe(false)
    expect(probes).toBe(0)
    expect(root.refetches.length).toBe(0)

    root.setSettled(true)
    await tick()
    expect(probes).toBe(1)
    expect(root.unavailable()).toBe(true)
    expect(root.refetches.length).toBe(1)
  } finally {
    root.dispose()
  }
})

test("an empty store whose server disagrees is reported unavailable and refetched once", async () => {
  let probes = 0
  const root = setup({
    serverAgents: async () => {
      probes += 1
      return 16
    },
  })

  try {
    await tick()
    expect(root.unavailable()).toBe(true)
    expect(root.refetches.length).toBe(1)

    root.setAgents(16)
    expect(root.unavailable()).toBe(false)
    expect(probes).toBe(1)
    expect(root.refetches.length).toBe(1)
  } finally {
    root.dispose()
  }
})

test("a rejected probe reports unavailable instead of silent defaults", async () => {
  let probes = 0
  const root = setup({
    serverAgents: async () => {
      probes += 1
      throw { _tag: "ServiceUnavailableError", message: "configuration is still activating" }
    },
  })

  try {
    await tick()
    expect(probes).toBe(1)
    expect(root.unavailable()).toBe(true)
    expect(root.refetches.length).toBe(1)
  } finally {
    root.dispose()
  }
})

test("a populated to empty transition cannot render the previous probe's verdict", async () => {
  let pending: (() => void) | undefined
  const root = setup({
    serverAgents: () => new Promise<number>((resolve) => (pending = () => resolve(16))),
  })

  try {
    await tick()
    pending!()
    await tick()
    expect(root.unavailable()).toBe(true)

    root.setAgents(16)
    expect(root.unavailable()).toBe(false)

    // Back to an empty store: the new probe is still in flight, so the old "disagrees" must not resurface.
    pending = undefined
    root.setAgents(0)
    await tick()
    expect(root.unavailable()).toBe(false)

    pending!()
    await tick()
    expect(root.unavailable()).toBe(true)
  } finally {
    root.dispose()
  }
})

test("a genuinely empty server config stays ready instead of claiming the store is unavailable", async () => {
  const root = setup({ serverAgents: async () => 0 })

  try {
    await tick()
    expect(root.unavailable()).toBe(false)
    expect(root.refetches.length).toBe(0)
  } finally {
    root.dispose()
  }
})

test("a populated store never probes the server", async () => {
  let probes = 0
  const root = setup({
    agents: 3,
    serverAgents: async () => {
      probes += 1
      return 3
    },
  })

  try {
    await tick()
    expect(root.unavailable()).toBe(false)
    expect(probes).toBe(0)
  } finally {
    root.dispose()
  }
})
