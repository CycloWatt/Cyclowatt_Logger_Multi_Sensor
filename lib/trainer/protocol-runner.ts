/**
 * A pure, wall-clock driven state machine for step protocols ("ERG mode": hold
 * X watts for Y seconds, then move to the next step) plus a generator for
 * linear ramp protocols.
 *
 * Everything here is pure and takes `nowMs` as an argument - no `Date.now()`,
 * no timers, nothing that reads the wall clock itself. The panel that owns
 * this runner drives it with `Date.now()` from a 250 ms interval, from every
 * BLE notification, and from `visibilitychange`, and that last source is why
 * `tick` has to walk every boundary since the last one rather than assume it
 * is at most one step late: browsers throttle (or fully suspend) timers in a
 * hidden tab, so a single tick can arrive minutes after the step it is
 * reporting on, having silently skipped several step boundaries in between.
 *
 * `stepStartedAtMs` always advances by exactly `duration * 1000`, never by
 * jumping to `nowMs`, so a slow or delayed tick cannot shift the protocol's
 * notion of when a step "really" started - drift would otherwise accumulate
 * every time a tick arrived late, and a workout is long enough for that to be
 * visible by the end of it.
 */

import { MAX_STEPS } from "./presets"

export interface ProtocolStep {
  targetWatts: number
  durationSeconds: number
}

export interface Protocol {
  name: string
  steps: ProtocolStep[]
}

export type RunnerStatus = "idle" | "running" | "paused" | "finished" | "stopped"

export interface RunnerState {
  protocol: Protocol
  status: RunnerStatus
  stepIndex: number
  /** Wall-clock ms at which the current step began, already shifted forward by any pause time. */
  stepStartedAtMs: number
  protocolStartedAtMs: number
  pausedAtMs: number | null
  totalPausedMs: number
}

export type RunnerAction =
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "stop" }
  | { type: "skip" }
  | { type: "tick" }

export type RunnerEvent =
  | { type: "step-started"; stepIndex: number; targetWatts: number }
  | { type: "paused" }
  | { type: "resumed"; targetWatts: number }
  | { type: "stopped" }
  | { type: "finished" }

/** A freshly loaded, not-yet-started protocol. */
export function createRunner(protocol: Protocol): RunnerState {
  return {
    protocol,
    status: "idle",
    stepIndex: 0,
    stepStartedAtMs: 0,
    protocolStartedAtMs: 0,
    pausedAtMs: null,
    totalPausedMs: 0,
  }
}

/** No-op result: the exact input state back, so callers (and tests) can compare by reference. */
function unchanged(state: RunnerState): { state: RunnerState; events: RunnerEvent[] } {
  return { state, events: [] }
}

function stepDurationMs(step: ProtocolStep): number {
  return step.durationSeconds * 1000
}

/**
 * Pure reducer. Never mutates its input - every branch either hands back the
 * same `state` reference (a no-op) or builds a new object.
 *
 * `tick` may emit several `step-started` events when more than one boundary
 * elapsed since the last tick; the caller sends only the LAST one to the
 * trainer (the earlier ones were never actually the "current" target, they
 * were passed through in a single catch-up step).
 */
export function reduceRunner(
  state: RunnerState,
  action: RunnerAction,
  nowMs: number,
): { state: RunnerState; events: RunnerEvent[] } {
  switch (action.type) {
    case "start": {
      if (state.status !== "idle" && state.status !== "stopped" && state.status !== "finished") {
        return unchanged(state)
      }

      const base: RunnerState = {
        ...state,
        stepIndex: 0,
        stepStartedAtMs: nowMs,
        protocolStartedAtMs: nowMs,
        pausedAtMs: null,
        totalPausedMs: 0,
      }

      if (state.protocol.steps.length === 0) {
        return { state: { ...base, status: "finished" }, events: [{ type: "finished" }] }
      }

      return {
        state: { ...base, status: "running" },
        events: [{ type: "step-started", stepIndex: 0, targetWatts: state.protocol.steps[0].targetWatts }],
      }
    }

    case "tick": {
      if (state.status !== "running") return unchanged(state)

      const steps = state.protocol.steps
      const events: RunnerEvent[] = []
      let stepIndex = state.stepIndex
      let stepStartedAtMs = state.stepStartedAtMs

      // Walk every boundary that elapsed since the last tick, not just the
      // next one - see the module comment on why a single tick can be late
      // by more than one step.
      while (stepIndex < steps.length && nowMs - stepStartedAtMs >= stepDurationMs(steps[stepIndex])) {
        stepStartedAtMs += stepDurationMs(steps[stepIndex])

        if (stepIndex + 1 >= steps.length) {
          events.push({ type: "finished" })
          return {
            state: { ...state, status: "finished", stepIndex, stepStartedAtMs },
            events,
          }
        }

        stepIndex += 1
        events.push({ type: "step-started", stepIndex, targetWatts: steps[stepIndex].targetWatts })
      }

      if (events.length === 0) return unchanged(state)
      return { state: { ...state, stepIndex, stepStartedAtMs }, events }
    }

    case "pause": {
      if (state.status !== "running") return unchanged(state)
      return { state: { ...state, status: "paused", pausedAtMs: nowMs }, events: [{ type: "paused" }] }
    }

    case "resume": {
      if (state.status !== "paused" || state.pausedAtMs === null) return unchanged(state)

      const pausedForMs = nowMs - state.pausedAtMs
      const next: RunnerState = {
        ...state,
        status: "running",
        stepStartedAtMs: state.stepStartedAtMs + pausedForMs,
        protocolStartedAtMs: state.protocolStartedAtMs + pausedForMs,
        totalPausedMs: state.totalPausedMs + pausedForMs,
        pausedAtMs: null,
      }
      return { state: next, events: [{ type: "resumed", targetWatts: state.protocol.steps[state.stepIndex].targetWatts }] }
    }

    case "skip": {
      if (state.status !== "running" && state.status !== "paused") return unchanged(state)

      const steps = state.protocol.steps
      const nextIndex = state.stepIndex + 1

      if (nextIndex >= steps.length) {
        return {
          state: { ...state, status: "finished", stepStartedAtMs: nowMs, pausedAtMs: null },
          events: [{ type: "finished" }],
        }
      }

      const next: RunnerState = {
        ...state,
        stepIndex: nextIndex,
        stepStartedAtMs: nowMs,
        pausedAtMs: state.status === "paused" ? nowMs : state.pausedAtMs,
      }
      return { state: next, events: [{ type: "step-started", stepIndex: nextIndex, targetWatts: steps[nextIndex].targetWatts }] }
    }

    case "stop": {
      if (state.status !== "running" && state.status !== "paused") return unchanged(state)
      return { state: { ...state, status: "stopped" }, events: [{ type: "stopped" }] }
    }
  }
}

export interface RunnerView {
  currentStep: ProtocolStep | null
  nextStep: ProtocolStep | null
  stepIndex: number
  stepCount: number
  stepElapsedS: number
  stepRemainingS: number
  totalElapsedS: number
  totalRemainingS: number
  targetWatts: number | null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * A read-only, display-ready snapshot. Pure function of the state and the
 * clock - the panel calls it every render, it never mutates anything.
 */
export function runnerView(state: RunnerState, nowMs: number): RunnerView {
  const steps = state.protocol.steps
  const stepCount = steps.length
  const totalDurationS = protocolDurationSeconds(state.protocol)

  if (state.status === "idle" || stepCount === 0) {
    return {
      currentStep: null,
      nextStep: null,
      stepIndex: 0,
      stepCount,
      stepElapsedS: 0,
      stepRemainingS: 0,
      totalElapsedS: 0,
      totalRemainingS: 0,
      targetWatts: null,
    }
  }

  const stepIndex = Math.min(state.stepIndex, stepCount - 1)
  const currentStep = steps[stepIndex]
  const nextStep = stepIndex + 1 < stepCount ? steps[stepIndex + 1] : null

  // While paused, elapsed time is frozen at the moment of the pause -
  // that is the whole point of pausing a wall-clock-driven runner.
  const effectiveNowMs = state.status === "paused" && state.pausedAtMs !== null ? state.pausedAtMs : nowMs

  const stepDurationS = currentStep.durationSeconds
  const stepElapsedS = clamp((effectiveNowMs - state.stepStartedAtMs) / 1000, 0, stepDurationS)
  const stepRemainingS = state.status === "finished" || state.status === "stopped" ? 0 : stepDurationS - stepElapsedS

  // Not clamped to totalDurationS: once finished/stopped this keeps counting
  // up with real time, and pinning it to the moment the protocol ended isn't
  // required (see the task brief) - only "never negative" is.
  const totalElapsedS = Math.max((effectiveNowMs - state.protocolStartedAtMs) / 1000, 0)
  const totalRemainingS = Math.max(totalDurationS - totalElapsedS, 0)

  return {
    currentStep,
    nextStep,
    stepIndex,
    stepCount,
    stepElapsedS,
    stepRemainingS,
    totalElapsedS,
    totalRemainingS,
    targetWatts: currentStep.targetWatts,
  }
}

/** Total protocol length, in seconds, ignoring pauses and progress. */
export function protocolDurationSeconds(protocol: Protocol): number {
  return protocol.steps.reduce((sum, step) => sum + step.durationSeconds, 0)
}

export interface RampParams {
  startWatts: number
  incrementWatts: number
  stepDurationSeconds: number
  endWatts?: number
  stepCount?: number
}

/**
 * One rule, one constant: the same cap validateSteps enforces, so a generated
 * ramp can never be one step too long to save or start. It also keeps a typo'd
 * stepCount from hanging the UI.
 */
const MAX_RAMP_STEPS = MAX_STEPS

/**
 * A linear ramp: `startWatts`, then `startWatts + incrementWatts`, and so on.
 *
 * Exactly one of `endWatts` / `stepCount` must be given - a ramp is defined
 * either by where it ends or by how many rungs it has, and accepting both (or
 * neither) would leave one of them silently ignored. `endWatts` is inclusive
 * when it lands exactly on a step; otherwise the ramp stops at the last step
 * that does not overshoot it, rather than guessing whether the caller wanted
 * to round up past their own limit.
 */
export function generateRamp(params: RampParams): ProtocolStep[] {
  const { startWatts, incrementWatts, stepDurationSeconds, endWatts, stepCount } = params

  if (incrementWatts === 0) return []
  if (!(stepDurationSeconds > 0)) return []

  const hasEndWatts = endWatts !== undefined
  const hasStepCount = stepCount !== undefined
  if (hasEndWatts === hasStepCount) return [] // neither given, or both given

  let count: number
  if (hasStepCount) {
    if (!(stepCount! > 0)) return []
    count = stepCount!
  } else {
    const span = endWatts! - startWatts
    // A zero span always yields exactly the start step. Otherwise the sign of
    // the span and the sign of the increment must agree, or the ramp would
    // walk away from endWatts forever and never reach it.
    if (span !== 0 && Math.sign(span) !== Math.sign(incrementWatts)) return []
    count = span === 0 ? 1 : Math.floor(span / incrementWatts) + 1
  }

  count = Math.min(count, MAX_RAMP_STEPS)

  return Array.from({ length: count }, (_, i) => ({
    targetWatts: startWatts + incrementWatts * i,
    durationSeconds: stepDurationSeconds,
  }))
}
