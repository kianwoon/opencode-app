import { $ } from "bun"
import { downloadCliToResources, resolveChannel } from "./utils"

await $`bun run install-electron`

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`

// Always propagate the channel so build-node.ts cannot silently fall back to
// the git branch (which would produce a per-branch DB instead of the channel
// DB). See prebuild.ts for details.
await $`cd ../opencode && OPENCODE_CHANNEL=${channel} bun script/build-node.ts`
await downloadCliToResources()
