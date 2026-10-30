export * as SessionCompactionEvent from "./session-compaction-event.js"

import { Event } from "@opencode/schema/event"
import { SessionID } from "@opencode/schema/session-id"

export const Compacted = Event.ephemeral({
  type: "session.compacted",
  schema: {
    sessionID: SessionID,
  },
})

export const Definitions = Event.inventory(Compacted)
