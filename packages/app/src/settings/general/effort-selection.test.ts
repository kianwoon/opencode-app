// baseline-guard:allow new test file created by this task; no prior baseline exists
import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createEffortSelection } from "./effort-selection"

// The live defect: choosing an effort persisted and took effect, but the mounted
// Select kept its old label until the page was left and reopened. The control must
// show its own write on the SAME mounted state, before the backing resource
// round-trips — never by remounting.
describe("createEffortSelection", () => {
  test("shows its own write on the same mounted state before the resource refreshes", async () => {
    const [servers, setServers] = createSignal<Record<string, string | undefined>>({})
    const [name, setName] = createSignal("implementer")
    const writes: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => (release = resolve))

    const dispose = createRoot((stop) => {
      const selection = createEffortSelection({
        name,
        value: () => servers()[name()],
        commit: async (effort) => {
          writes.push(effort)
          await gate
        },
      })

      // The served resource has not delivered the configured value yet.
      expect(selection.value()).toBeUndefined()

      const pending = selection.select("low")
      // Same instance, no remount: the draft wins over the stale resource value.
      expect(selection.value()).toBe("low")

      release?.()
      return pending.then(() => {
        // The refetched runtime resource agrees; the draft stays consistent.
        setServers({ implementer: "low" })
        expect(selection.value()).toBe("low")

        // An explicit inherit shows immediately too, and the draft does not leak
        // onto another agent's row.
        return selection.select(undefined).then(() => {
          expect(selection.value()).toBeUndefined()
          setName("reviewer")
          expect(selection.value()).toBeUndefined()
          setName("implementer")
          expect(selection.value()).toBeUndefined()
          expect(writes).toEqual(["low", ""])
          stop()
        })
      })
    })

    await dispose
  })

  test("a failed write reverts the control to the resource's value", async () => {
    const dispose = createRoot((stop) => {
      const selection = createEffortSelection({
        name: () => "implementer",
        value: () => "high",
        commit: async () => {
          throw new Error("config update failed")
        },
      })

      const pending = selection.select("low")
      expect(selection.value()).toBe("low")
      return pending.then(() => {
        expect(selection.value()).toBe("high")
        stop()
      })
    })

    await dispose
  })
})
