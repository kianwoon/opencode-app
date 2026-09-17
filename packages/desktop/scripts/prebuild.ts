#!/usr/bin/env bun
import { $ } from "bun"

import pkg from "../package.json"
import { downloadCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()
const version = Bun.env.OPENCODE_VERSION ?? pkg.version
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

// CRITICAL: build-node.ts resolves its channel from OPENCODE_CHANNEL, and falls
// back to the current git branch when unset (e.g. "main"). Without this export
// the packaged server would silently use a per-branch DB (opencode-main.db)
// instead of the channel DB (opencode.db for prod). Always propagate the
// resolved channel so the server bundle matches the packaging channel.
// Also propagate OPENCODE_VERSION: build-node bakes it into the server bundle as
// the User-Agent/version. Without it a preview channel falls back to
// `0.0.0-<channel>-<timestamp>`, and the server reports 0.0.0 — which Zen's free
// tier parses as < 1.17.0 and rejects with 426 UpgradeRequired. Prefer an
// already-set OPENCODE_VERSION (CI release builds must win), else the desktop
// package.json version.
await $`cd ../opencode && OPENCODE_VERSION=${version} OPENCODE_CHANNEL=${channel} bun script/build-node.ts`
if (channel === "dev") await downloadCliToResources()
