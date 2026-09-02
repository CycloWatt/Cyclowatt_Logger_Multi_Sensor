"use client"

/**
 * The Trainer tab: drive a Wahoo Kickr (or any FTMS trainer) from the bench -
 * ERG step protocols, manual target power, manual resistance - while recording
 * one CSV that lines up with the Python logger's own capture.
 *
 * app/page.tsx only mounts this component. The four leaf components below it
 * are purely presentational, every byte-level or timing decision lives in
 * lib/ftms/ and lib/trainer/, and the ORCHESTRATION - what to send the trainer,
 * in what order, and what to write in the session log - lives in
 * TrainerController (lib/trainer/controller.ts), which this component mirrors
 * into one piece of state. So what is left here is the wiring - and four
 * decisions worth explaining:
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
 * controller.tick -> the plan interpreter -> sendControl -> logEvent) reads the
 * controller's live fields (through `controller.snapshot`, rebuilt on every
 * change) or a ref - never this render's state. Those closures are captured
 * once, at connect time, and a state variable read there would be frozen at
 * whatever it was when the trainer was connected.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { TrainerChart } from "@/components/trainer-chart"
import { TrainerManualControls } from "@/components/trainer-manual-controls"
import { TrainerReadouts } from "@/components/trainer-readouts"
import { TrainerStepEditor } from "@/components/trainer-step-editor"
import { BOARD_NAME_PREFIXES, isBoardName } from "@/lib/device-name"
import { openFtmsSession } from "@/lib/ftms/control"
import type { IndoorBikeData } from "@/lib/ftms/indoor-bike-data"
import {
  DEFAULT_POWER_RANGE,
  DEFAULT_RESISTANCE_RANGE,
  FTMS_OPTIONAL_SERVICES,
  FTMS_SERVICE_UUID,
  type FtmsStatus,
} from "@/lib/ftms/protocol"
import { appendChartPoint, type TrainerChartPoint } from "@/lib/trainer/chart-buffer"
import { TrainerController } from "@/lib/trainer/controller"
import { createThrottle } from "@/lib/trainer/display-throttle"
import { elapsedLabel, isStale, stepLabel, targetLabel } from "@/lib/trainer/labels"
import { logProtocolName, logStepIndex } from "@/lib/trainer/log-context"
import { deletePreset, readPresets, savePreset, validateSteps, type TrainerPreset } from "@/lib/trainer/presets"
import { liveTargetW, protocolTargetW } from "@/lib/trainer/targets"
import { protocolDurationSeconds, runnerView, type ProtocolStep } from "@/lib/trainer/protocol-runner"
import {
  appendEvent,
  appendSample,
  createSessionLog,
  sessionLogFilename,
  sessionLogToCsv,
  type TrainerMode,
} from "@/lib/trainer/session-log"
import { manualModeFor, subModeFor, type ManualSubMode } from "@/lib/trainer/mode"

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

export function TrainerPanel({ bluetoothAvailable, boardDeviceId }: TrainerPanelProps) {
  const boardDeviceIdRef = useLatestRef(boardDeviceId)
  /*
   * The one collaborator that is not React. Created lazily in a ref so its
   * injected closures are built exactly once and outlive every render; none of
   * them touches `navigator` until it is called, so the static export can still
   * prerender this page in node.
   */
  const controllerRef = useRef<TrainerController | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = new TrainerController({
      openSession: openFtmsSession,
      requestDevice: (options) => navigator.bluetooth.requestDevice(options),
      boardDeviceId: () => boardDeviceIdRef.current,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
      log: console,
    })
  }
  const controller = controllerRef.current

  /*
   * ONE state variable for everything the controller owns: it rebuilds a whole
   * snapshot object on every change, so a single setState is both the cheapest
   * and the most honest mirror of it. Subscribed in an effect - never during
   * render - and re-read once on subscribe, in case a change landed between
   * this render and the effect.
   */
  const [snapshot, setSnapshot] = useState(() => controller.snapshot)
  useEffect(() => {
    const unsubscribe = controller.subscribe(() => setSnapshot(controller.snapshot))
    setSnapshot(controller.snapshot)
    return unsubscribe
  }, [controller])
  const {
    capabilities,
    connected,
    deviceName,
    error,
    hasControl,
    manualTargetSent,
    mode,
    protocolName,
    runner,
    starting,
    steps,
  } = snapshot

  const [device, setDevice] = useState<BluetoothDevice | null>(null)
  const [connecting, setConnecting] = useState(false)

  /**
   * The device the `gattserverdisconnected` listener is attached to.
   *
   * A BluetoothDevice outlives this component - the browser keeps it for the
   * life of the grant - so the unmount effect MUST detach the listener from it,
   * and a `[]`-dep effect cannot see the `device` state. Hence the mirror.
   */
  const deviceRef = useRef<BluetoothDevice | null>(null)

  const [manualTargetW, setManualTargetW] = useState(100)
  const [manualResistancePct, setManualResistancePct] = useState(20)

  const [presets, setPresets] = useState<TrainerPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)

  const [recording, setRecording] = useState(false)
  const [sampleCount, setSampleCount] = useState(0)

  const liveRef = useRef<LiveSample | null>(null)
  const [live, setLive] = useState<LiveSample | null>(null)
  const chartBufferRef = useRef<TrainerChartPoint[]>([])
  const [chartData, setChartData] = useState<TrainerChartPoint[]>([])
  const chartStartMsRef = useRef<number | null>(null)
  const [trainerReportedTargetW, setTrainerReportedTargetW] = useState<number | null>(null)

  const manualTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Re-render clock, so `stale` and the elapsed labels move on their own. */
  const [nowTick, setNowTick] = useState(() => 0)

  const recordingRef = useLatestRef(recording)
  const manualTargetWRef = useLatestRef(manualTargetW)
  const manualResistancePctRef = useLatestRef(manualResistancePct)

  /* ------------------------------------------------------ display throttling */

  function flushDisplayBody(): void {
    setLive(liveRef.current)
    // A NEW array every flush: TrainerChart is memo'd and compares identity.
    setChartData([...chartBufferRef.current])
    setSampleCount(controller._task8Log?.samples.length ?? 0)
    setNowTick(Date.now())
  }

  /** Leading + trailing throttle, as page.tsx's queueSerialDisplayUpdate: immediate when
   * the display is stale, else one deferred flush so a burst's final value is never lost. */
  const throttleRef = useRef(
    createThrottle({
      intervalMs: DISPLAY_FLUSH_MS,
      now: Date.now,
      setTimer: setTimeout,
      clearTimer: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
      onFlush: flushDisplayBody,
    }),
  )

  function queueDisplayUpdate(): void {
    throttleRef.current.queue()
  }

  /* -------------------------------------------------------- session handlers */

  const handleBikeData = useCallback(
    (data: IndoorBikeData, nowMs: number) => {
      liveRef.current = {
        powerW: data.powerW,
        cadenceRpm: data.cadenceRpm,
        speedKmh: data.speedKmh,
        hrBpm: data.heartRateBpm,
        receivedAtMs: nowMs,
      }

      if (chartStartMsRef.current === null) chartStartMsRef.current = nowMs
      /*
       * The controller's OWN snapshot, not this render's: it is rebuilt on every
       * change, so reading it here reads the newest mode, runner and
       * manual-target flag - the ONE DISCIPLINE note, now a property of the
       * class. Read before the tick below, exactly as the refs were.
       */
      const current = controller.snapshot
      const currentMode = current.mode
      // manual-power only counts once its target has actually been written - see
      // manualTargetSent. Until then this row records no target, because there
      // isn't one this panel put on the wire.
      const targetW =
        currentMode === "protocol"
          ? protocolTargetW(current.runner, nowMs)
          : currentMode === "manual-power" && current.manualTargetSent === "power"
            ? manualTargetWRef.current
            : null

      appendChartPoint(chartBufferRef.current, {
        t: (nowMs - chartStartMsRef.current) / 1000,
        power: data.powerW,
        target: targetW,
        cadence: data.cadenceRpm,
      })

      const log = controller._task8Log
      if (recordingRef.current && log) {
        appendSample(log, {
          epochMs: nowMs,
          elapsedS: (nowMs - log.startedAtMs) / 1000,
          mode: currentMode,
          protocolName: logProtocolName(currentMode, current.protocolName),
          stepIndex: logStepIndex(currentMode, current.runner),
          stepTargetW: targetW,
          targetResistancePct:
            currentMode === "manual-resistance" && current.manualTargetSent === "resistance"
              ? manualResistancePctRef.current
              : null,
          powerW: data.powerW,
          cadenceRpm: data.cadenceRpm,
          speedKmh: data.speedKmh,
          hrBpm: data.heartRateBpm,
        })
        // sampleCount is refreshed from the log on the throttled flush, not here:
        // one setState per notification is exactly what the throttle exists to avoid.
      }

      controller.tick(nowMs)
      queueDisplayUpdate()
      // eslint-disable-next-line react-hooks/exhaustive-deps -- reads refs and the controller's live snapshot; see the module comment.
    },
    [controller],
  )

  const handleStatus = useCallback(
    (status: FtmsStatus) => {
      controller.logEvent("status", JSON.stringify(status))
      if (status.kind === "targetPowerChanged") setTrainerReportedTargetW(status.watts)
    },
    [controller],
  )

  const handleControlLost = useCallback(() => controller.onControlLost(), [controller])

  function handleDisconnected(): void {
    // Everything about the session and the flags that describe a live link is
    // the controller's; the pause is deliberately send-less (no BLE write can
    // land on a link that just went away) and the protocol is paused rather
    // than stopped, because it is recoverable.
    controller.detachSession()
    const nowMs = Date.now()
    controller.pauseWithoutSending(nowMs)
    controller.logEvent("disconnected", "link lost", nowMs)
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
    setDevice(target)
    setTrainerReportedTargetW(null)

    // Remove first: a reconnect on the same device would otherwise stack a second
    // listener, and every later drop would run the handler twice.
    target.removeEventListener("gattserverdisconnected", onGattDisconnected)
    target.addEventListener("gattserverdisconnected", onGattDisconnected)
    deviceRef.current = target

    /*
     * Everything else this function used to do - the session, the capabilities,
     * the deviceName, `connected`, the started/control/manual-target clears, the
     * one-line capability dump, the `connected` row and the opening Request
     * Control - is attachSession's, in that same order. The listener is wired
     * just ahead of it (rather than in the middle, where the console line used
     * to sit) so that it is already attached across the Request Control's round
     * trip; no log row and no write moves.
     */
    await controller.attachSession(session, target.name || "Trainer")
  }

  async function connectTrainer(): Promise<void> {
    const ble = navigator.bluetooth
    if (!ble) {
      controller.setError("Web Bluetooth API is not supported in this browser.")
      return
    }

    setConnecting(true)
    controller.setError("")
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
        controller.setError(
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
      controller.setError(`Trainer connection failed: ${errorText(err)}`)
    } finally {
      setConnecting(false)
    }
  }

  /** Re-open on the device we already have a grant for - no chooser, so no new grant. */
  async function reconnectTrainer(): Promise<void> {
    if (!device) return
    setConnecting(true)
    controller.setError("")
    try {
      await openSession(device)
      // Put the trainer back where the panel thinks it is: a re-opened link has
      // forgotten every target, and 0x07 has to precede them all (ensureStarted).
      // The two manual values are still this component's, hence the arguments.
      await controller.restoreTargetAfterReconnect(manualTargetW, manualResistancePct)
    } catch (err) {
      console.error("Trainer reconnect failed:", err)
      controller.setError(`Trainer reconnect failed: ${errorText(err)}`)
    } finally {
      setConnecting(false)
    }
  }

  async function disconnectTrainer(): Promise<void> {
    const target = device ?? deviceRef.current
    target?.removeEventListener("gattserverdisconnected", onGattDisconnected)
    deviceRef.current = null
    // Awaited, so the unsubscribe finishes before the link is dropped.
    await controller.disposeSession()
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
    controller.pauseWithoutSending(nowMs)

    controller.logEvent("disconnected", "disconnected by the operator", nowMs)
    // The row above is written while `connected` is still true, as it was when
    // these were separate setStates - hence the clearing afterwards.
    controller.clearConnection()
    setDevice(null)
    setTrainerReportedTargetW(null)
  }

  /* ----------------------------------------------------------------- manual */

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
    if (connected && mode === "manual-power") queueManualSend(() => controller.sendManualPower(watts))
  }

  function handleManualResistancePct(pct: number): void {
    setManualResistancePct(pct)
    if (connected && mode === "manual-resistance") queueManualSend(() => controller.sendManualResistance(pct))
  }

  function handleSubModeChange(subMode: ManualSubMode): void {
    changeMode(manualModeFor(subMode))
  }

  /**
   * Switch mode (or manual sub-mode) and put the TRAINER where the panel now
   * claims it is.
   *
   * A bare setMode was a lie waiting to be recorded: the readout and every
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
  function changeMode(next: TrainerMode): void {
    if (next === mode) return
    if (manualTimerRef.current !== null) {
      clearTimeout(manualTimerRef.current)
      manualTimerRef.current = null
    }
    controller.markManualTargetSent(null)
    // The controller's field is written straight away, so the very next
    // notification records the mode the operator just chose - what modeRef did.
    controller._task8SetMode(next)

    if (!connected) return // nothing to sync, and the null flag keeps the readout at "–"
    if (next === "manual-power") void controller.sendManualPower(manualTargetW)
    else if (next === "manual-resistance") void controller.sendManualResistance(manualResistancePct)
  }

  /* -------------------------------------------------------------- recording */

  function startRecording(): void {
    const startedAtMs = Date.now()
    const log = createSessionLog(startedAtMs)
    controller._task8Log = log
    setRecording(true)
    recordingRef.current = true
    setSampleCount(0)
    appendEvent(log, {
      epochMs: startedAtMs,
      elapsedS: 0,
      mode,
      protocolName: logProtocolName(mode, protocolName),
      stepIndex: null,
      event: "session-start",
      detail: connected ? `recording started, ${deviceName} connected` : "recording started, not connected",
    })
  }

  function stopRecording(): void {
    setRecording(false)
    recordingRef.current = false
    setSampleCount(controller._task8Log?.samples.length ?? 0)
  }

  function clearRecording(): void {
    controller._task8Log = null
    setSampleCount(0)
  }

  /** The Blob dance from page.tsx's exportToCSV; one file, samples and events together. */
  function exportCsv(): void {
    const log = controller._task8Log
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
    controller.setProtocolName(preset.name)
    controller.setSteps(preset.steps.map((step) => ({ ...step })))
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
      controller.setError(`Preset not saved: ${problem}.`)
      return
    }

    controller.setError("")
    setSelectedPresetId(saved.id)
  }

  function removePreset(id: string): void {
    setPresets(deletePreset(id))
    if (selectedPresetId === id) setSelectedPresetId(null)
  }

  /* ----------------------------------------------------------------- timers */

  useEffect(() => {
    if (runner.status !== "running") return
    const interval = setInterval(() => controller.tick(Date.now()), RUNNER_TICK_MS)
    // A hidden tab's interval is throttled or suspended; this catches the runner
    // up the instant the tab is looked at again.
    const onVisibilityChange = () => controller.tick(Date.now())
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [controller, runner.status])

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
      // The session is the controller's; Task 8 replaces this with
      // controller.dispose(), which also cancels the two timers below.
      void controller.disposeSession()
      throttleRef.current.cancel()
      if (manualTimerRef.current !== null) clearTimeout(manualTimerRef.current)
    },
    [controller, onGattDisconnected],
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

  /*
   * A stopped-but-unexported log blocks Start recording rather than being
   * silently discarded by it - a capture the operator has not saved is the one
   * thing on this panel that cannot be reproduced by pressing the button again.
   * The simpler of the two options offered: require Clear, and say why.
   */
  const heldRecording = !recording && sampleCount > 0
  const protocolActive = runner.status === "running" || runner.status === "paused"
  const view = runnerView(runner, nowTick || Date.now())
  const stale = isStale(live?.receivedAtMs ?? null, nowTick)
  /*
   * Both of these read "the target this panel has actually put on the wire", not
   * "the target the current mode would send" - see manualTargetSent. Protocol
   * mode needs no flag: protocolTargetW is already null until the runner runs.
   */
  const currentTargetW = liveTargetW({ mode, runner, nowMs: nowTick || Date.now(), manualTargetSent, manualTargetW })

  const targetLabelText = targetLabel({ mode, manualTargetSent, manualResistancePct, liveTargetW: currentTargetW })
  const stepLabelText = stepLabel({ mode, runnerStatus: runner.status, stepIndex: view.stepIndex, stepCount: view.stepCount })
  const elapsedLabelText = elapsedLabel({
    mode,
    runnerStatus: runner.status,
    totalElapsedS: view.totalElapsedS,
    protocolDurationS: protocolDurationSeconds(runner.protocol),
    recording,
    logStartedAtMs: controller._task8Log?.startedAtMs ?? null,
    nowMs: nowTick || Date.now(),
  })

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
              <Button variant="outline" onClick={() => void controller.takeControl()}>
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
        targetLabel={targetLabelText}
        stepLabel={stepLabelText}
        elapsedLabel={elapsedLabelText}
        stale={stale}
        trainerReportedTargetW={trainerReportedTargetW}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={mode === "protocol" ? "default" : "outline"}
          disabled={protocolActive || ergUnsupported}
          onClick={() => changeMode("protocol")}
        >
          Protocol
        </Button>
        <Button
          size="sm"
          variant={mode === "protocol" ? "outline" : "default"}
          disabled={protocolActive}
          onClick={() => changeMode("manual-power")}
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
            onStepsChange={(next: ProtocolStep[]) => controller.setSteps(next)}
            protocolName={protocolName}
            onNameChange={(next: string) => controller.setProtocolName(next)}
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
                onClick={() => void controller.startProtocol()}
                disabled={!connected || protocolActive || starting || validateSteps(steps) !== null}
              >
                {starting ? "Starting…" : "Start"}
              </Button>
              <Button
                variant="outline"
                onClick={() => controller.dispatchRunner({ type: "pause" })}
                disabled={runner.status !== "running"}
              >
                Pause
              </Button>
              <Button
                variant="outline"
                onClick={() => void controller.resumeProtocol()}
                disabled={runner.status !== "paused"}
              >
                Resume
              </Button>
              <Button
                variant="outline"
                onClick={() => controller.dispatchRunner({ type: "skip" })}
                disabled={!protocolActive}
              >
                Skip step
              </Button>
              <Button
                variant="outline"
                onClick={() => controller.dispatchRunner({ type: "stop" })}
                disabled={!protocolActive}
              >
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
          subMode={subModeFor(mode)}
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
            <Button onClick={startRecording} disabled={recording || heldRecording}>
              Start recording
            </Button>
            <Button variant="outline" onClick={stopRecording} disabled={!recording}>
              Stop recording
            </Button>
            <Button variant="outline" onClick={exportCsv} disabled={sampleCount === 0}>
              Export CSV
            </Button>
            <Button variant="outline" onClick={clearRecording} disabled={recording || controller._task8Log === null}>
              Clear
            </Button>
            <span className="text-sm text-gray-500 tabular-nums">
              {sampleCount} sample{sampleCount === 1 ? "" : "s"}
              {recording && " · recording"}
            </span>
          </div>
          {heldRecording && (
            <p className="text-xs text-amber-600">
              Clear the previous recording first — starting a new one would discard {sampleCount} unexported
              samples.
            </p>
          )}
          <p className="text-xs text-gray-500">
            epoch_s is this PC&apos;s clock — run the Python logger on the same PC (or NTP-sync both) to correlate.
          </p>
        </CardContent>
      </Card>
    </>
  )
}
