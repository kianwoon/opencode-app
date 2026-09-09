type QueueInput = {
  paused: () => boolean
  bootstrap: () => Promise<void>
  bootstrapInstance: (directory: string) => Promise<void> | void
  key?: (directory: string) => string
  /** @internal Test seam: per-directory bootstrap deadline. Defaults to INSTANCE_TIMEOUT_MS. */
  timeoutMs?: number
}

// Prevents one dead directory from starving global sync: each bootstrap is
// raced against a deadline so a hung directory warns and yields while the
// rest of the queue keeps draining.
export const INSTANCE_TIMEOUT_MS = 30_000

function timeoutReject(ms: number, label: string) {
  return new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`bootstrap timed out for ${label}`)), ms)
    timer.unref?.()
  })
}

function withTimeout(promise: Promise<void> | void, ms: number, label: string) {
  return Promise.race([Promise.resolve(promise), timeoutReject(ms, label)])
}

export function createRefreshQueue(input: QueueInput) {
  const queued = new Map<string, string>()
  let root = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutMs = input.timeoutMs ?? INSTANCE_TIMEOUT_MS

  const key = input.key ?? ((directory: string) => directory)

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  const take = (count: number) => {
    if (queued.size === 0) return [] as string[]
    const items: string[] = []
    for (const [id, directory] of queued) {
      queued.delete(id)
      items.push(directory)
      if (items.length >= count) break
    }
    return items
  }

  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void drain()
    }, 0)
  }

  const push = (directory: string) => {
    if (!directory) return
    queued.set(key(directory), directory)
    if (input.paused()) return
    schedule()
  }

  const refresh = () => {
    root = true
    if (input.paused()) return
    schedule()
  }

  async function drain() {
    if (running) return
    running = true
    try {
      while (true) {
        if (input.paused()) return
        if (root) {
          root = false
          try {
            await withTimeout(input.bootstrap(), timeoutMs, "root")
          } catch (error) {
            console.warn(error instanceof Error ? error.message : error)
          }
          await tick()
          continue
        }
        const dirs = take(2)
        if (dirs.length === 0) return
        await Promise.all(
          dirs.map((dir) =>
            withTimeout(input.bootstrapInstance(dir), timeoutMs, dir).catch((error) => {
              console.warn(error instanceof Error ? error.message : error)
            }),
          ),
        )
        await tick()
      }
    } finally {
      running = false
      // oxlint-disable-next-line no-unsafe-finally -- intentional: early return skips schedule() when paused
      if (input.paused()) return
      if (root || queued.size) schedule()
    }
  }

  return {
    push,
    refresh,
    clear(directory: string) {
      queued.delete(key(directory))
    },
    dispose() {
      if (!timer) return
      clearTimeout(timer)
      timer = undefined
    },
  }
}
