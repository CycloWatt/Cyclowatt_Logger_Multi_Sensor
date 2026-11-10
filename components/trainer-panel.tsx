"use client"

/**
 * The Trainer tab: drive a Wahoo Kickr (or any FTMS trainer) from the bench -
 * ERG step protocols, manual target power, manual resistance - while recording
 * one CSV that lines up with the Python logger's capture (why one file: see
 * lib/trainer/session-log.ts).
 *
 * A COMPOSITION ROOT, not the trainer's logic. app/page.tsx mounts this alone;
 * it makes one useTrainerController() call and lays the snapshot out over the
 * leaf components (chart, readouts, manual controls, step editor) and the
 * three cards (connection, run, recording) below. Every orchestration decision
 * - chooser and board guard, connect/reconnect/disconnect, notification
 * handlers, the runner, manual debounce, recording, the session log - lives in
 * TrainerController (lib/trainer/controller.ts). The old panel's "ONE
 * DISCIPLINE" (a notification handler must read the newest value off a ref,
 * never a render closure) is now a property of that class, not a convention.
 *
 * What IS left: three effects, each tied to something only React's
 * mount/unmount lifecycle can own - presets (localStorage, loaded post-mount
 * since this page is prerendered in node), the runner tick (interval plus a
 * visibilitychange listener), and the staleness clock that ages `live`
 * readings; the Blob dance turning csvForExport()'s bytes into a download; and
 * this layout. Its own error line exists because the page's `error` is shared
 * with unrelated board flows (streaming, DFU, calibration) and would vanish on
 * an unrelated action - this panel keeps its own (`snapshot.error`).
 */

import { cadenceCue, selectGuidanceCadence } from "@/lib/trainer/cadence-guidance"
import { useEffect, useRef, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { TrainerStageAlert } from "@/components/trainer-stage-alert"
import { TrainerChart } from "@/components/trainer-chart"
import { TrainerConnectionCard } from "@/components/trainer-connection-card"
import { DEFAULT_TEST_FTP, presetsForFtp, validTestFtp } from "@/lib/trainer/validation-presets"
import { readBenchPrefs, writeBenchPrefs } from "@/lib/bench-prefs"
import { Input } from "@/components/ui/input"
import { TrainerManualControls } from "@/components/trainer-manual-controls"
import { TrainerReadouts } from "@/components/trainer-readouts"
import { TrainerRecordingCard } from "@/components/trainer-recording-card"
import { TrainerRunCard } from "@/components/trainer-run-card"
import { TrainerStepEditor } from "@/components/trainer-step-editor"
import { useTrainerController } from "@/hooks/use-trainer-controller"
import { DEFAULT_POWER_RANGE, DEFAULT_RESISTANCE_RANGE } from "@/lib/ftms/protocol"
import { elapsedLabel, isStale, stepLabel, targetLabel } from "@/lib/trainer/labels"
import { deletePreset, readPresets, savePreset, validateSteps, type TrainerPreset } from "@/lib/trainer/presets"
import { liveTargetW } from "@/lib/trainer/targets"
import { protocolDurationSeconds, runnerView, type ProtocolStep } from "@/lib/trainer/protocol-runner"
import { manualModeFor, subModeFor, type ManualSubMode } from "@/lib/trainer/mode"

export interface TrainerPanelProps {
  /** bluetoothSupported && isSecureContext, from the page. */
  bluetoothAvailable: boolean
  /** The connected CycloWatt board, so the trainer chooser can reject it. */
  getSrmCadence: () => number | null
  boardReady: boolean
  boardStreaming: boolean
  onPrepareStreaming: () => Promise<void>
  boardDeviceId: string | null
}

/** Runner tick cadence while running; see the module comment on the other two sources. */
const RUNNER_TICK_MS = 250

export function TrainerPanel({ bluetoothAvailable, boardDeviceId, boardReady, boardStreaming, onPrepareStreaming, getSrmCadence }: TrainerPanelProps) {
  /* The one collaborator that is not React, plus the mirror of its snapshot. */
  const { snapshot, controller } = useTrainerController({ boardDeviceId })
  const [cadenceGuidance, setCadenceGuidance] = useState(true)
  const combinedStartLock = useRef(false)
  const [preparingStream, setPreparingStream] = useState(false)
  const [streamStartError, setStreamStartError] = useState("")
  const startWithStreaming = async () => {
    if (combinedStartLock.current) return
    combinedStartLock.current = true
    setPreparingStream(true)
    setStreamStartError("")
    try {
      await onPrepareStreaming()
      if (!(await controller.startProtocol())) {
        setStreamStartError("Trainer protocol did not start. CycloWatt CSV capture remains enabled; check the trainer error, then retry or stop streaming in Data Streaming.")
      }
    } catch (error) {
      setStreamStartError(error instanceof Error ? error.message : "Could not start streaming.")
    } finally {
      combinedStartLock.current = false
      setPreparingStream(false)
    }
  }

  const {
    capabilities,
    chartData,
    connected,
    connecting,
    deviceName,
    error,
    eventCount,
    hasControl,
    hasDevice,
    hasLog,
    live,
    logStartedAtMs,
    manualResistancePct,
    manualTargetSent,
    manualTargetW,
    mode,
    nowTick,
    protocolName,
    recording,
    runner,
    sampleCount,
    starting,
    steps,
    trainerReportedTargetW,
  } = snapshot

  const [storedPresets, setPresets] = useState<TrainerPreset[]>([])
  const [testFtp, setTestFtp] = useState(DEFAULT_TEST_FTP)
  const [ftpInput, setFtpInput] = useState(String(DEFAULT_TEST_FTP))
  const presets = presetsForFtp(storedPresets, testFtp)
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)

  /* ---------------------------------------------------------------- export */

  /** The Blob dance from page.tsx's exportToCSV; one file, samples and events together. */
  function exportCsv(): void {
    const exported = controller.csvForExport()
    if (!exported) return
    const blob = new Blob([exported.csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = exported.filename
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
    const savedFtp = readBenchPrefs().testFtp
    if (typeof savedFtp === "number" && validTestFtp(savedFtp)) {
      setTestFtp(savedFtp)
      setFtpInput(String(savedFtp))
    }
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
    if (presets.some((preset) => preset.builtIn && preset.name === name)) {
      controller.setError("Choose a different name to save a custom copy of this built-in test.")
      return
    }
    const next = presetsForFtp(savePreset({ name: protocolName, steps }), testFtp)
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
    const interval = setInterval(() => controller.setNowTick(Date.now()), 1000)
    return () => clearInterval(interval)
    // Deliberately the BOOLEAN, not `live`: `live` is a fresh object on every
    // flush, and depending on it would tear the interval down and rebuild it
    // four times a second - so it would never actually reach one second.
  }, [controller, connected, hasReading])

  /* ------------------------------------------------------------------ render */

  const selectedManualGuide = presets.find((preset) => preset.id === selectedPresetId)?.manualGuide
  const activeInstruction = mode === "protocol" && runner.status === "running" ? runner.protocol.steps[runner.stepIndex]?.instruction : undefined
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
  const heldRecording = !recording && sampleCount + eventCount > 0
  const protocolActive = runner.status === "running" || runner.status === "paused"
  const ftpLocked = protocolActive || starting || preparingStream || recording || boardStreaming
  const requestedFtp = ftpInput.trim() === "" ? NaN : Number(ftpInput)
  const ftpValid = validTestFtp(requestedFtp)
  function applyTestFtp() {
    if (ftpLocked || !ftpValid) return
    const next = presetsForFtp(storedPresets, requestedFtp)
    const selected = next.find(preset => preset.id === selectedPresetId)
    setTestFtp(requestedFtp)
    writeBenchPrefs({ testFtp: requestedFtp })
    if (selected?.builtIn && selected.id.startsWith("validation-")) {
      controller.setProtocolName(selected.name)
      controller.setSteps(selected.steps.map(step => ({ ...step })))
    }
  }
  const view = runnerView(runner, nowTick || Date.now())
  const stale = isStale(live?.receivedAtMs ?? null, nowTick)
  const currentTargetW = liveTargetW({ mode, runner, nowMs: nowTick || Date.now(), manualTargetSent, manualTargetW })

  const cadenceTarget = mode === "protocol" && runner.status === "running"
    ? runner.protocol.steps[runner.stepIndex]?.targetCadenceRpm : undefined
  const srmCadence = getSrmCadence()
  const guidanceCadence = selectGuidanceCadence({ srm: srmCadence, trainer: live?.cadenceRpm ?? null, trainerStale: stale, connected })
  const cadenceMessage = cadenceCue(cadenceTarget, guidanceCadence)

  const targetLabelText = targetLabel({ mode, manualTargetSent, manualResistancePct, liveTargetW: currentTargetW })
  const stepLabelText = stepLabel({ mode, runnerStatus: runner.status, stepIndex: view.stepIndex, stepCount: view.stepCount })
  const elapsedLabelText = elapsedLabel({
    mode,
    runnerStatus: runner.status,
    totalElapsedS: view.totalElapsedS,
    protocolDurationS: protocolDurationSeconds(runner.protocol),
    recording,
    logStartedAtMs,
    nowMs: nowTick || Date.now(),
  })

  return (
    <>
      {error && (
        <Alert variant="destructive" className="bg-red-50 border-red-200 text-red-800">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium" htmlFor="test-rider-ftp">Rider FTP (W)
            <Input id="test-rider-ftp" aria-label="Rider FTP in watts" type="number" min="1" max="2000" step="1"
              className="mt-1 w-32" value={ftpInput} disabled={ftpLocked}
              onChange={(event) => setFtpInput(event.target.value)} />
          </label>
          <Button onClick={applyTestFtp} disabled={ftpLocked || !ftpValid || requestedFtp === testFtp}>Apply FTP to tests</Button>
          <span className="text-sm text-gray-600">Tests configured for {testFtp} W FTP</span>
        </div>
        <p className="mt-2 text-sm text-gray-600">Scales all core and extension watt targets, including T5 guides. Cadence and timings stay fixed. Applying reloads the selected built-in test; custom saved protocols keep their watts.</p>
        {ftpLocked && <p className="mt-1 text-sm text-amber-700">Stop the protocol, streaming and recording before changing riders.</p>}
        {!ftpValid && <p className="mt-1 text-sm text-red-700">Enter a whole-number FTP from 1 to 2000 W.</p>}
        <p className="mt-1 text-xs text-gray-500">Remembered in this browser. Export recordings between riders; applying FTP does not clear recorded data.</p>
      </div>

      <TrainerConnectionCard
        bluetoothAvailable={bluetoothAvailable}
        connecting={connecting}
        hasDevice={hasDevice}
        connected={connected}
        hasControl={hasControl}
        deviceName={deviceName}
        capabilities={capabilities}
        powerRange={powerRange}
        resistanceRange={resistanceRange}
        features={features}
        ergUnsupported={ergUnsupported}
        resistanceUnsupported={resistanceUnsupported}
        onConnect={() => void controller.connect()}
        onReconnect={() => void controller.reconnect()}
        onDisconnect={() => void controller.disconnect()}
        onTakeControl={() => void controller.takeControl()}
      />

      {mode === "protocol" && !selectedManualGuide && <TrainerStageAlert runner={runner} />}

      <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={cadenceGuidance} onChange={(e) => setCadenceGuidance(e.target.checked)} />
          Cadence guidance
        </label>
        {cadenceGuidance && <div className="mt-2" role="status">
          <div className="text-2xl font-semibold">{cadenceMessage}</div>
          {cadenceTarget !== undefined && <p className="text-sm mt-1">
            Target {cadenceTarget} rpm · Current {guidanceCadence === null ? "—" : Math.round(guidanceCadence)} rpm
            {guidanceCadence !== null && ` (${srmCadence !== null ? "SRM reference meter" : "trainer"})`} · Tolerance ±5 rpm
          </p>}
          <p className="text-xs text-gray-600 mt-1">Follow the cadence cue yourself; ERG controls power.</p>
        </div>}
      </div>

      {activeInstruction && <div role="status" className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-2xl font-semibold">{activeInstruction}</div>}
      {selectedManualGuide && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <h3 className="font-semibold">Manual test guide — {protocolName}</h3>
        <p className="text-sm mt-1">ERG protocol start is unavailable for this test. Start CycloWatt streaming with CSV capture enabled in Data Streaming. Select Manual → Resistance here, start trainer recording, and follow these stages using an external timer.</p>
        <ol className="list-decimal pl-6 mt-3 space-y-2 text-sm">{selectedManualGuide.map((instruction, i) => <li key={i}>{instruction}</li>)}</ol>
      </div>}

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
          disabled={protocolActive || starting || preparingStream || ergUnsupported}
          onClick={() => controller.changeMode("protocol")}
        >
          Protocol
        </Button>
        <Button
          size="sm"
          variant={mode === "protocol" ? "outline" : "default"}
          disabled={protocolActive || starting || preparingStream}
          onClick={() => controller.changeMode("manual-power")}
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
            disabled={protocolActive || starting || preparingStream}
          />
          {streamStartError && <Alert variant="destructive"><AlertDescription>{streamStartError}</AlertDescription></Alert>}
          {!selectedManualGuide && <TrainerRunCard
            connected={connected}
            protocolActive={protocolActive}
            starting={starting || preparingStream}
            steps={steps}
            runnerStatus={runner.status}
            nextStep={view.nextStep}
            onStart={() => void controller.startProtocol()}
            onStartWithStreaming={() => void startWithStreaming()}
            boardReady={boardReady}
            boardStreaming={boardStreaming}
            onPause={() => controller.dispatchRunner({ type: "pause" })}
            onResume={() => void controller.resumeProtocol()}
            onSkip={() => controller.dispatchRunner({ type: "skip" })}
            onStop={() => controller.dispatchRunner({ type: "stop" })}
          />}
        </>
      ) : (
        <TrainerManualControls
          subMode={subModeFor(mode)}
          onSubModeChange={(subMode: ManualSubMode) => controller.changeMode(manualModeFor(subMode))}
          targetW={manualTargetW}
          onTargetW={(watts: number) => controller.setManualTargetW(watts)}
          resistancePct={manualResistancePct}
          onResistancePct={(pct: number) => controller.setManualResistancePct(pct)}
          powerRange={powerRange}
          disabled={!connected || (ergUnsupported && resistanceUnsupported)}
        />
      )}

      <TrainerChart data={chartData} />

      <TrainerRecordingCard
        recording={recording}
        heldRecording={heldRecording}
        sampleCount={sampleCount}
        eventCount={eventCount}
        hasLog={hasLog}
        onStartRecording={() => controller.startRecording()}
        onStopRecording={() => controller.stopRecording()}
        onExport={exportCsv}
        onClear={() => controller.clearRecording()}
      />
    </>
  )
}
