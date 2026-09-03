/**
 * The protocol/step-index context a log row carries, factored out so it can
 * be unit-tested without a DOM or a live runner. Pure functions of values
 * TrainerController holds as fields (mode, protocolName, runner) - see its
 * logEvent and handleBikeData call sites in lib/trainer/controller.ts.
 */

import type { TrainerMode } from "./mode"
import type { RunnerState } from "./protocol-runner"

/**
 * Blank outside protocol mode: a manual session has no protocol, and a name
 * left over in those rows would look like one was running.
 */
export function logProtocolName(mode: TrainerMode, protocolName: string): string {
  return mode === "protocol" ? protocolName : ""
}

/** null unless a protocol is actually running or paused. */
export function logStepIndex(mode: TrainerMode, runner: RunnerState): number | null {
  if (mode !== "protocol") return null
  return runner.status === "running" || runner.status === "paused" ? runner.stepIndex : null
}
