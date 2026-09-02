/**
 * The protocol/step-index context a log row carries, factored out of the
 * panel so it can be unit-tested without a DOM or a live runner. Pure
 * functions of the same values the panel already tracks in refs (mode,
 * protocolName, runner) - kept here as parameters rather than reading refs
 * directly, since the notification path (handleBikeData -> logEvent) must
 * read refs and never state, but startRecording (a plain click handler)
 * reads state instead - see trainer-panel.tsx call sites.
 */

import type { TrainerMode } from "./session-log"
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
