/**
 * The Trainer tab's orchestration, out of React: what to send to the trainer,
 * in what order, under which labels, and what to write in the session log.
 *
 * WHY A CLASS AND NOT HOOKS. Everything here used to live in
 * components/trainer-panel.tsx as a bag of refs (`sessionRef`, `startedRef`,
 * `hasControlRef`, `runnerRef`, `startingRef`, …) because the notification path
 * must read the NEWEST value, never a value captured in a render closure. A
 * plain object's fields are exactly that, with none of the ceremony - and,
 * crucially, none of it needs a DOM, so the whole ordered effect stream (0x00
 * before 0x07 before 0x05, one `control-result` row per op) is testable in the
 * repo's node-only vitest with a fake session, the way lib/ftms/control.test.ts
 * tests the GATT layer. See .superpowers/sdd/refactor-feature-modules/design.md
 * for the Option 3 ruling and the behaviour inventory this class must preserve.
 *
 * WHY A SNAPSHOT + subscribe. React still has to render this state. Rather than
 * a dozen setState mirrors, the controller keeps ONE plain object rebuilt on
 * every change (`emit()`) and hands it out through `snapshot`; the panel mirrors
 * it into a single `useState` from a `subscribe` listener. The object is never
 * mutated in place - a memo'd child compares identity - and `emit()` is only
 * ever called from an event handler, a timer or an awaited op, never during
 * render.
 *
 * WHY EVERY COLLABORATOR IS INJECTED. `now`, `setTimer`/`clearTimer`,
 * `openSession`, `requestDevice`, `boardDeviceId` and `log` arrive as deps, so a
 * test can drive the clock and the trainer without a browser. There is no
 * `Date.now()`, `setTimeout` or `console` call in this file.
 *
 * WHAT IS STILL IN THE PANEL (Task 8 moves it here): the connect/reconnect/
 * disconnect flows, the notification handlers, recording, the manual debounce
 * and the mode switch. The methods marked `_task8` and the ones documented as
 * "Task 8 folds this into …" exist for exactly that seam and disappear with it.
 */

import type { FtmsCapabilities, FtmsSession, openFtmsSession } from "../ftms/control"
import { FtmsControlError } from "../ftms/control"
import { DEFAULT_POWER_RANGE, FTMS_RESULT } from "../ftms/protocol"
import { planRunnerEffects, type PlannedOp } from "./control-plan"
import { logProtocolName, logStepIndex } from "./log-context"
import type { TrainerMode } from "./mode"
import { validateSteps } from "./presets"
import {
  createRunner,
  reduceRunner,
  type ProtocolStep,
  type RunnerAction,
  type RunnerEvent,
  type RunnerState,
} from "./protocol-runner"
import { appendEvent, type LogEventKind, type SessionLog } from "./session-log"
import { protocolTargetW, resistanceTenthsFromPct, type ManualTargetSent } from "./targets"

/**
 * The part of `FtmsSession` this controller drives.
 *
 * Structural, so a test can hand over a fake that records its calls - the same
 * reason lib/ftms/control.ts takes characteristic-shaped objects rather than
 * Web Bluetooth types. A real `FtmsSession` satisfies it.
 */
export type TrainerSession = Pick<
  FtmsSession,
  | "capabilities"
  | "requestControl"
  | "reset"
  | "start"
  | "stop"
  | "pause"
  | "setTargetPower"
  | "setTargetResistance"
  | "dispose"
>

/**
 * Everything the panel renders from, as one plain object.
 *
 * Task 8 adds the fields it brings with it: `connecting`, `hasDevice`,
 * `manualTargetW`, `manualResistancePct`, `recording`, `sampleCount`, `hasLog`,
 * `logStartedAtMs`, `live`, `chartData` and `trainerReportedTargetW` - all of
 * them still React state in the panel while their owners are.
 */
export interface TrainerSnapshot {
  connected: boolean
  deviceName: string
  capabilities: FtmsCapabilities | null
  hasControl: boolean
  error: string
  mode: TrainerMode
  manualTargetSent: ManualTargetSent
  runner: RunnerState
  starting: boolean
  steps: ProtocolStep[]
  protocolName: string
}

export interface TrainerControllerDeps {
  /** Task 8: the controller's own connect flow calls this; the panel still does today. */
  openSession: typeof openFtmsSession
  /** Task 8: the trainer's own chooser. */
  requestDevice: (options: RequestDeviceOptions) => Promise<BluetoothDevice>
  /** Task 8: the connected CycloWatt board, so the chooser can reject it. */
  boardDeviceId: () => string | null
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** Injected rather than called directly, so a test is not noisy and can assert on it. */
  log?: Pick<Console, "log" | "warn" | "error">
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class TrainerController {
  /*
   * One private field per ref the panel used to hold, so a reader can trace
   * this file against the behaviour inventory line by line.
   */
  private session: TrainerSession | null = null
  /** Has Start or Resume (0x07) been sent since control was acquired? The Kickr honours ERG targets only after it. */
  private started = false
  private hasControl = false
  private connected = false
  private deviceName = ""
  private capabilities: FtmsCapabilities | null = null
  private error = ""
  private mode: TrainerMode = "protocol"
  /**
   * Which manual target has actually been WRITTEN since the last mode change,
   * or null for none. Without it the readout and every recorded sample would
   * switch to the new mode's target the instant a mode button is clicked, while
   * the trainer still held the old one.
   */
  private manualTargetSent: ManualTargetSent = null
  private runner: RunnerState = createRunner({ name: "", steps: [] })
  /** True across startProtocol's awaits, so a double click cannot mint two runners. */
  private starting = false
  private steps: ProtocolStep[] = [{ targetWatts: 150, durationSeconds: 300 }]
  private protocolName = ""
  private log: SessionLog | null = null

  private snap: TrainerSnapshot
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: TrainerControllerDeps) {
    this.snap = this.buildSnapshot()
  }

  /* -------------------------------------------------------------- snapshot */

  get snapshot(): TrainerSnapshot {
    return this.snap
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private buildSnapshot(): TrainerSnapshot {
    return {
      connected: this.connected,
      deviceName: this.deviceName,
      capabilities: this.capabilities,
      hasControl: this.hasControl,
      error: this.error,
      mode: this.mode,
      manualTargetSent: this.manualTargetSent,
      runner: this.runner,
      starting: this.starting,
      steps: this.steps,
      protocolName: this.protocolName,
    }
  }

  /**
   * Publish the current state.
   *
   * A NEW object every time, never a mutation of the old one: the panel mirrors
   * it into `useState`, and a memo'd child (TrainerChart) compares identity. The
   * listener copy is defensive - a listener may unsubscribe while being called.
   */
  private emit(): void {
    this.snap = this.buildSnapshot()
    for (const listener of [...this.listeners]) listener()
  }

  /* --------------------------------------------------------------- logging */

  /**
   * Append one event row, if there is a log to append it to.
   *
   * Gated on the log EXISTING rather than on `recording`: a log outlives Stop
   * recording (until Clear or a new session), and a disconnect or a refused
   * control op after the samples stop is still worth a row in the file.
   */
  logEvent(event: LogEventKind, detail: string, atMs: number = this.deps.now()): void {
    const log = this.log
    if (!log) return
    appendEvent(log, {
      epochMs: atMs,
      elapsedS: (atMs - log.startedAtMs) / 1000,
      mode: this.mode,
      protocolName: logProtocolName(this.mode, this.protocolName),
      stepIndex: logStepIndex(this.mode, this.runner),
      event,
      detail,
    })
  }

  /** The panel's own error line; the connect flows and the preset editor still write to it. */
  setError(text: string): void {
    this.error = text
    this.emit()
  }

  /**
   * The session log, while the panel still owns the recording buttons.
   *
   * Task 8 moves start/stop/clear/export in here and makes this private; until
   * then `logEvent` needs the log and the Recording card needs to create it, so
   * exactly one accessor spans the seam.
   */
  get _task8Log(): SessionLog | null {
    return this.log
  }

  set _task8Log(log: SessionLog | null) {
    this.log = log
  }

  /* ---------------------------------------------------- control-point layer */

  private markControl(value: boolean): void {
    this.hasControl = value
    this.emit()
  }

  /** See manualTargetSent: the readout must not claim a target the trainer never got. */
  markManualTargetSent(value: ManualTargetSent): void {
    this.manualTargetSent = value
    this.emit()
  }

  /**
   * Run one Control Point procedure, log the outcome, and never throw.
   *
   * CONTROL_NOT_PERMITTED gets exactly one retry behind a fresh Request Control:
   * the trainer drops control silently (another app took it, or it power-cycled
   * the link), and re-taking it is the documented cure. Every other failure is
   * logged and surfaced but SWALLOWED - a target that did not land must not tear
   * down the runner mid-protocol, leaving the rider with no target at all.
   *
   * @param options.restartAfterRetake pass false for the 0x08 ops (Stop, Pause):
   * re-starting the trainer only to stop it again is self-contradictory, and it
   * would leave `started` claiming a started trainer that the op then un-starts.
   * @returns true when the trainer acknowledged (first try or retry).
   */
  private async sendControl(
    label: string,
    run: () => Promise<void>,
    options: { restartAfterRetake?: boolean } = {},
  ): Promise<boolean> {
    const session = this.session
    if (!session) return false
    try {
      await run()
      this.logEvent("control-result", `${label} -> success`)
      return true
    } catch (err) {
      if (err instanceof FtmsControlError && err.resultCode === FTMS_RESULT.CONTROL_NOT_PERMITTED) {
        try {
          await session.requestControl()
          this.markControl(true)
          /*
           * Re-taking control is not enough. Control that was revoked and
           * re-granted leaves the trainer NOT in the started state, so a target
           * written straight after the Request Control is ACKNOWLEDGED and then
           * ignored - and the log would say "success after re-taking control"
           * about a target that never reached the flywheel. 0x07 first.
           */
          const restart = options.restartAfterRetake !== false
          if (restart) {
            this.started = false
            await session.start()
            this.started = true
          }
          await run()
          this.logEvent(
            "control-result",
            `${label} -> success after re-taking control${restart ? " and re-starting" : ""}`,
          )
          return true
        } catch (retryErr) {
          this.markControl(false)
          // The trainer's state is now unknown - the Request Control, the 0x07 or
          // the op itself failed - so claim nothing about it having been started.
          this.started = false
          this.logEvent("control-result", `${label} -> failed after re-taking control: ${errorText(retryErr)}`)
          this.setError(`${label} failed: ${errorText(retryErr)}`)
          return false
        }
      }
      this.logEvent("control-result", `${label} -> failed: ${errorText(err)}`)
      this.setError(`${label} failed: ${errorText(err)}`)
      return false
    }
  }

  /** Control taken and 0x07 sent - the two preconditions for any target to be honoured. */
  private async ensureStarted(): Promise<boolean> {
    const session = this.session
    if (!session) return false
    if (!this.hasControl) {
      if (!(await this.sendControl("Request Control", () => session.requestControl()))) return false
      this.markControl(true)
    }
    if (!this.started) {
      if (!(await this.sendControl("Start or Resume", () => session.start()))) return false
      this.started = true
    }
    return true
  }

  async takeControl(): Promise<void> {
    const session = this.session
    if (!session) return
    this.setError("")
    if (await this.sendControl("Request Control", () => session.requestControl())) this.markControl(true)
  }

  /* ------------------------------------------------------- session handover */

  /**
   * Adopt a freshly opened session: what the panel's `openSession` did once
   * `openFtmsSession` had returned, minus the device listener wiring (the panel
   * still owns the BluetoothDevice, so it still adds and removes that).
   *
   * Task 8 folds this into `connect()`/`reconnect()`.
   */
  async attachSession(session: TrainerSession, deviceName: string): Promise<void> {
    this.session = session
    this.capabilities = session.capabilities
    this.deviceName = deviceName
    this.connected = true
    this.started = false
    this.hasControl = false
    this.manualTargetSent = null
    this.emit()

    // One line per connect, so the PR's hardware checklist can be filled in from
    // the console rather than from a screenshot of the badges. The raw feature
    // words are the part worth having verbatim: a bit this panel does not read
    // yet is still visible in them.
    const caps = session.capabilities
    this.deps.log?.log("Trainer capabilities", {
      features: caps.features,
      rawFeatureWords: caps.features
        ? `machine=0x${caps.features.raw.machine.toString(16).padStart(8, "0")} ` +
          `targetSetting=0x${caps.features.raw.targetSetting.toString(16).padStart(8, "0")}`
        : "unknown - the trainer did not publish 0x2ACC",
      powerRange: caps.powerRange,
      resistanceRange: caps.resistanceRange,
      resistanceWireCeilingTenths: Math.min(caps.resistanceRange.max, 0xff),
    })

    this.logEvent("connected", deviceName)

    if (await this.sendControl("Request Control", () => session.requestControl())) this.markControl(true)
  }

  /**
   * The link went away on its own (`gattserverdisconnected`): forget the session
   * and stop claiming a live link, a started trainer or a manual target.
   *
   * The dispose is deliberately not awaited - it is talking to a link that has
   * already gone. `deviceName`, the capabilities, the log and the chart are all
   * kept, so Reconnect and Export still work. Task 8 folds this into
   * `onLinkLost()`, together with the rows that follow it.
   */
  detachSession(): void {
    void this.session?.dispose()
    this.session = null
    this.connected = false
    this.hasControl = false
    this.started = false
    this.manualTargetSent = null
    this.emit()
  }

  /**
   * The operator pressed Disconnect: tear the session down and wait for it, so
   * the panel's `gatt.disconnect()` follows a clean unsubscribe.
   *
   * Nothing snapshot-visible changes here - `connected` stays true until
   * `clearConnection()`, exactly as the panel's state did, because the rows
   * written in between must keep their order. Task 8 folds both into
   * `disconnect()`.
   */
  async disposeSession(): Promise<void> {
    await this.session?.dispose()
    this.session = null
  }

  /** The state clearing that ends an operator disconnect: no device, no capabilities, no control. */
  clearConnection(): void {
    this.connected = false
    this.hasControl = false
    this.started = false
    this.manualTargetSent = null
    this.deviceName = ""
    this.capabilities = null
    this.emit()
  }

  /**
   * The trainer revoked control (another app took it).
   *
   * Fired by the session AFTER its `onStatus`, so the `status` row the panel
   * writes always precedes these. No writes: control is gone, and asking a
   * trainer that just refused us to pause would only queue another refusal.
   */
  onControlLost(): void {
    this.markControl(false)
    this.started = false
    // Whatever manual target we set is no longer ours to claim - the trainer is
    // taking someone else's now.
    this.markManualTargetSent(null)
    this.logEvent("control-lost", "the trainer revoked control")
    const nowMs = this.deps.now()
    this.pauseWithoutSending(nowMs)
    this.setError("The trainer revoked control (another app took it). Press Take Control to continue.")
  }

  /**
   * Pause a running protocol because the LINK is gone, not because the operator
   * asked: the runner must stop walking step boundaries and logging targets
   * nothing can receive, but no BLE write may be queued behind a dead Control
   * Point. A no-op unless the runner is actually running.
   */
  pauseWithoutSending(nowMs: number): void {
    if (this.runner.status !== "running") return
    const { state, events } = reduceRunner(this.runner, { type: "pause" }, nowMs)
    this.commitRunner(state)
    this.applyEvents(events, nowMs, { send: false })
  }

  /* --------------------------------------------------------- runner layer */

  setSteps(steps: ProtocolStep[]): void {
    this.steps = steps
    this.emit()
  }

  setProtocolName(name: string): void {
    this.protocolName = name
    this.emit()
  }

  /**
   * The mode the panel's `changeMode` just chose. Only the field write: the
   * pending-debounce drop, the `manualTargetSent` clear and the target that a
   * switch into a manual sub-mode writes all still live in the panel, which
   * Task 8 moves in as `changeMode`.
   */
  _task8SetMode(mode: TrainerMode): void {
    this.mode = mode
    this.emit()
  }

  private commitRunner(state: RunnerState): void {
    this.runner = state
    this.emit()
  }

  /**
   * Log every runner event, and (unless `send` is false) put the trainer where
   * the runner now says it should be.
   *
   * `send: false` is for the two cases where the runner moves BECAUSE the link
   * is gone - a disconnect or a revoked control - and a write would only queue
   * up behind a dead Control Point.
   *
   * Every DECISION here - which rows, which opcodes, in which order, under
   * which labels, and how `started` moves - lives in planRunnerEffects
   * (lib/trainer/control-plan.ts), behind an exhaustive unit test. What is
   * left below is the interpreter that puts that plan on the wire.
   */
  private applyEvents(events: RunnerEvent[], nowMs: number, options: { send?: boolean } = {}): void {
    const session = this.session
    const started = this.started
    const plan = planRunnerEffects({
      events,
      started,
      powerRange: session?.capabilities.powerRange ?? DEFAULT_POWER_RANGE,
      runnerStatusAfter: this.runner.status,
      send: options.send !== false && session !== null,
    })

    // Rows first, in event order - and written even when nothing is sent.
    for (const row of plan.rows) this.logEvent(row.event, row.detail, nowMs)

    if (!session || plan.ops.length === 0) return

    /*
     * Stop's 0x08 puts the trainer back in the state where it honours no ERG
     * target, so the next run has to send 0x07 again (see ensureStarted). Set
     * NOW, before any await: a fast Start click must not find a stale `true`
     * while these writes are still queued. Only ever a clear - the plan never
     * claims a trainer started that the ops below have not started.
     */
    if (plan.startedBeforeOps !== started) this.started = plan.startedBeforeOps

    /** One planned op on the wire. Its label is the `control-result` row it logs. */
    const issue = (op: PlannedOp): Promise<boolean> => {
      switch (op.kind) {
        case "start":
          return this.sendControl(op.label, () => session.start())
        case "targetPower":
          return this.sendControl(op.label, () => session.setTargetPower(op.watts))
        case "stop":
          return this.sendControl(op.label, () => session.stop(), { restartAfterRetake: false })
        case "pause":
          return this.sendControl(op.label, () => session.pause(), { restartAfterRetake: false })
      }
    }

    if (plan.sequencing === "chain") {
      // The protocol-end ops, serialised in one async run rather than fired as
      // independent calls, so the order on the wire is 0x07 -> target -> 0x08
      // whatever the queue does - and a failed 0x07 abandons the rest.
      void (async () => {
        for (const op of plan.ops) {
          const acknowledged = await issue(op)
          if (op.kind !== "start") continue
          if (!acknowledged) {
            if (plan.abortChainOnStartFailure) return
            continue
          }
          if (op.markStartedOnSuccess) this.started = true
        }
      })()
      return
    }

    // A step target and a Pause are each fired without awaiting the other one.
    for (const op of plan.ops) {
      void issue(op)
      if (op.kind === "pause") this.started = false // as for Stop above: Resume must re-send 0x07.
    }
  }

  /**
   * Walk the runner to `nowMs`. Driven from three sources (a 250 ms interval,
   * every Indoor Bike Data notification, and `visibilitychange`), so most calls
   * are no-ops: `reduceRunner` hands back the SAME reference for one, which is
   * the check that keeps a 4 Hz interval from re-rendering.
   */
  tick(nowMs: number): void {
    const previous = this.runner
    const { state, events } = reduceRunner(previous, { type: "tick" }, nowMs)
    if (state === previous) return
    this.commitRunner(state)
    this.applyEvents(events, nowMs)
  }

  /**
   * Load the edited steps into a fresh runner and start it.
   *
   * Re-entrancy matters here: ensureStarted awaits up to two Control Point round
   * trips (5 s each in the worst case) while the runner is still `idle`, so the
   * Start button's own `disabled` cannot cover the gap - a second click would
   * mint a SECOND runner over the first and leave two `start` reductions racing.
   * The `starting` FIELD is what actually holds the door, since two clicks in
   * one tick would both see the rendered snapshot's `starting` false.
   */
  async startProtocol(): Promise<void> {
    if (this.starting) return
    const problem = validateSteps(this.steps)
    if (problem !== null) {
      this.setError(`Cannot start the protocol: ${problem}.`)
      return
    }
    this.setError("")
    this.starting = true
    this.emit()
    try {
      const fresh = createRunner({ name: this.protocolName.trim() || "Protocol", steps: this.steps })
      this.commitRunner(fresh)
      if (!(await this.ensureStarted())) return
      const nowMs = this.deps.now()
      const { state, events } = reduceRunner(fresh, { type: "start" }, nowMs)
      this.commitRunner(state)
      this.applyEvents(events, nowMs)
    } finally {
      this.starting = false
      this.emit()
    }
  }

  dispatchRunner(action: RunnerAction): void {
    const nowMs = this.deps.now()
    const { state, events } = reduceRunner(this.runner, action, nowMs)
    if (state === this.runner) return
    this.commitRunner(state)
    this.applyEvents(events, nowMs)
  }

  async resumeProtocol(): Promise<void> {
    // 0x07 again first: a pause sent 0x08, and the trainer applies no ERG target
    // until it has been started once more.
    if (!(await this.ensureStarted())) return
    this.dispatchRunner({ type: "resume" })
  }

  /* ---------------------------------------------------------- manual targets */

  async sendManualPower(watts: number): Promise<void> {
    const session = this.session
    if (!session) return
    if (!(await this.ensureStarted())) return
    if (await this.sendControl(`Set Target Power ${watts} W`, () => session.setTargetPower(watts))) {
      this.logEvent("target-set", `${watts} W (manual)`)
      this.markManualTargetSent("power")
    }
  }

  async sendManualResistance(pct: number): Promise<void> {
    const session = this.session
    if (!session) return
    if (!(await this.ensureStarted())) return
    const tenths = resistanceTenthsFromPct(pct, session.capabilities.resistanceRange)
    if (await this.sendControl(`Set Target Resistance ${tenths / 10}`, () => session.setTargetResistance(tenths))) {
      this.logEvent("target-set", `${pct} % -> ${tenths / 10} resistance level (manual)`)
      this.markManualTargetSent("resistance")
    }
  }

  /**
   * Put the trainer back where the panel thinks it is after a re-opened link:
   * it has forgotten every target, and 0x07 has to precede them all
   * (ensureStarted).
   *
   * The two manual values are parameters because the panel still owns those
   * sliders; Task 8 folds this whole method into `reconnect()`.
   */
  async restoreTargetAfterReconnect(manualTargetW: number, manualResistancePct: number): Promise<void> {
    const session = this.session
    if (!session) return
    const target = this.mode === "protocol" ? protocolTargetW(this.runner, this.deps.now()) : null
    if (target !== null) {
      if (!(await this.ensureStarted())) return
      const watts = target
      if (await this.sendControl(`Set Target Power ${watts} W`, () => session.setTargetPower(watts))) {
        this.logEvent("target-set", `${watts} W (re-sent after reconnect)`)
      }
    } else if (this.mode === "manual-power") {
      await this.sendManualPower(manualTargetW)
    } else if (this.mode === "manual-resistance") {
      await this.sendManualResistance(manualResistancePct)
    }
  }
}
