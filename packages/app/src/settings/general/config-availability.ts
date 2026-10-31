import { createEffect, createMemo, createSignal } from "solid-js"

/**
 * A settings panel reads the global config store, so zero agents is ambiguous: a genuinely empty config, or a
 * store that never resolved -- the query failed once and cached it, and the panel then rendered "Default"
 * everywhere with no error shown. The server's own /api/config settles it.
 *
 * The probe runs only once the store has SETTLED on an empty config: a pending store also reads as zero agents,
 * and probing there flashed the notice and refetched on every mount. Its verdict belongs to that one boolean
 * key -- leaving it drops the verdict and invalidates an in-flight probe -- so a populated -> empty transition
 * can never render the previous probe's "unavailable", and a 0 -> n -> 0 flip cannot leave two probes racing.
 */
export function createConfigUnavailable(input: {
  agents: () => number
  settled: () => boolean
  serverAgents: () => Promise<number>
  refetch: () => unknown
}) {
  const shouldProbe = () => input.settled() && input.agents() === 0

  const [verdict, setVerdict] = createSignal<"unknown" | "agrees" | "disagrees">("unknown")
  let generation = 0
  let refetched = false

  createEffect(() => {
    const probe = shouldProbe()
    const current = ++generation

    if (!probe) {
      setVerdict("unknown")
      return
    }

    void input.serverAgents().then(
      (server) => current === generation && setVerdict(server > 0 ? "disagrees" : "agrees"),
      // A rejected probe (the cold-server case) cannot confirm an empty server, so it reports unavailable
      // rather than falling back to silent defaults.
      () => current === generation && setVerdict("disagrees"),
    )
  })

  const unavailable = createMemo(() => shouldProbe() && verdict() === "disagrees")

  createEffect(() => {
    // One store refetch per mounted panel: retrying on every settle would poll the store forever.
    if (!unavailable() || refetched) return
    refetched = true
    void input.refetch()
  })

  return unavailable
}
