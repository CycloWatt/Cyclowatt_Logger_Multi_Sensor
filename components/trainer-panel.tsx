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

import { useEffect, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { TrainerChart } from "@/components/trainer-chart"
import { TrainerConnectionCard } from "@/components/trainer-connection-card"
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
  boardDeviceId: string | null
}

/** Runner tick cadence while running; see the module comment on the other two sources. */
const RUNNER_TICK_MS = 250

export function TrainerPanel({ bluetoothAvailable, boardDeviceId }: TrainerPanelProps) {
  /* The one collaborator that is not React, plus the mirror of its snapshot. */
  const { snapshot, controller } = useTrainerController({ boardDeviceId })
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

  const [presets, setPresets] = useState<TrainerPreset[]>([])
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
    const interval = setInterval(() => controller.setNowTick(Date.now()), 1000)
    return () => clearInterval(interval)
    // Deliberately the BOOLEAN, not `live`: `live` is a fresh object on every
    // flush, and depending on it would tear the interval down and rebuild it
    // four times a second - so it would never actually reach one second.
  }, [controller, connected, hasReading])

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
  const heldRecording = !recording && sampleCount + eventCount > 0
  const protocolActive = runner.status === "running" || runner.status === "paused"
  const view = runnerView(runner, nowTick || Date.now())
  const stale = isStale(live?.receivedAtMs ?? null, nowTick)
  const currentTargetW = liveTargetW({ mode, runner, nowMs: nowTick || Date.now(), manualTargetSent, manualTargetW })

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
          onClick={() => controller.changeMode("protocol")}
        >
          Protocol
        </Button>
        <Button
          size="sm"
          variant={mode === "protocol" ? "outline" : "default"}
          disabled={protocolActive}
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
            disabled={protocolActive}
          />
          <TrainerRunCard
            connected={connected}
            protocolActive={protocolActive}
            starting={starting}
            steps={steps}
            runnerStatus={runner.status}
            nextStep={view.nextStep}
            onStart={() => void controller.startProtocol()}
            onPause={() => controller.dispatchRunner({ type: "pause" })}
            onResume={() => void controller.resumeProtocol()}
            onSkip={() => controller.dispatchRunner({ type: "skip" })}
            onStop={() => controller.dispatchRunner({ type: "stop" })}
          />
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
