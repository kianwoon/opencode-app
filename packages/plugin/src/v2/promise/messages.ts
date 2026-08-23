import type { MessagesDraft } from "../effect/messages.js"
import type { Hooks } from "./registration.js"

export type { MessagesDraft }

export type MessagesHooks = Hooks<{
  transform: MessagesDraft
}>
