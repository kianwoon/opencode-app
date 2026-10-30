/**
 * Content-adaptive enumeration ceiling, shared with the decider.
 *
 * The loop's private sensing — Element/decodeObservation/screenSignature and the
 * rest of the world model — has been removed; screen perception now lives only in
 * the validated `axnav` sensor (`src/tool/ui-nav.ts`). This constant survives
 * because the decider cross-checks its own CHOICE_HARD_MAX against it
 * (`test/jev/controller.test.ts:223`).
 */
export const FRONTIER_HARD_MAX = 600
