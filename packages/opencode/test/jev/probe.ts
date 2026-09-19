import { jevControl, jevKey } from "@/jev/controller"

const key = jevKey()
if (!key) {
  console.log("NO_KEY key=<redacted>")
  process.exit(1)
}
console.log(`KEY_PRESENT key=<redacted len=${key.length}>`)

const t0 = performance.now()
const decision = await jevControl({
  key,
  goal: "Open the Settings dialog and enable dark mode.",
  lastAction: "(first step)",
  controls: ["File", "Edit", "View", "Settings", "Help", "Search"],
  timeoutMs: 3000,
})
const ms = Math.round(performance.now() - t0)
console.log(JSON.stringify({ ms, decision }, null, 2))
