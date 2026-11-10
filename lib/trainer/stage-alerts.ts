import type { ProtocolStep, RunnerState } from "./protocol-runner"

export interface StageAlert {
  phase: "idle" | "paused" | "upcoming" | "changed" | "finished"
  countdown: number | null
  secondsRemaining: number | null
  step: ProtocolStep | null
  sound: "beep" | "bell" | null
  soundKey: string | null
}

/** Cues use the runner's clock, including pause adjustments, never a second schedule. */
export function stageAlert(state: RunnerState, nowMs: number): StageAlert {
  const quiet: StageAlert = { phase: "idle", countdown: null, secondsRemaining: null, step: null, sound: null, soundKey: null }
  const steps = state.protocol.steps
  const current = steps[state.stepIndex]
  if (!current || state.status === "idle" || state.status === "stopped") return quiet
  // protocolStartedAtMs shifts on resume; subtracting accumulated pauses gives
  // a stable session identity so resume doesn't replay already-heard cues.
  const session = state.protocolStartedAtMs - state.totalPausedMs
  const age = nowMs - state.stepStartedAtMs
  const recent = age >= 0 && age < 1500
  if (state.status === "finished") return {
    ...quiet, phase: "finished", sound: recent ? "bell" : null,
    soundKey: recent ? `${session}:finished` : null,
  }
  const effectiveNow = state.status === "paused" ? state.pausedAtMs ?? nowMs : nowMs
  const remaining = Math.max(0, state.stepStartedAtMs + current.durationSeconds * 1000 - effectiveNow)
  const secondsRemaining = Math.ceil(remaining / 1000)
  const next = steps[state.stepIndex + 1] ?? null
  if (state.status === "paused") return { ...quiet, phase: "paused", secondsRemaining, step: next }
  // Countdown takes precedence for short test stages. At zero, wait for the
  // runner to commit the transition rather than announcing a target early.
  if (remaining > 0 && remaining <= 3000) return {
    phase: "upcoming", countdown: secondsRemaining, secondsRemaining, step: next,
    sound: "beep", soundKey: `${session}:${state.stepIndex}:count:${secondsRemaining}`,
  }
  if (recent) return {
    ...quiet, phase: "changed", secondsRemaining, step: current,
    sound: "bell", soundKey: `${session}:${state.stepIndex}:start`,
  }
  return { ...quiet, phase: "upcoming", secondsRemaining, step: next }
}

/** Consume each cue once even across rerenders, pauses, and sound toggles. */
export class StageSoundTracker {
  private session: number | null = null
  private heard = new Set<string>()
  take(state: RunnerState, alert: StageAlert): StageAlert["sound"] {
    const session = state.protocolStartedAtMs - state.totalPausedMs
    if (state.status === "idle" || state.status === "stopped" || this.session !== session) {
      this.heard.clear()
      this.session = session
    }
    if (!alert.soundKey || this.heard.has(alert.soundKey)) return null
    this.heard.add(alert.soundKey)
    return alert.sound
  }
}
