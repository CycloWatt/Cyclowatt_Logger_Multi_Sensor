/**
 * One home for the trainer's mode vocabulary.
 *
 * `TrainerMode` (session-log.ts) and manual control's `ManualSubMode` used to
 * overlap with no shared type: the panel translated between them with two
 * inline ternaries. That's fine as long as the two vocabularies never drift,
 * but the mapping belongs next to the types it maps, not duplicated at every
 * call site - so it lives here, and both components import it.
 */

export type { TrainerMode } from "./session-log"
import type { TrainerMode } from "./session-log"

/** Manual control's own vocabulary: which fixed target the operator is holding. */
export type ManualSubMode = "power" | "resistance"

/** The trainer mode a manual sub-mode selection drives. */
export function manualModeFor(sub: ManualSubMode): TrainerMode {
  return sub === "power" ? "manual-power" : "manual-resistance"
}

/** The manual sub-mode a trainer mode corresponds to, defaulting to "power" (today's ternary default). */
export function subModeFor(mode: TrainerMode): ManualSubMode {
  return mode === "manual-resistance" ? "resistance" : "power"
}
