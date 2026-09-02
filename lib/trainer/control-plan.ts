/**
 * The decision half of the panel's `applyEvents`: turn one batch of runner
 * events into the log rows it must write and the ordered FTMS Control Point
 * ops it must send - as plain data, with no session, no refs and no awaits.
 *
 * WHY SPLIT IT AT ALL. This was the single highest-risk function in the panel:
 * it decides which rows are written, which opcodes reach the wire, in which
 * order, under which labels, and how the `started` bookkeeping moves - all
 * interleaved with the awaits that actually send them. None of it could be
 * tested without a fake trainer and a DOM. The decision is pure, so it lives
 * here behind an exhaustive test; the panel keeps only the interpreter that
 * walks `ops` and calls `sendControl`.
 *
 * WHY `sequencing` IS PART OF THE PLAN. The old code did not send these ops in
 * one uniform way, and the difference is observable. The protocol-end ops were
 * serialised inside ONE async run (0x07 -> target -> 0x08) precisely so the
 * order on the wire could not depend on the GATT queue, and a failed leading
 * 0x07 aborted the rest. The ordinary step target and the Pause, by contrast,
 * were each fired as an independent un-awaited call. Collapsing both shapes
 * into one awaited chain would change when the second op is issued, so the
 * shape is planned explicitly rather than assumed.
 *
 * WHY `startedBeforeOps` EXISTS. Stop clears `started` SYNCHRONOUSLY, before
 * any await: 0x08 leaves the trainer honouring no ERG target, so the next run
 * must send 0x07 again, and a fast Start click must not find a stale `true`
 * while these writes are still queued. That write is a decision, so it is
 * planned here; the ops' own bookkeeping (0x07 succeeded, Pause was sent) can
 * only be known by the interpreter and stays there.
 */

import { clampToRange, type SupportedRange } from "../ftms/protocol"
import type { RunnerEvent, RunnerStatus } from "./protocol-runner"
import type { LogEventKind } from "./session-log"
import { FINISH_TARGET_W } from "./targets"

/** One log row, ready for the panel's `logEvent(event, detail, nowMs)`. */
export interface PlannedRow {
  event: LogEventKind
  detail: string
}

/**
 * One Control Point procedure, with the label its `control-result` row will
 * carry. Labels are the panel's original strings verbatim: they are the log's
 * only record of what was attempted, so a session log from before this split
 * and one from after it must read identically.
 */
export type PlannedOp =
  /** 0x07 Start/Resume. `markStartedOnSuccess` is false when a Stop follows it. */
  | { kind: "start"; label: string; markStartedOnSuccess: boolean }
  /** 0x05 Set Target Power. */
  | { kind: "targetPower"; label: string; watts: number }
  /** 0x08 Stop - sent with `restartAfterRetake: false`. */
  | { kind: "stop"; label: string }
  /** 0x08 Pause - sent with `restartAfterRetake: false`, then `started = false`. */
  | { kind: "pause"; label: string }

export interface PlanInput {
  /** The batch `reduceRunner` just emitted, in order. */
  events: RunnerEvent[]
  /** `startedRef` as it stands now: has the trainer had its 0x07? */
  started: boolean
  /** The connected trainer's Supported Power Range, for the protocol-end target. */
  powerRange: SupportedRange
  /** The runner's status AFTER the state was committed - see the "paused" guard below. */
  runnerStatusAfter: RunnerStatus
  /** False when the link is gone (disconnect, revoked control) or there is no session. */
  send: boolean
}

/**
 * How the interpreter must issue `ops`:
 * - `"chain"`: one async run, each op awaited before the next is issued.
 * - `"independent"`: each op issued without awaiting the previous one.
 */
export type OpSequencing = "chain" | "independent"

export interface ControlPlan {
  /** Written first, in event order, and written even when `send` is false. */
  rows: PlannedRow[]
  ops: PlannedOp[]
  sequencing: OpSequencing
  /** What `startedRef` must be set to before the first op is issued. */
  startedBeforeOps: boolean
  /** When a leading `start` op fails, abandon the remaining ops. */
  abortChainOnStartFailure: boolean
}

/** The row each runner event writes. Only the two target-carrying events have detail. */
function rowFor(event: RunnerEvent): PlannedRow {
  switch (event.type) {
    case "step-started":
      return { event: "step-started", detail: `step ${event.stepIndex + 1} target ${event.targetWatts} W` }
    case "resumed":
      return { event: "resumed", detail: `target ${event.targetWatts} W` }
    case "paused":
      return { event: "paused", detail: "" }
    case "stopped":
      return { event: "stopped", detail: "" }
    case "finished":
      return { event: "finished", detail: "" }
  }
}

export function planRunnerEffects(input: PlanInput): ControlPlan {
  const { events, started, powerRange, runnerStatusAfter, send } = input
  const rows = events.map(rowFor)

  // The rows above are the whole plan when nothing can reach the wire: a write
  // queued behind a dead Control Point would only pile up, and `started` is
  // the caller's business in that case (the disconnect paths clear it).
  if (!send) {
    return { rows, ops: [], sequencing: "independent", startedBeforeOps: started, abortChainOnStartFailure: false }
  }

  const finishing = events.some((event) => event.type === "finished" || event.type === "stopped")
  if (finishing) {
    /*
     * Not the last step's target: see FINISH_TARGET_W. Unlike the step targets
     * below, this one is planned even from a paused runner - Stop while paused -
     * because nothing later would re-send it and the rider is coasting: landing
     * on 50 W is the whole intent. But a paused trainer has already had 0x08,
     * so it applies no target at all; the 0x07 is what makes the 50 W actually
     * take effect instead of being acknowledged and dropped.
     *
     * A `paused` event in a finishing batch would add no Pause op here, which
     * is not an oversight: reduceRunner only ever emits `paused` on its own,
     * from the `pause` action, so the two can never share a batch.
     */
    const watts = clampToRange(FINISH_TARGET_W, powerRange)
    const stopping = events.some((event) => event.type === "stopped")
    const ops: PlannedOp[] = []
    if (!started) {
      ops.push({
        kind: "start",
        label: "Start or Resume (for the protocol-end target)",
        // A Stop is about to un-start the trainer again, so claiming a started
        // trainer here would leave `startedRef` lying about it.
        markStartedOnSuccess: !stopping,
      })
    }
    ops.push({ kind: "targetPower", label: `Set Target Power ${watts} W (protocol end)`, watts })
    if (stopping) ops.push({ kind: "stop", label: "Stop" })

    return {
      rows,
      ops,
      sequencing: "chain",
      startedBeforeOps: stopping ? false : started,
      abortChainOnStartFailure: true,
    }
  }

  const ops: PlannedOp[] = []
  if (runnerStatusAfter !== "paused") {
    /*
     * Only the LAST target of the batch: one late tick can walk several step
     * boundaries at once, and the earlier steps were never actually the
     * current target - they were passed through in one catch-up.
     *
     * And nothing at all while the runner is paused, which is Skip-while-paused:
     * the panel has already sent 0x08, so the trainer holds no target and would
     * ACKNOWLEDGE the write while ignoring it - logging a "-> success" for a
     * target that never took effect, the single most misleading line a session
     * log can carry. Resume re-sends the current step's target anyway, and by
     * the time a `resumed` event reaches here the status has already moved to
     * "running", so this guard never blocks that.
     */
    let target: number | null = null
    for (const event of events) {
      if (event.type === "step-started" || event.type === "resumed") target = event.targetWatts
    }
    if (target !== null) ops.push({ kind: "targetPower", label: `Set Target Power ${target} W`, watts: target })
  }

  if (events.some((event) => event.type === "paused")) ops.push({ kind: "pause", label: "Pause" })

  return { rows, ops, sequencing: "independent", startedBeforeOps: started, abortChainOnStartFailure: false }
}
