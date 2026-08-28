export * as SessionDelivery from "./session-delivery"

import { Schema } from "effect"

/**
 * steer: promote at the next safe provider-turn boundary while a drain is
 * active. queue: wait until the session would otherwise go idle. followup:
 * like queue, but stays unpromoted until `deliverAt` time passes; the
 * execution scheduler wakes the session when it is due.
 */
export const Delivery = Schema.Literals(["steer", "queue", "followup"])
export type Delivery = typeof Delivery.Type
