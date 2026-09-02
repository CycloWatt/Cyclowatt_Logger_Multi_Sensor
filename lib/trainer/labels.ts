/**
 * The Trainer Readouts card's four label strings, moved verbatim out of the
 * panel: same dashes, same wording, same conditions. Pure and free of any
 * DOM, so it sits in lib/ and is unit-testable in plain node.
 */

import { mmss } from "./format"
import type { RunnerStatus } from "./protocol-runner"
import type { TrainerMode } from "./session-log"
import type { ManualTargetSent } from "./targets"

/** No notification for this long and every readout greys out. */
export const STALE_MS = 3000

/**
 * Whether the live reading is too old to trust. `receivedAtMs === null`
 * (no reading yet) is NOT stale - see the panel's comment on `hasReading`:
 * treating "never connected" as stale would freeze the flag at false forever.
 */
export function isStale(receivedAtMs: number | null, nowMs: number, staleMs: number = STALE_MS): boolean {
  return receivedAtMs !== null && nowMs - receivedAtMs > staleMs
}

/**
 * The target readout: the resistance percent once sent in resistance mode,
 * otherwise the live watt target, or "–" when there is nothing to show.
 */
export function targetLabel(a: {
  mode: TrainerMode
  manualTargetSent: ManualTargetSent
  manualResistancePct: number
  liveTargetW: number | null
}): string {
  return a.mode === "manual-resistance"
    ? a.manualTargetSent === "resistance"
      ? `${a.manualResistancePct} %`
      : "–"
    : a.liveTargetW === null
      ? "–"
      : `${a.liveTargetW} W`
}

/** The step readout: "Manual" outside protocol mode, else "Step i / n" once running. */
export function stepLabel(a: {
  mode: TrainerMode
  runnerStatus: RunnerStatus
  stepIndex: number
  stepCount: number
}): string {
  return a.mode === "protocol" ? (a.runnerStatus === "idle" ? "–" : `Step ${a.stepIndex + 1} / ${a.stepCount}`) : "Manual"
}

/**
 * The elapsed readout: protocol elapsed / total while the runner is not
 * idle, else recorded time - which needs BOTH `recording` and a log, since
 * `logStartedAtMs` is null exactly when there is no log (see the panel's
 * `logRef.current?.startedAtMs ?? null`).
 */
export function elapsedLabel(a: {
  mode: TrainerMode
  runnerStatus: RunnerStatus
  totalElapsedS: number
  protocolDurationS: number
  recording: boolean
  logStartedAtMs: number | null
  nowMs: number
}): string {
  return a.mode === "protocol" && a.runnerStatus !== "idle"
    ? `${mmss(a.totalElapsedS)} / ${mmss(a.protocolDurationS)}`
    : a.recording && a.logStartedAtMs !== null
      ? `${mmss((a.nowMs - a.logStartedAtMs) / 1000)} recorded`
      : "–"
}
