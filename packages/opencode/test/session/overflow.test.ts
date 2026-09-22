import { expect, test } from "bun:test"
import { isOverflow, usable } from "@/session/overflow"
import type { Provider } from "@/provider/provider"

type Input = Parameters<typeof isOverflow>[0]

// isOverflow reads only `limit` (context + input), and `usable` takes the
// `limit.input` branch whenever it is set — so no other model field is consulted.
const model = { limit: { context: 1_000_000, input: 332_000, output: 384_000 } } as unknown as Provider.Model
const cfg = (compaction: Record<string, number>) => ({ compaction }) as unknown as Input["cfg"]
const tokens = (total: number) => ({ total }) as unknown as Input["tokens"]

// reserved 32_000 against limit.input 332_000 → the model-derived window is 300_000
const base = { reserved: 32_000 }

test("isOverflow uses the model-derived window when trigger_tokens is unset", () => {
  expect(usable({ cfg: cfg(base), model })).toBe(300_000)
  expect(isOverflow({ cfg: cfg(base), tokens: tokens(250_000), model })).toBe(false)
  expect(isOverflow({ cfg: cfg(base), tokens: tokens(350_000), model })).toBe(true)
})

test("trigger_tokens overrides the model-derived window in both directions", () => {
  // lower than the window: fires EARLIER than the model would have
  expect(isOverflow({ cfg: cfg({ ...base, trigger_tokens: 200_000 }), tokens: tokens(250_000), model })).toBe(true)
  // higher than the window: does NOT fire where the model window would have
  expect(isOverflow({ cfg: cfg({ ...base, trigger_tokens: 400_000 }), tokens: tokens(350_000), model })).toBe(false)
})
