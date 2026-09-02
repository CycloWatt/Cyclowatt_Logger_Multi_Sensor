/**
 * What the panel has actually put on the wire, not what the current mode
 * would send. Protocol mode needs no flag: protocolTargetW is already null
 * until the runner runs. Manual power needs manualTargetSent because the
 * slider value exists before Send is pressed - see trainer-panel.tsx.
 */

import { clampToRange, type SupportedRange } from "../ftms/protocol"
import type { TrainerMode } from "./session-log"
import { runnerView, type RunnerState } from "./protocol-runner"

/**
 * Where a finished or stopped protocol leaves the rider: an easy spin, not the
 * last interval's target. A trainer left in ERG at 400 W after the protocol ends
 * is a genuinely unpleasant surprise.
 */
export const FINISH_TARGET_W = 50

/**
 * The runner's target, or null when there is no live one.
 *
 * runnerView reports the current step's watts for a finished or stopped
 * protocol too (it is still "where the protocol got to"), but as a TARGET that
 * would be a lie: nothing is being held any more.
 */
export function protocolTargetW(state: RunnerState, nowMs: number): number | null {
  return state.status === "running" || state.status === "paused" ? runnerView(state, nowMs).targetWatts : null
}

/**
 * The 0-100 % slider onto the trainer's own resistance grid, in tenths.
 *
 * The published range is int16 but Set Target Resistance Level carries ONE
 * uint8, so 255 tenths is the real ceiling; mapping onto the clipped range means
 * the panel never hands the session a value it would have to reject.
 */
export function resistanceTenthsFromPct(pct: number, range: SupportedRange): number {
  const max = Math.min(range.max, 0xff)
  const clipped: SupportedRange = { ...range, max }
  return clampToRange(range.min + (pct / 100) * (max - range.min), clipped)
}

/** Whether, and how, a manual target has been sent to the trainer. */
export type ManualTargetSent = "power" | "resistance" | null

/**
 * The target this panel has actually put on the wire, not the target the
 * current mode would send - see manualTargetSent.
 */
export function liveTargetW(a: {
  mode: TrainerMode
  runner: RunnerState
  nowMs: number
  manualTargetSent: ManualTargetSent
  manualTargetW: number
}): number | null {
  return a.mode === "protocol"
    ? protocolTargetW(a.runner, a.nowMs)
    : a.mode === "manual-power" && a.manualTargetSent === "power"
      ? a.manualTargetW
      : null
}
