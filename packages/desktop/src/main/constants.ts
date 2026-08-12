type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// We compile opencode locally with customizations (V2 plugin, vacuum, cache
// fixes, compaction fix). The auto-updater targets the UPSTREAM release, which
// would download and replace our local build, silently losing all of that work.
// Keep it disabled so the update button never appears and the app can never be
// clobbered by an upstream update.
export const UPDATER_ENABLED = false
