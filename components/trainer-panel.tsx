"use client"

/**
 * The Trainer tab: drive a Wahoo Kickr (or any FTMS trainer) from the bench -
 * ERG step protocols, manual target power, manual resistance - while recording
 * one CSV that lines up with the Python logger's own capture.
 *
 * This component owns ALL trainer state; app/page.tsx only mounts it. The four
 * leaf components below it are purely presentational and every byte-level or
 * timing decision lives in lib/ftms/ and lib/trainer/, so what is left here is
 * the wiring - and four decisions worth explaining:
 *
 * WHY ITS OWN CHOOSER. Chrome binds the set of reachable GATT services to the
 * grant made at requestDevice() time, so a device picked in the board chooser
 * can never be asked for FTMS afterwards - the grant trap that already shapes
 * connectReferencePowerMeter in page.tsx. The trainer therefore gets its own
 * requestDevice call, declaring every service it might ever read
 * (FTMS_OPTIONAL_SERVICES), with the same two-layer board guard: exclusionFilters
 * to keep our own boards out of the list a human sees, plus a post-pick name/id
 * check because Web Bluetooth filters are OR-ed and cannot express "this service
 * but not that name".
 *
 * WHY ITS OWN ERROR LINE. The page's `error` is set and cleared by unrelated
 * board flows (streaming, DFU, calibration), so a trainer failure shown there
 * would vanish the moment somebody touched the sensor connection. This panel
 * keeps its own.
 *
 * WHY WALL-CLOCK TICKS. The runner is pure and takes `nowMs`; a hidden tab has
 * its timers throttled or fully suspended, so one tick can arrive minutes late
 * having skipped several step boundaries. So the runner is driven from three
 * sources - a 250 ms interval, every Indoor Bike Data notification, and
 * `visibilitychange` - and reduceRunner walks every boundary since the last
 * tick. Of the (possibly several) step-started events one tick emits, only the
 * LAST is sent to the trainer: the earlier ones were never actually the current
 * target, they were passed through in one catch-up.
 *
 * WHY ONE CSV. The whole point of the log is a `merge_asof` against the Python
 * logger's `cw_time`, so samples and operator/protocol events share one file and
 * one `epoch_s` column - and a static-export page cannot fire two downloads from
 * one click anyway. See lib/trainer/session-log.ts.
 *
 * ONE DISCIPLINE TO KEEP: everything on the notification path (handleBikeData ->
 * tickRunner -> applyEvents -> sendControl -> logEvent) reads REFS, never state.
 * Those closures are captured once, at connect time, and a state variable read
 * there would be frozen at whatever it was when the trainer was connected.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { TrainerChart, type TrainerChartPoint } from "@/components/trainer-chart"
import { TrainerManualControls, type ManualSubMode } from "@/components/trainer-manual-controls"
import { TrainerReadouts } from "@/components/trainer-readouts"
import { TrainerStepEditor } from "@/components/trainer-step-editor"
import { BOARD_NAME_PREFIXES, isBoardName } from "@/lib/device-name"
import { FtmsControlError, openFtmsSession, type FtmsCapabilities, type FtmsSession } from "@/lib/ftms/control"
import type { IndoorBikeData } from "@/lib/ftms/indoor-bike-data"
import {
  DEFAULT_POWER_RANGE,
  DEFAULT_RESISTANCE_RANGE,
  FTMS_OPTIONAL_SERVICES,
  FTMS_RESULT,
  FTMS_SERVICE_UUID,
  clampToRange,
  type FtmsStatus,
  type SupportedRange,
} from "@/lib/ftms/protocol"
import { mmss } from "@/lib/trainer/format"
import { deletePreset, readPresets, savePreset, validateSteps, type TrainerPreset } from "@/lib/trainer/presets"
import {
  createRunner,
  protocolDurationSeconds,
  reduceRunner,
  runnerView,
  type ProtocolStep,
  type RunnerEvent,
  type RunnerState,
} from "@/lib/trainer/protocol-runner"
import {
  appendEvent,
  appendSample,
  createSessionLog,
  sessionLogFilename,
  sessionLogToCsv,
  type LogEventKind,
  type SessionLog,
  type TrainerMode,
} from "@/lib/trainer/session-log"

export interface TrainerPanelProps {
  /** bluetoothSupported && isSecureContext, from the page. */
  bluetoothAvailable: boolean
  /** The connected CycloWatt board, so the trainer chooser can reject it. */
  boardDeviceId: string | null
}

/** Display flush cadence: notifications arrive faster than a human reads. */
const DISPLAY_FLUSH_MS = 250
/** Runner tick cadence while running; see the module comment on the other two sources. */
const RUNNER_TICK_MS = 250
/** A slider drag or a held ±button fires far faster than the Control Point should. */
const MANUAL_DEBOUNCE_MS = 150
/** No notification for this long and every readout greys out. */
const STALE_MS = 3000
/** ~10 min of trace at 1 Hz; older points fall off the front. */
const CHART_MAX_POINTS = 600
/**
 * Where a finished or stopped protocol leaves the rider: an easy spin, not the
 * last interval's target. A trainer left in ERG at 400 W after the protocol ends
 * is a genuinely unpleasant surprise.
 */
const FINISH_TARGET_W = 50

interface LiveSample {
  powerW: number | null
  cadenceRpm: number | null
  speedKmh: number | null
  hrBpm: number | null
  receivedAtMs: number
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * A ref that always holds the newest value of a state variable, for the
 * notification-path closures - see the ONE DISCIPLINE note in the module
 * comment. Written in an effect, so it is never mutated during render.
 */
function useLatestRef<T>(value: T) {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  }, [value])
  return ref
}

/**
 * The runner's target, or null when there is no live one.
 *
 * runnerView reports the current step's watts for a finished or stopped
 * protocol too (it is still "where the protocol got to"), but as a TARGET that
 * would be a lie: nothing is being held any more.
 */
function protocolTargetW(state: RunnerState, nowMs: number): number | null {
  return state.status === "running" || state.status === "paused" ? runnerView(state, nowMs).targetWatts : null
}

/**
 * The 0-100 % slider onto the trainer's own resistance grid, in tenths.
 *
 * The published range is int16 but Set Target Resistance Level carries ONE
 * uint8, so 255 tenths is the real ceiling; mapping onto the clipped range means
 * the panel never hands the session a value it would have to reject.
 */
function resistanceTenthsFromPct(pct: number, range: SupportedRange): number {
  const max = Math.min(range.max, 0xff)
  const clipped: SupportedRange = { ...range, max }
  return clampToRange(range.min + (pct / 100) * (max - range.min), clipped)
}

export function TrainerPanel({ bluetoothAvailable, boardDeviceId }: TrainerPanelProps) {
  const [device, setDevice] = useState<BluetoothDevice | null>(null)
  const [deviceName, setDeviceName] = useState("")
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [capabilities, setCapabilities] = useState<FtmsCapabilities | null>(null)
  const [hasControl, setHasControl] = useState(false)
  const [error, setError] = useState("")

  const sessionRef = useRef<FtmsSession | null>(null)
  /**
   * The device the `gattserverdisconnected` listener is attached to.
   *
   * A BluetoothDevice outlives this component - the browser keeps it for the
   * life of the grant - so the unmount effect MUST detach the listener from it,
   * and a `[]`-dep effect cannot see the `device` state. Hence the mirror.
   */
  const deviceRef = useRef<BluetoothDevice | null>(null)
  /** Has Start or Resume (0x07) been sent since control was acquired? The Kickr honours ERG targets only after it. */
  const startedRef = useRef(false)
  const hasControlRef = useRef(false)

  const [mode, setMode] = useState<TrainerMode>("protocol")
  const [manualTargetW, setManualTargetW] = useState(100)
  const [manualResistancePct, setManualResistancePct] = useState(20)

  const [runner, setRunner] = useState<RunnerState>(() => createRunner({ name: "", steps: [] }))
  const runnerRef = useRef(runner)

  const [steps, setSteps] = useState<ProtocolStep[]>([{ targetWatts: 150, durationSeconds: 300 }])
  const [protocolName, setProtocolName] = useState("")
  const [presets, setPresets] = useState<TrainerPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)

  const logRef = useRef<SessionLog | null>(null)
  const [recording, setRecording] = useState(false)
  const [sampleCount, setSampleCount] = useState(0)

  const liveRef = useRef<LiveSample | null>(null)
  const [live, setLive] = useState<LiveSample | null>(null)
  const chartBufferRef = useRef<TrainerChartPoint[]>([])
  const [chartData, setChartData] = useState<TrainerChartPoint[]>([])
  const chartStartMsRef = useRef<number | null>(null)
  const [trainerReportedTargetW, setTrainerReportedTargetW] = useState<number | null>(null)

  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFlushRef = useRef(0)
  const manualTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Re-render clock, so `stale` and the elapsed labels move on their own. */
  const [nowTick, setNowTick] = useState(() => 0)

  const modeRef = useLatestRef(mode)
  const recordingRef = useLatestRef(recording)
  const protocolNameRef = useLatestRef(protocolName)
  const manualTargetWRef = useLatestRef(manualTargetW)
  const manualResistancePctRef = useLatestRef(manualResistancePct)

  /* ---------------------------------------------------------------- logging */

  function logProtocolName(): string {
    // Blank outside protocol mode: a manual session has no protocol, and a name
    // left over in those rows would look like one was running.
    return modeRef.current === "protocol" ? protocolNameRef.current : ""
  }

  function logStepIndex(): number | null {
    const state = runnerRef.current
    if (modeRef.current !== "protocol") return null
    return state.status === "running" || state.status === "paused" ? state.stepIndex : null
  }

  /**
   * Append one event row, if there is a log to append it to.
   *
   * Gated on the log EXISTING rather than on `recording`: a log outlives Stop
   * recording (until Clear or a new session), and a disconnect or a refused
   * control op after the samples stop is still worth a row in the file.
   */
  function logEvent(event: LogEventKind, detail: string, atMs: number = Date.now()): void {
    const log = logRef.current
    if (!log) return
    appendEvent(log, {
      epochMs: atMs,
      elapsedS: (atMs - log.startedAtMs) / 1000,
      mode: modeRef.current,
      protocolName: logProtocolName(),
      stepIndex: logStepIndex(),
      event,
      detail,
    })
  }

  /* ------------------------------------------------------- control-point ops */

  function markControl(value: boolean): void {
    hasControlRef.current = value
    setHasControl(value)
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
   * @returns true when the trainer acknowledged (first try or retry).
   */
  async function sendControl(label: string, run: () => Promise<void>): Promise<boolean> {
    const session = sessionRef.current
    if (!session) return false
    try {
      await run()
      logEvent("control-result", `${label} -> success`)
      return true
    } catch (err) {
      if (err instanceof FtmsControlError && err.resultCode === FTMS_RESULT.CONTROL_NOT_PERMITTED) {
        try {
          await session.requestControl()
          markControl(true)
          await run()
          logEvent("control-result", `${label} -> success after re-taking control`)
          return true
        } catch (retryErr) {
          markControl(false)
          logEvent("control-result", `${label} -> failed after re-taking control: ${errorText(retryErr)}`)
          setError(`${label} failed: ${errorText(retryErr)}`)
          return false
        }
      }
      logEvent("control-result", `${label} -> failed: ${errorText(err)}`)
      setError(`${label} failed: ${errorText(err)}`)
      return false
    }
  }

  /** Control taken and 0x07 sent - the two preconditions for any target to be honoured. */
  async function ensureStarted(): Promise<boolean> {
    const session = sessionRef.current
    if (!session) return false
    if (!hasControlRef.current) {
      if (!(await sendControl("Request Control", () => session.requestControl()))) return false
      markControl(true)
    }
    if (!startedRef.current) {
      if (!(await sendControl("Start or Resume", () => session.start()))) return false
      startedRef.current = true
    }
    return true
  }

  async function takeControl(): Promise<void> {
    const session = sessionRef.current
    if (!session) return
    setError("")
    if (await sendControl("Request Control", () => session.requestControl())) markControl(true)
  }

  /* -------------------------------------------------------- runner plumbing */

  function commitRunner(state: RunnerState): void {
    runnerRef.current = state
    setRunner(state)
  }

  /**
   * Log every runner event, and (unless `send` is false) put the trainer where
   * the runner now says it should be.
   *
   * `send: false` is for the two cases where the runner moves BECAUSE the link
   * is gone - a disconnect or a revoked control - and a write would only queue
   * up behind a dead Control Point.
   */
  function applyEvents(events: RunnerEvent[], nowMs: number, options: { send?: boolean } = {}): void {
    for (const event of events) {
      switch (event.type) {
        case "step-started":
          logEvent("step-started", `step ${event.stepIndex + 1} target ${event.targetWatts} W`, nowMs)
          break
        case "resumed":
          logEvent("resumed", `target ${event.targetWatts} W`, nowMs)
          break
        case "paused":
          logEvent("paused", "", nowMs)
          break
        case "stopped":
          logEvent("stopped", "", nowMs)
          break
        case "finished":
          logEvent("finished", "", nowMs)
          break
      }
    }

    const session = sessionRef.current
    if (options.send === false || !session) return

    const finishing = events.some((event) => event.type === "finished" || event.type === "stopped")
    if (finishing) {
      /*
       * Not the last step's target: see FINISH_TARGET_W. Sent even from a paused
       * runner (Stop while paused), unlike the step targets below: the trainer
       * acknowledges it either way, and it is what puts the machine at an easy
       * spin the moment the following Stop releases it. Nothing later would
       * re-send it, which is exactly why the step-target guard cannot apply here.
       */
      const watts = clampToRange(FINISH_TARGET_W, session.capabilities.powerRange)
      void sendControl(`Set Target Power ${watts} W (protocol end)`, () => session.setTargetPower(watts))
      if (events.some((event) => event.type === "stopped")) {
        void sendControl("Stop", () => session.stop())
        // 0x08 puts the trainer back in the state where it honours no ERG target,
        // so the next run has to send 0x07 again - see ensureStarted.
        startedRef.current = false
      }
    } else if (runnerRef.current.status !== "paused") {
      /*
       * Only the LAST target of the batch - see WHY WALL-CLOCK TICKS.
       *
       * And nothing at all while the runner is paused, which is Skip-while-paused:
       * the panel has already sent 0x08, so the trainer holds no target and would
       * ACKNOWLEDGE the write while ignoring it - logging a "-> success" for a
       * target that never took effect, the single most misleading line a session
       * log can carry. Resume re-sends the current step's target anyway, and by
       * the time a `resumed` event reaches here commitRunner has already moved the
       * status to "running", so this guard never blocks that.
       */
      let target: number | null = null
      for (const event of events) {
        if (event.type === "step-started" || event.type === "resumed") target = event.targetWatts
      }
      if (target !== null) {
        const watts = target
        void sendControl(`Set Target Power ${watts} W`, () => session.setTargetPower(watts))
      }
    }

    if (events.some((event) => event.type === "paused")) {
      void sendControl("Pause", () => session.pause())
      startedRef.current = false // as for Stop above: Resume must re-send 0x07.
    }
  }

  function tickRunner(nowMs: number): void {
    const previous = runnerRef.current
    const { state, events } = reduceRunner(previous, { type: "tick" }, nowMs)
    // reduceRunner hands back the SAME reference for a no-op, which is most
    // ticks - so this is the check that keeps a 4 Hz interval from re-rendering.
    if (state === previous) return
    commitRunner(state)
    applyEvents(events, nowMs)
  }

  /* ------------------------------------------------------ display throttling */

  function flushDisplay(): void {
    lastFlushRef.current = Date.now()
    setLive(liveRef.current)
    // A NEW array every flush: TrainerChart is memo'd and compares identity.
    setChartData([...chartBufferRef.current])
    setSampleCount(logRef.current?.samples.length ?? 0)
    setNowTick(Date.now())
  }

  /** Leading + trailing throttle, as page.tsx's queueSerialDisplayUpdate: immediate when
   * the display is stale, else one deferred flush so a burst's final value is never lost. */
  function queueDisplayUpdate(): void {
    if (Date.now() - lastFlushRef.current >= DISPLAY_FLUSH_MS) {
      flushDisplay()
    } else if (flushTimerRef.current === null) {
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null
        flushDisplay()
      }, DISPLAY_FLUSH_MS)
    }
  }

  /* -------------------------------------------------------- session handlers */

  const handleBikeData = useCallback((data: IndoorBikeData, nowMs: number) => {
    liveRef.current = {
      powerW: data.powerW,
      cadenceRpm: data.cadenceRpm,
      speedKmh: data.speedKmh,
      hrBpm: data.heartRateBpm,
      receivedAtMs: nowMs,
    }

    if (chartStartMsRef.current === null) chartStartMsRef.current = nowMs
    const currentMode = modeRef.current
    const targetW =
      currentMode === "protocol"
        ? protocolTargetW(runnerRef.current, nowMs)
        : currentMode === "manual-power"
          ? manualTargetWRef.current
          : null

    const buffer = chartBufferRef.current
    buffer.push({
      t: (nowMs - chartStartMsRef.current) / 1000,
      power: data.powerW,
      target: targetW,
      cadence: data.cadenceRpm,
    })
    if (buffer.length > CHART_MAX_POINTS) buffer.splice(0, buffer.length - CHART_MAX_POINTS)

    const log = logRef.current
    if (recordingRef.current && log) {
      appendSample(log, {
        epochMs: nowMs,
        elapsedS: (nowMs - log.startedAtMs) / 1000,
        mode: currentMode,
        protocolName: logProtocolName(),
        stepIndex: logStepIndex(),
        stepTargetW: targetW,
        targetResistancePct: currentMode === "manual-resistance" ? manualResistancePctRef.current : null,
        powerW: data.powerW,
        cadenceRpm: data.cadenceRpm,
        speedKmh: data.speedKmh,
        hrBpm: data.heartRateBpm,
      })
      // sampleCount is refreshed from the log on the throttled flush, not here:
      // one setState per notification is exactly what the throttle exists to avoid.
    }

    tickRunner(nowMs)
    queueDisplayUpdate()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads refs only; see the module comment.
  }, [])

  const handleStatus = useCallback((status: FtmsStatus) => {
    logEvent("status", JSON.stringify(status))
    if (status.kind === "targetPowerChanged") setTrainerReportedTargetW(status.watts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleControlLost = useCallback(() => {
    markControl(false)
    startedRef.current = false
    logEvent("control-lost", "the trainer revoked control")
    const nowMs = Date.now()
    if (runnerRef.current.status === "running") {
      const { state, events } = reduceRunner(runnerRef.current, { type: "pause" }, nowMs)
      commitRunner(state)
      applyEvents(events, nowMs, { send: false })
    }
    setError("The trainer revoked control (another app took it). Press Take Control to continue.")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleDisconnected(): void {
    void sessionRef.current?.dispose()
    sessionRef.current = null
    setConnected(false)
    markControl(false)
    startedRef.current = false

    const nowMs = Date.now()
    if (runnerRef.current.status === "running") {
      // Pause rather than stop: the protocol is recoverable, and no BLE write can
      // land on a link that just went away.
      const { state, events } = reduceRunner(runnerRef.current, { type: "pause" }, nowMs)
      commitRunner(state)
      applyEvents(events, nowMs, { send: false })
    }
    logEvent("disconnected", "link lost", nowMs)
    // `device`, the log and the chart are all kept, so Reconnect and Export still work.
  }

  /*
   * One stable listener for the whole component's life - add/removeEventListener
   * must see the same reference - delegating to the latest closure through a ref.
   */
  const disconnectHandlerRef = useLatestRef(handleDisconnected)
  const onGattDisconnected = useCallback(() => disconnectHandlerRef.current(), [disconnectHandlerRef])

  /* ------------------------------------------------------ connect / reconnect */

  async function openSession(target: BluetoothDevice): Promise<void> {
    const session = await openFtmsSession(target, {
      onBikeData: handleBikeData,
      onStatus: handleStatus,
      onControlLost: handleControlLost,
    })
    sessionRef.current = session
    setCapabilities(session.capabilities)
    setDevice(target)
    setDeviceName(target.name || "Trainer")
    setConnected(true)
    startedRef.current = false
    markControl(false)
    setTrainerReportedTargetW(null)

    // Remove first: a reconnect on the same device would otherwise stack a second
    // listener, and every later drop would run the handler twice.
    target.removeEventListener("gattserverdisconnected", onGattDisconnected)
    target.addEventListener("gattserverdisconnected", onGattDisconnected)
    deviceRef.current = target
    logEvent("connected", target.name || "Trainer")

    if (await sendControl("Request Control", () => session.requestControl())) markControl(true)
  }

  async function connectTrainer(): Promise<void> {
    const ble = navigator.bluetooth
    if (!ble) {
      setError("Web Bluetooth API is not supported in this browser.")
      return
    }

    setConnecting(true)
    setError("")
    try {
      const requestOptions: RequestDeviceOptions = {
        filters: [{ services: [FTMS_SERVICE_UUID] }],
        optionalServices: [...FTMS_OPTIONAL_SERVICES],
      }
      // .catch, not try/catch, so the whole flow below has one const binding
      // whichever chooser produced it (as connectReferencePowerMeter does).
      const candidate = await ble
        .requestDevice({
          ...requestOptions,
          exclusionFilters: BOARD_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
        } as RequestDeviceOptions)
        .catch((err: unknown) => {
          // A cancelled chooser is a DOMException and must keep propagating. Only
          // an engine that does not understand exclusionFilters throws TypeError,
          // and it gets a second, plain chooser rather than a dead button.
          if (!(err instanceof TypeError)) throw err
          console.warn("exclusionFilters unsupported here; relying on the post-pick check")
          return ble.requestDevice(requestOptions)
        })

      // Reject before connecting, so no trainer state is ever touched by one of
      // ours. The id check catches the same board under a name the prefix list
      // does not know.
      if (isBoardName(candidate.name) || (candidate.id && candidate.id === boardDeviceId)) {
        setError(
          `${candidate.name || "That device"} is a CycloWatt board, not a trainer. ` +
            "Pick the Kickr (or another FTMS trainer) here - a CycloWatt board connects " +
            "with the sensor connection on the Data Streaming tab.",
        )
        console.warn("Rejected a CycloWatt board picked as the trainer")
        return
      }

      await openSession(candidate)
    } catch (err) {
      console.error("Trainer connection failed:", err)
      setError(`Trainer connection failed: ${errorText(err)}`)
    } finally {
      setConnecting(false)
    }
  }

  /** Re-open on the device we already have a grant for - no chooser, so no new grant. */
  async function reconnectTrainer(): Promise<void> {
    if (!device) return
    setConnecting(true)
    setError("")
    try {
      await openSession(device)
      const session = sessionRef.current
      if (!session) return
      // Put the trainer back where the panel thinks it is: a re-opened link has
      // forgotten every target, and 0x07 has to precede them all (ensureStarted).
      const state = runnerRef.current
      const target = mode === "protocol" ? protocolTargetW(state, Date.now()) : null
      if (target !== null) {
        if (!(await ensureStarted())) return
        const watts = target
        if (await sendControl(`Set Target Power ${watts} W`, () => session.setTargetPower(watts))) {
          logEvent("target-set", `${watts} W (re-sent after reconnect)`)
        }
      } else if (mode === "manual-power") {
        await sendManualPower(manualTargetW)
      } else if (mode === "manual-resistance") {
        await sendManualResistance(manualResistancePct)
      }
    } catch (err) {
      console.error("Trainer reconnect failed:", err)
      setError(`Trainer reconnect failed: ${errorText(err)}`)
    } finally {
      setConnecting(false)
    }
  }

  async function disconnectTrainer(): Promise<void> {
    const target = device ?? deviceRef.current
    target?.removeEventListener("gattserverdisconnected", onGattDisconnected)
    deviceRef.current = null
    await sessionRef.current?.dispose()
    sessionRef.current = null
    try {
      if (target?.gatt?.connected) target.gatt.disconnect()
    } catch (err) {
      console.warn("Trainer disconnect: gatt.disconnect() failed", err)
    }

    const nowMs = Date.now()
    // Exactly as handleDisconnected does, and for the same reason: a runner left
    // running with no session keeps ticking step boundaries and logging
    // step-started rows for targets nothing can receive. No BLE sends - the
    // session is already disposed.
    if (runnerRef.current.status === "running") {
      const { state, events } = reduceRunner(runnerRef.current, { type: "pause" }, nowMs)
      commitRunner(state)
      applyEvents(events, nowMs, { send: false })
    }

    logEvent("disconnected", "disconnected by the operator", nowMs)
    setConnected(false)
    markControl(false)
    startedRef.current = false
    setDevice(null)
    setDeviceName("")
    setCapabilities(null)
    setTrainerReportedTargetW(null)
  }

  /* ----------------------------------------------------------------- manual */

  async function sendManualPower(watts: number): Promise<void> {
    const session = sessionRef.current
    if (!session) return
    if (!(await ensureStarted())) return
    if (await sendControl(`Set Target Power ${watts} W`, () => session.setTargetPower(watts))) {
      logEvent("target-set", `${watts} W (manual)`)
    }
  }

  async function sendManualResistance(pct: number): Promise<void> {
    const session = sessionRef.current
    if (!session) return
    if (!(await ensureStarted())) return
    const tenths = resistanceTenthsFromPct(pct, session.capabilities.resistanceRange)
    if (await sendControl(`Set Target Resistance ${tenths / 10}`, () => session.setTargetResistance(tenths))) {
      logEvent("target-set", `${pct} % -> ${tenths / 10} resistance level (manual)`)
    }
  }

  /**
   * Coalesce a burst of manual edits into one write.
   *
   * A slider drag or a held ±button produces edits far faster than a 5 s-timeout
   * Control Point queue should be fed; both sub-modes share the timer because
   * only one manual target is ever live on the trainer.
   */
  function queueManualSend(run: () => Promise<void>): void {
    if (manualTimerRef.current !== null) clearTimeout(manualTimerRef.current)
    manualTimerRef.current = setTimeout(() => {
      manualTimerRef.current = null
      void run()
    }, MANUAL_DEBOUNCE_MS)
  }

  function handleManualTargetW(watts: number): void {
    setManualTargetW(watts)
    if (connected && mode === "manual-power") queueManualSend(() => sendManualPower(watts))
  }

  function handleManualResistancePct(pct: number): void {
    setManualResistancePct(pct)
    if (connected && mode === "manual-resistance") queueManualSend(() => sendManualResistance(pct))
  }

  function handleSubModeChange(subMode: ManualSubMode): void {
    setMode(subMode === "power" ? "manual-power" : "manual-resistance")
  }

  /* --------------------------------------------------------- run  controls */

  async function startProtocol(): Promise<void> {
    const problem = validateSteps(steps)
    if (problem !== null) {
      setError(`Cannot start the protocol: ${problem}.`)
      return
    }
    setError("")
    const fresh = createRunner({ name: protocolName.trim() || "Protocol", steps })
    commitRunner(fresh)
    if (!(await ensureStarted())) return
    const nowMs = Date.now()
    const { state, events } = reduceRunner(fresh, { type: "start" }, nowMs)
    commitRunner(state)
    applyEvents(events, nowMs)
  }

  function dispatchRunner(action: "pause" | "resume" | "skip" | "stop"): void {
    const nowMs = Date.now()
    const { state, events } = reduceRunner(runnerRef.current, { type: action }, nowMs)
    if (state === runnerRef.current) return
    commitRunner(state)
    applyEvents(events, nowMs)
  }

  async function resumeProtocol(): Promise<void> {
    // 0x07 again first: a pause sent 0x08, and the trainer applies no ERG target
    // until it has been started once more.
    if (!(await ensureStarted())) return
    dispatchRunner("resume")
  }

  /* -------------------------------------------------------------- recording */

  function startRecording(): void {
    const startedAtMs = Date.now()
    logRef.current = createSessionLog(startedAtMs)
    setRecording(true)
    recordingRef.current = true
    setSampleCount(0)
    appendEvent(logRef.current, {
      epochMs: startedAtMs,
      elapsedS: 0,
      mode,
      protocolName: mode === "protocol" ? protocolName : "",
      stepIndex: null,
      event: "session-start",
      detail: connected ? `recording started, ${deviceName} connected` : "recording started, not connected",
    })
  }

  function stopRecording(): void {
    setRecording(false)
    recordingRef.current = false
    setSampleCount(logRef.current?.samples.length ?? 0)
  }

  function clearRecording(): void {
    logRef.current = null
    setSampleCount(0)
  }

  /** The Blob dance from page.tsx's exportToCSV; one file, samples and events together. */
  function exportCsv(): void {
    const log = logRef.current
    if (!log || log.samples.length === 0) return
    const blob = new Blob([sessionLogToCsv(log)], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    // "" for a manual session: sessionLogFilename slugs that to "session" rather
    // than stamping a protocol name onto a capture that never ran one.
    a.download = sessionLogFilename(mode === "protocol" ? protocolName : "", log.startedAtMs)
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  /* ---------------------------------------------------------------- presets */

  // In an effect, never during render: readPresets touches localStorage and this
  // page is prerendered in node by the static export.
  useEffect(() => {
    setPresets(readPresets())
  }, [])

  function loadPreset(id: string): void {
    const preset = presets.find((candidate) => candidate.id === id)
    if (!preset) return
    setSelectedPresetId(id)
    setProtocolName(preset.name)
    setSteps(preset.steps.map((step) => ({ ...step })))
  }

  function savePresetFromEditor(): void {
    const name = protocolName.trim()
    // No id: savePreset matches on the trimmed name, and handing it a built-in's
    // id would mint a user preset wearing that id.
    const next = savePreset({ name: protocolName, steps })
    setPresets(next)

    /*
     * savePreset REFUSES silently - it returns the list unchanged and touches the
     * store not at all - for a name that collides with a built-in or for invalid
     * steps. An operator who pressed Save and saw nothing happen cannot tell that
     * from a save that worked, so the refusal is detected here (no user preset
     * under that name came back) and said out loud. The selection is left alone:
     * nothing changed, so nothing should look as though it had.
     */
    const saved = next.find((preset) => preset.name === name && !preset.builtIn)
    if (!saved) {
      const problem = next.some((preset) => preset.name === name && preset.builtIn)
        ? `"${name}" is a built-in preset's name - choose another`
        : (validateSteps(steps) ?? "give the protocol a name first")
      setError(`Preset not saved: ${problem}.`)
      return
    }

    setError("")
    setSelectedPresetId(saved.id)
  }

  function removePreset(id: string): void {
    setPresets(deletePreset(id))
    if (selectedPresetId === id) setSelectedPresetId(null)
  }

  /* ----------------------------------------------------------------- timers */

  useEffect(() => {
    if (runner.status !== "running") return
    const interval = setInterval(() => tickRunner(Date.now()), RUNNER_TICK_MS)
    // A hidden tab's interval is throttled or suspended; this catches the runner
    // up the instant the tab is looked at again.
    const onVisibilityChange = () => tickRunner(Date.now())
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tickRunner reads refs only.
  }, [runner.status])

  /*
   * Drives `stale` and the elapsed labels. Gated on there being a reading to
   * grey rather than on `connected`: a LINK LOSS is exactly the case where the
   * last power and cadence must stop looking live, and an interval that stopped
   * with the connection would freeze `stale` at false forever.
   */
  const hasReading = live !== null
  useEffect(() => {
    if (!connected && !hasReading) return
    const interval = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(interval)
    // Deliberately the BOOLEAN, not `live`: `live` is a fresh object on every
    // flush, and depending on it would tear the interval down and rebuild it
    // four times a second - so it would never actually reach one second.
  }, [connected, hasReading])

  useEffect(
    () => () => {
      // Through deviceRef, not the `device` state: this closure is created once,
      // so it would otherwise always see `null` and leave the listener attached
      // to a BluetoothDevice that outlives the component - firing into a dead
      // panel on every later drop.
      deviceRef.current?.removeEventListener("gattserverdisconnected", onGattDisconnected)
      deviceRef.current = null
      void sessionRef.current?.dispose()
      sessionRef.current = null
      if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current)
      if (manualTimerRef.current !== null) clearTimeout(manualTimerRef.current)
    },
    [onGattDisconnected],
  )

  /* ------------------------------------------------------------------ render */

  const powerRange = capabilities?.powerRange ?? DEFAULT_POWER_RANGE
  const resistanceRange = capabilities?.resistanceRange ?? DEFAULT_RESISTANCE_RANGE
  const features = capabilities?.features ?? null
  /*
   * null features means UNKNOWN, not unsupported (see lib/ftms/control.ts): a
   * trainer that would not answer the Feature read still takes ERG targets. Only
   * an explicit false greys anything out.
   */
  const ergUnsupported = features !== null && !features.powerTargetSupported
  const resistanceUnsupported = features !== null && !features.resistanceTargetSupported

  const protocolActive = runner.status === "running" || runner.status === "paused"
  const view = runnerView(runner, nowTick || Date.now())
  const stale = live !== null && nowTick - live.receivedAtMs > STALE_MS
  const liveTargetW = mode === "protocol" ? protocolTargetW(runner, nowTick || Date.now()) : mode === "manual-power" ? manualTargetW : null

  const targetLabel =
    mode === "manual-resistance" ? `${manualResistancePct} %` : liveTargetW === null ? "–" : `${liveTargetW} W`
  const stepLabel =
    mode === "protocol"
      ? runner.status === "idle"
        ? "–"
        : `Step ${view.stepIndex + 1} / ${view.stepCount}`
      : "Manual"
  const elapsedLabel =
    mode === "protocol" && runner.status !== "idle"
      ? `${mmss(view.totalElapsedS)} / ${mmss(protocolDurationSeconds(runner.protocol))}`
      : recording && logRef.current
        ? `${mmss(((nowTick || Date.now()) - logRef.current.startedAtMs) / 1000)} recorded`
        : "–"

  return (
    <>
      {error && (
        <Alert variant="destructive" className="bg-red-50 border-red-200 text-red-800">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card className="bg-white border-gray-200">
        <CardHeader>
          <CardTitle>Trainer connection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {!device && (
              <Button onClick={connectTrainer} disabled={!bluetoothAvailable || connecting}>
                {connecting ? "Connecting…" : "Connect trainer"}
              </Button>
            )}
            {device && !connected && (
              <Button onClick={reconnectTrainer} disabled={!bluetoothAvailable || connecting}>
                {connecting ? "Reconnecting…" : "Reconnect"}
              </Button>
            )}
            {device && (
              <Button variant="outline" onClick={disconnectTrainer} disabled={connecting}>
                Disconnect
              </Button>
            )}
            {connected && !hasControl && (
              <Button variant="outline" onClick={takeControl}>
                Take Control
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-gray-900">{deviceName || "No trainer"}</span>
            <Badge variant={connected ? "default" : "secondary"}>{connected ? "Connected" : "Disconnected"}</Badge>
            <Badge variant={hasControl ? "default" : "secondary"}>{hasControl ? "Control" : "No control"}</Badge>
            <Badge variant={ergUnsupported ? "destructive" : "secondary"}>
              {features === null ? "ERG: unknown" : ergUnsupported ? "ERG unsupported" : "ERG supported"}
            </Badge>
            <Badge variant={resistanceUnsupported ? "destructive" : "secondary"}>
              {features === null
                ? "Resistance: unknown"
                : resistanceUnsupported
                  ? "Resistance unsupported"
                  : "Resistance supported"}
            </Badge>
            {capabilities && (
              <span className="text-gray-500">
                power {powerRange.min}–{powerRange.max} W (step {powerRange.increment} W), resistance{" "}
                {resistanceRange.min / 10}–{Math.min(resistanceRange.max, 0xff) / 10}
              </span>
            )}
          </div>

          {!bluetoothAvailable && (
            <p className="text-xs text-gray-500">
              Web Bluetooth needs a supporting browser (Chrome or Edge) over HTTPS or localhost.
            </p>
          )}
          {features === null && connected && (
            <p className="text-xs text-gray-500">
              This trainer did not publish its Fitness Machine Feature characteristic, so ERG and resistance
              support are unknown — both are offered, and the trainer will refuse what it cannot do.
            </p>
          )}
        </CardContent>
      </Card>

      <TrainerReadouts
        powerW={live?.powerW ?? null}
        cadenceRpm={live?.cadenceRpm ?? null}
        targetLabel={targetLabel}
        stepLabel={stepLabel}
        elapsedLabel={elapsedLabel}
        stale={stale}
        trainerReportedTargetW={trainerReportedTargetW}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={mode === "protocol" ? "default" : "outline"}
          disabled={protocolActive || ergUnsupported}
          onClick={() => setMode("protocol")}
        >
          Protocol
        </Button>
        <Button
          size="sm"
          variant={mode === "protocol" ? "outline" : "default"}
          disabled={protocolActive}
          onClick={() => setMode("manual-power")}
        >
          Manual
        </Button>
        {ergUnsupported && (
          <span className="text-xs text-amber-600">
            This trainer reports Set Target Power unsupported, so step protocols are unavailable.
          </span>
        )}
      </div>

      {mode === "protocol" ? (
        <>
          <TrainerStepEditor
            steps={steps}
            onStepsChange={setSteps}
            protocolName={protocolName}
            onNameChange={setProtocolName}
            presets={presets}
            selectedPresetId={selectedPresetId}
            onLoadPreset={loadPreset}
            onSavePreset={savePresetFromEditor}
            onDeletePreset={removePreset}
            powerRange={powerRange}
            disabled={protocolActive}
          />
          <Card className="bg-white border-gray-200">
            <CardHeader>
              <CardTitle>Run</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              <Button
                onClick={startProtocol}
                disabled={!connected || protocolActive || validateSteps(steps) !== null}
              >
                Start
              </Button>
              <Button variant="outline" onClick={() => dispatchRunner("pause")} disabled={runner.status !== "running"}>
                Pause
              </Button>
              <Button variant="outline" onClick={resumeProtocol} disabled={runner.status !== "paused"}>
                Resume
              </Button>
              <Button variant="outline" onClick={() => dispatchRunner("skip")} disabled={!protocolActive}>
                Skip step
              </Button>
              <Button variant="outline" onClick={() => dispatchRunner("stop")} disabled={!protocolActive}>
                Stop
              </Button>
              <span className="text-sm text-gray-500">
                {runner.status}
                {view.nextStep && runner.status === "running" && ` · next ${view.nextStep.targetWatts} W`}
              </span>
            </CardContent>
          </Card>
        </>
      ) : (
        <TrainerManualControls
          subMode={mode === "manual-resistance" ? "resistance" : "power"}
          onSubModeChange={handleSubModeChange}
          targetW={manualTargetW}
          onTargetW={handleManualTargetW}
          resistancePct={manualResistancePct}
          onResistancePct={handleManualResistancePct}
          powerRange={powerRange}
          disabled={!connected || (ergUnsupported && resistanceUnsupported)}
        />
      )}

      <TrainerChart data={chartData} />

      <Card className="bg-white border-gray-200">
        <CardHeader>
          <CardTitle>Recording</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Independent of the runner on purpose: a manual-power or resistance
              session is just as much a bench capture as a protocol run. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={startRecording} disabled={recording}>
              Start recording
            </Button>
            <Button variant="outline" onClick={stopRecording} disabled={!recording}>
              Stop recording
            </Button>
            <Button variant="outline" onClick={exportCsv} disabled={sampleCount === 0}>
              Export CSV
            </Button>
            <Button variant="outline" onClick={clearRecording} disabled={recording || logRef.current === null}>
              Clear
            </Button>
            <span className="text-sm text-gray-500 tabular-nums">
              {sampleCount} sample{sampleCount === 1 ? "" : "s"}
              {recording && " · recording"}
            </span>
          </div>
          <p className="text-xs text-gray-500">
            epoch_s is this PC&apos;s clock — run the Python logger on the same PC (or NTP-sync both) to correlate.
          </p>
        </CardContent>
      </Card>
    </>
  )
}
