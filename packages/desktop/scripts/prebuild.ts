#!/usr/bin/env bun
import { $ } from "bun"

import { downloadCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

// CRITICAL: build-node.ts resolves its channel from OPENCODE_CHANNEL, and falls
// back to the current git branch when unset (e.g. "main"). Without this export
// the packaged server would silently use a per-branch DB (opencode-main.db)
// instead of the channel DB (opencode.db for prod). Always propagate the
// resolved channel so the server bundle matches the packaging channel.
await $`cd ../opencode && OPENCODE_CHANNEL=${channel} bun script/build-node.ts`
if (channel === "dev") await downloadCliToResources()
