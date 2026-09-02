/**
 * The Trainer tab's orchestration, out of React: what to send to the trainer,
 * in what order, under which labels, and what to write in the session log.
 *
 * WHY A CLASS AND NOT HOOKS. Everything here used to live in
 * components/trainer-panel.tsx as a bag of refs (`sessionRef`, `startedRef`,
 * `hasControlRef`, `runnerRef`, `startingRef`, `liveRef`, `recordingRef`, …)
 * because the notification path must read the NEWEST value, never a value
 * captured in a render closure. A plain object's fields are exactly that, with
 * none of the ceremony - and, crucially, none of it needs a DOM, so the whole
 * ordered effect stream (0x00 before 0x07 before 0x05, one `control-result` row
 * per op) is testable in the repo's node-only vitest with a fake session and a
 * fake device, the way lib/ftms/control.test.ts tests the GATT layer. See
 * .superpowers/sdd/refactor-feature-modules/design.md for the Option 3 ruling
 * and the behaviour inventory this class must preserve.
 *
 * WHY A SNAPSHOT + subscribe. React still has to render this state. Rather than
 * a dozen setState mirrors, the controller keeps ONE plain object rebuilt on
 * every change (`emit()`) and hands it out through `snapshot`; the hook
 * (hooks/use-trainer-controller.ts) mirrors it into a single `useState` from a
 * `subscribe` listener. The object is never mutated in place - a memo'd child
 * compares identity - and `emit()` is only ever called from an event handler, a
 * timer or an awaited op, never during render.
 *
 * WHY EVERY COLLABORATOR IS INJECTED. `now`, `setTimer`/`clearTimer`,
 * `openSession`, `requestDevice`, `bluetoothAvailable`, `boardDeviceId` and
 * `log` arrive as deps, so a test can drive the clock, the timers and the
 * trainer without a browser. There is no `Date.now()`, `setTimeout`, `console`
 * or `navigator` in this file - the two browser globals the connect flow needs
 * are the hook's closures.
 *
 * WHY dispose() ON UNMOUNT, NOT ON MOUNT-ONLY. The controller outlives every
 * render but not the component: whoever constructs it must tear it down when
 * the component goes away, so `dispose()` belongs in the cleanup of the SAME
 * effect that owns the controller's lifetime - never split into a separate
 * `[]`-only effect. That matters because of StrictMode: React mounts, cleans
 * up and re-mounts every effect once in development, so a mount-only effect
 * would call `dispose()` the instant the controller is constructed, before
 * anything has subscribed to it. Tied to the controller instance instead,
 * teardown fires only when the real instance goes away - releasing the
 * BluetoothDevice listener, the FTMS session and the two timers.
 *
 * WHAT IS LEFT IN THE PANEL: the presets card (localStorage, no trainer I/O),
 * the three timer effects that call in here, the Blob download that `csvForExport`
 * feeds, and the layout. Nothing that talks to the trainer, and no mirror refs.
 */

import { isBoardName, BOARD_NAME_PREFIXES } from "../device-name"
import type { FtmsCapabilities, FtmsServer, FtmsSession, FtmsSessionHandlers } from "../ftms/control"
import { FtmsControlError } from "../ftms/control"
import type { IndoorBikeData } from "../ftms/indoor-bike-data"
import {
  DEFAULT_POWER_RANGE,
  FTMS_OPTIONAL_SERVICES,
  FTMS_RESULT,
  FTMS_SERVICE_UUID,
  type FtmsStatus,
} from "../ftms/protocol"
import { appendChartPoint, type TrainerChartPoint } from "./chart-buffer"
import { planRunnerEffects, type PlannedOp } from "./control-plan"
import { createThrottle } from "./display-throttle"
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
import {
  appendEvent,
  appendSample,
  createSessionLog,
  sessionLogFilename,
  sessionLogToCsv,
  type LogEventKind,
  type SessionLog,
} from "./session-log"
import { protocolTargetW, resistanceTenthsFromPct, type ManualTargetSent } from "./targets"

/** Display flush cadence: notifications arrive faster than a human reads. */
const DISPLAY_FLUSH_MS = 250
/** A slider drag or a held ±button fires far faster than the Control Point should. */
const MANUAL_DEBOUNCE_MS = 150
/** The panel's own starting values for the two manual sliders. */
const DEFAULT_MANUAL_TARGET_W = 100
const DEFAULT_MANUAL_RESISTANCE_PCT = 20

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
 * The part of `BluetoothDevice` this controller holds on to: enough to open a
 * session on it (`gatt`, via openFtmsSession's own `FtmsDevice`), to drop the
 * link (`gatt.disconnect`), to hear about a drop, and to run the post-pick
 * board guard (`name`, `id`). A real `BluetoothDevice` satisfies it.
 */
export interface TrainerDevice {
  id?: string
  name?: string | null
  gatt?: (FtmsServer & { disconnect: () => void }) | null
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/** One Indoor Bike Data notification, as the readouts show it. */
export interface LiveSample {
  powerW: number | null
  cadenceRpm: number | null
  speedKmh: number | null
  hrBpm: number | null
  receivedAtMs: number
}

/** Everything the panel renders from, as one plain object. */
export interface TrainerSnapshot {
  connected: boolean
  /** A chooser or a session open is in flight; both Connect and Reconnect use it. */
  connecting: boolean
  /** Is there a device to Reconnect to or Disconnect from? */
  hasDevice: boolean
  deviceName: string
  capabilities: FtmsCapabilities | null
  hasControl: boolean
  error: string
  mode: TrainerMode
  manualTargetSent: ManualTargetSent
  manualTargetW: number
  manualResistancePct: number
  runner: RunnerState
  starting: boolean
  steps: ProtocolStep[]
  protocolName: string
  recording: boolean
  /** A log exists (recording or stopped-but-unexported), so Clear has something to drop. */
  hasLog: boolean
  logStartedAtMs: number | null
  sampleCount: number
  /** The throttled reading, not the newest one - see the display throttle. */
  live: LiveSample | null
  chartData: TrainerChartPoint[]
  trainerReportedTargetW: number | null
  /** Re-render clock, so `stale` and the elapsed labels move on their own. */
  nowTick: number
}

export interface TrainerControllerDeps {
  /** `openFtmsSession`, narrowed to what this class calls. */
  openSession: (device: TrainerDevice, handlers: FtmsSessionHandlers) => Promise<TrainerSession>
  /** The trainer's own chooser - see WHY ITS OWN CHOOSER on `connect`. */
  requestDevice: (options: RequestDeviceOptions) => Promise<TrainerDevice>
  /**
   * Is Web Bluetooth there AT CALL TIME? A closure rather than a boolean
   * because the panel builds this controller during a render that the static
   * export also runs in node, where `navigator` does not exist yet.
   */
  bluetoothAvailable?: () => boolean
  /** The connected CycloWatt board, so the chooser can reject it. */
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
  private connecting = false
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
  private manualTargetW = DEFAULT_MANUAL_TARGET_W
  private manualResistancePct = DEFAULT_MANUAL_RESISTANCE_PCT
  private runner: RunnerState = createRunner({ name: "", steps: [] })
  /** True across startProtocol's awaits, so a double click cannot mint two runners. */
  private starting = false
  private steps: ProtocolStep[] = [{ targetWatts: 150, durationSeconds: 300 }]
  private protocolName = ""
  private log: SessionLog | null = null
  private recording = false
  private sampleCount = 0

  /**
   * The device the `gattserverdisconnected` listener is attached to.
   *
   * A BluetoothDevice outlives the panel - the browser keeps it for the life of
   * the grant - so `dispose()` MUST detach the listener from it. The panel used
   * to hold this twice (a `device` state for the buttons and a `deviceRef` for
   * that closure); one field is both.
   */
  private device: TrainerDevice | null = null

  /** The newest reading; `live` is the throttled one the panel renders. */
  private liveLatest: LiveSample | null = null
  private live: LiveSample | null = null
  private readonly chartBuffer: TrainerChartPoint[] = []
  private chartData: TrainerChartPoint[] = []
  /** t=0 of the chart's x axis: the first notification of the session. */
  private chartStartMs: number | null = null
  private trainerReportedTargetW: number | null = null
  private nowTick = 0

  /** The single shared manual debounce; both sub-modes use it (only one target is ever live). */
  private manualTimer: unknown = null
  private readonly throttle: { queue(): void; cancel(): void }

  private snap: TrainerSnapshot
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: TrainerControllerDeps) {
    /*
     * Leading + trailing, as page.tsx's queueSerialDisplayUpdate: immediate when
     * the display is stale, else one deferred flush so a burst's final value is
     * never lost.
     */
    this.throttle = createThrottle({
      intervalMs: DISPLAY_FLUSH_MS,
      now: deps.now,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      onFlush: (nowMs) => this.flushDisplay(nowMs),
    })
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

  /**
   * The in-memory log, read-only.
   *
   * Nothing in the UI reads it - the Recording card renders `sampleCount` /
   * `hasLog` from the snapshot and exports through `csvForExport()`. It is
   * public so the ordered ROW STREAM, the thing this refactor has to preserve
   * row for row, is assertable in lib/trainer/controller.test.ts.
   */
  get sessionLog(): SessionLog | null {
    return this.log
  }

  private buildSnapshot(): TrainerSnapshot {
    return {
      connected: this.connected,
      connecting: this.connecting,
      hasDevice: this.device !== null,
      deviceName: this.deviceName,
      capabilities: this.capabilities,
      hasControl: this.hasControl,
      error: this.error,
      mode: this.mode,
      manualTargetSent: this.manualTargetSent,
      manualTargetW: this.manualTargetW,
      manualResistancePct: this.manualResistancePct,
      runner: this.runner,
      starting: this.starting,
      steps: this.steps,
      protocolName: this.protocolName,
      recording: this.recording,
      hasLog: this.log !== null,
      logStartedAtMs: this.log?.startedAtMs ?? null,
      sampleCount: this.sampleCount,
      live: this.live,
      chartData: this.chartData,
      trainerReportedTargetW: this.trainerReportedTargetW,
      nowTick: this.nowTick,
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
  private logEvent(event: LogEventKind, detail: string, atMs: number = this.deps.now()): void {
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

  /** The panel's own error line; the preset editor still writes to it. */
  setError(text: string): void {
    this.error = text
    this.emit()
  }

  /* ---------------------------------------------------- control-point layer */

  private markControl(value: boolean): void {
    this.hasControl = value
    this.emit()
  }

  /** See manualTargetSent: the readout must not claim a target the trainer never got. */
  private markManualTargetSent(value: ManualTargetSent): void {
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

  /* --------------------------------------------------- connect / disconnect */

  /**
   * Pick a trainer and open a session on it.
   *
   * WHY ITS OWN CHOOSER. Chrome binds the set of reachable GATT services to the
   * grant made at requestDevice() time, so a device picked in the board chooser
   * can never be asked for FTMS afterwards - the grant trap that also shapes
   * connectReferencePowerMeter in app/page.tsx. The trainer therefore gets its
   * own requestDevice call, declaring every service it might ever read
   * (FTMS_OPTIONAL_SERVICES), with a two-layer board guard: exclusionFilters to
   * keep our own boards out of the list a human sees, plus a post-pick name/id
   * check because Web Bluetooth filters are OR-ed and cannot express "this
   * service but not that name".
   */
  async connect(): Promise<void> {
    if (this.deps.bluetoothAvailable && !this.deps.bluetoothAvailable()) {
      this.setError("Web Bluetooth API is not supported in this browser.")
      return
    }

    this.connecting = true
    this.error = ""
    this.emit()
    try {
      const requestOptions: RequestDeviceOptions = {
        filters: [{ services: [FTMS_SERVICE_UUID] }],
        optionalServices: [...FTMS_OPTIONAL_SERVICES],
      }
      // .catch, not try/catch, so the whole flow below has one const binding
      // whichever chooser produced it (as connectReferencePowerMeter does).
      const candidate = await this.deps
        .requestDevice({
          ...requestOptions,
          exclusionFilters: BOARD_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
        } as RequestDeviceOptions)
        .catch((err: unknown) => {
          // A cancelled chooser is a DOMException and must keep propagating. Only
          // an engine that does not understand exclusionFilters throws TypeError,
          // and it gets a second, plain chooser rather than a dead button.
          if (!(err instanceof TypeError)) throw err
          this.deps.log?.warn("exclusionFilters unsupported here; relying on the post-pick check")
          return this.deps.requestDevice(requestOptions)
        })

      // Reject before connecting, so no trainer state is ever touched by one of
      // ours. The id check catches the same board under a name the prefix list
      // does not know.
      const boardId = this.deps.boardDeviceId()
      if (isBoardName(candidate.name) || (candidate.id && candidate.id === boardId)) {
        this.setError(
          `${candidate.name || "That device"} is a CycloWatt board, not a trainer. ` +
            "Pick the Kickr (or another FTMS trainer) here - a CycloWatt board connects " +
            "with the sensor connection on the Data Streaming tab.",
        )
        this.deps.log?.warn("Rejected a CycloWatt board picked as the trainer")
        return
      }

      await this.openSession(candidate)
    } catch (err) {
      this.deps.log?.error("Trainer connection failed:", err)
      this.setError(`Trainer connection failed: ${errorText(err)}`)
    } finally {
      this.connecting = false
      this.emit()
    }
  }

  /** Re-open on the device we already have a grant for - no chooser, so no new grant. */
  async reconnect(): Promise<void> {
    const device = this.device
    if (!device) return
    this.connecting = true
    this.error = ""
    this.emit()
    try {
      await this.openSession(device)
      await this.restoreTargetAfterReconnect()
    } catch (err) {
      this.deps.log?.error("Trainer reconnect failed:", err)
      this.setError(`Trainer reconnect failed: ${errorText(err)}`)
    } finally {
      this.connecting = false
      this.emit()
    }
  }

  /**
   * Open a session on `target` and adopt it.
   *
   * The drop listener is wired just BEFORE the session is adopted (rather than
   * in the middle, where the console line used to sit) so it is already
   * attached across the opening Request Control's round trip. Remove first: a
   * reconnect on the same device would otherwise stack a second listener, and
   * every later drop would run the handler twice.
   */
  private async openSession(target: TrainerDevice): Promise<void> {
    const session = await this.deps.openSession(target, {
      onBikeData: (data, receivedAtMs) => this.handleBikeData(data, receivedAtMs),
      onStatus: (status) => this.handleStatus(status),
      onControlLost: () => this.onControlLost(),
    })

    this.device = target
    this.trainerReportedTargetW = null
    target.removeEventListener("gattserverdisconnected", this.onGattDisconnected)
    target.addEventListener("gattserverdisconnected", this.onGattDisconnected)

    this.session = session
    this.capabilities = session.capabilities
    this.deviceName = target.name || "Trainer"
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

    this.logEvent("connected", this.deviceName)

    if (await this.sendControl("Request Control", () => session.requestControl())) this.markControl(true)
  }

  /**
   * Put the trainer back where the panel thinks it is after a re-opened link:
   * it has forgotten every target, and 0x07 has to precede them all
   * (ensureStarted).
   */
  private async restoreTargetAfterReconnect(): Promise<void> {
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
      await this.sendManualPower(this.manualTargetW)
    } else if (this.mode === "manual-resistance") {
      await this.sendManualResistance(this.manualResistancePct)
    }
  }

  /**
   * The operator pressed Disconnect: tear the session down and wait for it, so
   * the `gatt.disconnect()` that follows lands on a clean unsubscribe.
   *
   * `session = null` AFTER the await here, unlike the two teardown paths below:
   * that is what the panel's separate setStates did, and the rows written after
   * it must still be written while `connected` is true - hence the clearing at
   * the end rather than up front. No BLE writes: the session is already gone.
   * The log and the chart are kept, so Export still works.
   */
  async disconnect(): Promise<void> {
    const target = this.device
    target?.removeEventListener("gattserverdisconnected", this.onGattDisconnected)
    await this.session?.dispose()
    this.session = null
    try {
      if (target?.gatt?.connected) target.gatt.disconnect()
    } catch (err) {
      this.deps.log?.warn("Trainer disconnect: gatt.disconnect() failed", err)
    }

    const nowMs = this.deps.now()
    // A runner left running with no session keeps ticking step boundaries and
    // logging step-started rows for targets nothing can receive.
    this.pauseWithoutSending(nowMs)
    this.logEvent("disconnected", "disconnected by the operator", nowMs)

    this.connected = false
    this.hasControl = false
    this.started = false
    this.manualTargetSent = null
    this.deviceName = ""
    this.capabilities = null
    this.device = null
    this.trainerReportedTargetW = null
    this.emit()
  }

  /**
   * One stable listener for the controller's whole life - add/removeEventListener
   * must see the same reference.
   */
  private readonly onGattDisconnected = (): void => {
    this.onLinkLost()
  }

  /**
   * The link went away on its own (`gattserverdisconnected`): forget the session
   * and stop claiming a live link, a started trainer or a manual target.
   *
   * `session = null` FIRST, then the un-awaited dispose: the dispose is talking
   * to a link that has already gone, so it may take a while or reject, and a
   * notification landing in the meantime must not find a session and drive a
   * write into it. `deviceName`, the capabilities, the log and the chart are all
   * kept, so Reconnect and Export still work.
   */
  private onLinkLost(): void {
    const session = this.session
    this.session = null
    void session?.dispose()
    this.connected = false
    this.hasControl = false
    this.started = false
    this.manualTargetSent = null
    this.emit()

    const nowMs = this.deps.now()
    this.pauseWithoutSending(nowMs)
    this.logEvent("disconnected", "link lost", nowMs)
  }

  /**
   * The trainer revoked control (another app took it).
   *
   * Fired by the session AFTER its `onStatus`, so the `status` row handleStatus
   * writes always precedes these. No writes: control is gone, and asking a
   * trainer that just refused us to pause would only queue another refusal.
   */
  private onControlLost(): void {
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
  private pauseWithoutSending(nowMs: number): void {
    if (this.runner.status !== "running") return
    const { state, events } = reduceRunner(this.runner, { type: "pause" }, nowMs)
    this.commitRunner(state)
    this.applyEvents(events, nowMs, { send: false })
  }

  /**
   * The panel is unmounting: let go of everything that outlives it.
   *
   * The listener goes through `this.device`, not a render closure, because a
   * BluetoothDevice outlives the component - left attached, it would fire into a
   * dead panel on every later drop. `session = null` before the un-awaited
   * dispose, as in onLinkLost. No row and no write: an unmount is not an
   * operator disconnect.
   */
  dispose(): void {
    this.device?.removeEventListener("gattserverdisconnected", this.onGattDisconnected)
    this.device = null
    const session = this.session
    this.session = null
    void session?.dispose()
    this.throttle.cancel()
    this.clearManualTimer()
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

  /**
   * Switch mode (or manual sub-mode) and put the TRAINER where the panel now
   * claims it is.
   *
   * A bare mode write was a lie waiting to be recorded: the readout and every
   * sample would show the new mode's target immediately while the trainer still
   * held the previous one - Set Target Power and Set Target Resistance Level are
   * different ops and only one target is live at a time. So a switch into either
   * manual sub-mode writes that sub-mode's current target straight away, and a
   * switch into protocol mode writes nothing (there is no protocol target until
   * the runner starts, and protocolTargetW reports null until then).
   *
   * Any pending manual debounce is dropped first: it belongs to the sub-mode
   * being left, and letting it fire would set that target after the switch.
   */
  changeMode(next: TrainerMode): void {
    if (next === this.mode) return
    this.clearManualTimer()
    this.manualTargetSent = null
    // The field is written straight away, so the very next notification records
    // the mode the operator just chose - what modeRef did.
    this.mode = next
    this.emit()

    if (!this.connected) return // nothing to sync, and the null flag keeps the readout at "–"
    if (next === "manual-power") void this.sendManualPower(this.manualTargetW)
    else if (next === "manual-resistance") void this.sendManualResistance(this.manualResistancePct)
  }

  setManualTargetW(watts: number): void {
    this.manualTargetW = watts
    this.emit()
    if (this.connected && this.mode === "manual-power") {
      this.queueManualSend(() => this.sendManualPower(watts))
    }
  }

  setManualResistancePct(pct: number): void {
    this.manualResistancePct = pct
    this.emit()
    if (this.connected && this.mode === "manual-resistance") {
      this.queueManualSend(() => this.sendManualResistance(pct))
    }
  }

  private clearManualTimer(): void {
    if (this.manualTimer === null) return
    this.deps.clearTimer(this.manualTimer)
    this.manualTimer = null
  }

  /**
   * Coalesce a burst of manual edits into one write.
   *
   * A slider drag or a held ±button produces edits far faster than a 5 s-timeout
   * Control Point queue should be fed; both sub-modes share the timer because
   * only one manual target is ever live on the trainer.
   */
  private queueManualSend(run: () => Promise<void>): void {
    this.clearManualTimer()
    this.manualTimer = this.deps.setTimer(() => {
      this.manualTimer = null
      void run()
    }, MANUAL_DEBOUNCE_MS)
  }

  private async sendManualPower(watts: number): Promise<void> {
    const session = this.session
    if (!session) return
    if (!(await this.ensureStarted())) return
    if (await this.sendControl(`Set Target Power ${watts} W`, () => session.setTargetPower(watts))) {
      this.logEvent("target-set", `${watts} W (manual)`)
      this.markManualTargetSent("power")
    }
  }

  private async sendManualResistance(pct: number): Promise<void> {
    const session = this.session
    if (!session) return
    if (!(await this.ensureStarted())) return
    const tenths = resistanceTenthsFromPct(pct, session.capabilities.resistanceRange)
    if (await this.sendControl(`Set Target Resistance ${tenths / 10}`, () => session.setTargetResistance(tenths))) {
      this.logEvent("target-set", `${pct} % -> ${tenths / 10} resistance level (manual)`)
      this.markManualTargetSent("resistance")
    }
  }

  /* -------------------------------------------------------- notifications */

  /**
   * One Indoor Bike Data notification: the whole hot path.
   *
   * Everything read here is a FIELD, never a rendered value - the closure the
   * session holds was captured once, at connect time. The sample is appended
   * BEFORE the tick, so a notification that arrives across a step boundary is
   * recorded against the step that is ending rather than the one the tick is
   * about to start. No setState of any kind: the display goes through the
   * throttle.
   */
  private handleBikeData(data: IndoorBikeData, nowMs: number): void {
    this.liveLatest = {
      powerW: data.powerW,
      cadenceRpm: data.cadenceRpm,
      speedKmh: data.speedKmh,
      hrBpm: data.heartRateBpm,
      receivedAtMs: nowMs,
    }

    if (this.chartStartMs === null) this.chartStartMs = nowMs
    // manual-power only counts once its target has actually been written - see
    // manualTargetSent. Until then this row records no target, because there
    // isn't one this panel put on the wire.
    const targetW =
      this.mode === "protocol"
        ? protocolTargetW(this.runner, nowMs)
        : this.mode === "manual-power" && this.manualTargetSent === "power"
          ? this.manualTargetW
          : null

    appendChartPoint(this.chartBuffer, {
      t: (nowMs - this.chartStartMs) / 1000,
      power: data.powerW,
      target: targetW,
      cadence: data.cadenceRpm,
    })

    const log = this.log
    if (this.recording && log) {
      appendSample(log, {
        epochMs: nowMs,
        elapsedS: (nowMs - log.startedAtMs) / 1000,
        mode: this.mode,
        protocolName: logProtocolName(this.mode, this.protocolName),
        stepIndex: logStepIndex(this.mode, this.runner),
        stepTargetW: targetW,
        targetResistancePct:
          this.mode === "manual-resistance" && this.manualTargetSent === "resistance"
            ? this.manualResistancePct
            : null,
        powerW: data.powerW,
        cadenceRpm: data.cadenceRpm,
        speedKmh: data.speedKmh,
        hrBpm: data.heartRateBpm,
      })
      // sampleCount is refreshed from the log on the throttled flush, not here:
      // one publish per notification is exactly what the throttle exists to avoid.
    }

    this.tick(nowMs)
    this.throttle.queue()
  }

  /** Every status the trainer volunteers goes in the log verbatim; one of them is also rendered. */
  private handleStatus(status: FtmsStatus): void {
    this.logEvent("status", JSON.stringify(status))
    if (status.kind === "targetPowerChanged") {
      // Unthrottled: it is one notification per operator action, not per second.
      this.trainerReportedTargetW = status.watts
      this.emit()
    }
  }

  /** Publish the throttled display state - one object for all four values. */
  private flushDisplay(nowMs: number): void {
    this.live = this.liveLatest
    // A NEW array every flush: TrainerChart is memo'd and compares identity.
    this.chartData = [...this.chartBuffer]
    this.sampleCount = this.log?.samples.length ?? 0
    this.nowTick = nowMs
    this.emit()
  }

  /**
   * The panel's 1 s re-render clock, so `stale` and the elapsed labels move on
   * their own between notifications. The interval that drives it stays in the
   * panel (it is gated on rendered state); the value lives here because the
   * display flush sets it too.
   */
  setNowTick(nowMs: number): void {
    this.nowTick = nowMs
    this.emit()
  }

  /* -------------------------------------------------------------- recording */

  startRecording(): void {
    const startedAtMs = this.deps.now()
    const log = createSessionLog(startedAtMs)
    this.log = log
    this.recording = true
    this.sampleCount = 0
    appendEvent(log, {
      epochMs: startedAtMs,
      elapsedS: 0,
      mode: this.mode,
      protocolName: logProtocolName(this.mode, this.protocolName),
      stepIndex: null,
      event: "session-start",
      detail: this.connected ? `recording started, ${this.deviceName} connected` : "recording started, not connected",
    })
    this.emit()
  }

  stopRecording(): void {
    this.recording = false
    this.sampleCount = this.log?.samples.length ?? 0
    this.emit()
  }

  /**
   * Discard the capture. A stopped-but-unexported log blocks Start recording
   * (the panel's `heldRecording`) rather than being silently discarded by it, so
   * this is the only way a capture is ever lost.
   */
  clearRecording(): void {
    this.log = null
    this.sampleCount = 0
    this.emit()
  }

  /**
   * The CSV and the filename for the export, or null when there is nothing to
   * export. The Blob and the download click stay in the panel - they are DOM.
   */
  csvForExport(): { csv: string; filename: string } | null {
    const log = this.log
    if (!log || log.samples.length === 0) return null
    return {
      csv: sessionLogToCsv(log),
      // "" for a manual session: sessionLogFilename slugs that to "session" rather
      // than stamping a protocol name onto a capture that never ran one.
      filename: sessionLogFilename(this.mode === "protocol" ? this.protocolName : "", log.startedAtMs),
    }
  }
}
