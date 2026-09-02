"use client"

/**
 * The Trainer tab: drive a Wahoo Kickr (or any FTMS trainer) from the bench -
 * ERG step protocols, manual target power, manual resistance - while recording
 * one CSV that lines up with the Python logger's own capture.
 *
 * app/page.tsx only mounts this component. The four leaf components below it
 * are purely presentational, every byte-level or timing decision lives in
 * lib/ftms/, and ALL the orchestration - the chooser and its board guard, the
 * connect/reconnect/disconnect flows, the notification handlers, the runner, the
 * manual debounce, recording, and what goes in the session log - lives in
 * TrainerController (lib/trainer/controller.ts), bound to React by the single
 * hook below (hooks/use-trainer-controller.ts - construction, the snapshot
 * mirror, teardown, and why each is shaped the way it is). What is left here is
 * the layout and three decisions worth explaining:
 *
 * WHY ITS OWN ERROR LINE. The page's `error` is set and cleared by unrelated
 * board flows (streaming, DFU, calibration), so a trainer failure shown there
 * would vanish the moment somebody touched the sensor connection. This panel
 * keeps its own (`snapshot.error`, written by the controller and by the preset
 * editor below).
 *
 * WHY WALL-CLOCK TICKS. The runner is pure and takes `nowMs`; a hidden tab has
 * its timers throttled or fully suspended, so one tick can arrive minutes late
 * having skipped several step boundaries. So the runner is driven from three
 * sources - the 250 ms interval below, every Indoor Bike Data notification, and
 * `visibilitychange` - and reduceRunner walks every boundary since the last
 * tick. Of the (possibly several) step-started events one tick emits, only the
 * LAST is sent to the trainer.
 *
 * WHY ONE CSV. The whole point of the log is a `merge_asof` against the Python
 * logger's `cw_time`, so samples and operator/protocol events share one file and
 * one `epoch_s` column - and a static-export page cannot fire two downloads from
 * one click anyway. See lib/trainer/session-log.ts; `csvForExport()` hands this
 * file the bytes and the filename, and the Blob dance below is all that is left.
 */

import { useEffect, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { TrainerChart } from "@/components/trainer-chart"
import { TrainerManualControls } from "@/components/trainer-manual-controls"
import { TrainerReadouts } from "@/components/trainer-readouts"
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
  const { snapshot, controller } = useTrainerController({ bluetoothAvailable, boardDeviceId })
  const {
    capabilities,
    chartData,
    connected,
    connecting,
    deviceName,
    error,
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

      <Card className="bg-white border-gray-200">
        <CardHeader>
          <CardTitle>Trainer connection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {!hasDevice && (
              <Button onClick={() => void controller.connect()} disabled={!bluetoothAvailable || connecting}>
                {connecting ? "Connecting…" : "Connect trainer"}
              </Button>
            )}
            {hasDevice && !connected && (
              <Button onClick={() => void controller.reconnect()} disabled={!bluetoothAvailable || connecting}>
                {connecting ? "Reconnecting…" : "Reconnect"}
              </Button>
            )}
            {hasDevice && (
              <Button variant="outline" onClick={() => void controller.disconnect()} disabled={connecting}>
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

      <Card className="bg-white border-gray-200">
        <CardHeader>
          <CardTitle>Recording</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Independent of the runner on purpose: a manual-power or resistance
              session is just as much a bench capture as a protocol run. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => controller.startRecording()} disabled={recording || heldRecording}>
              Start recording
            </Button>
            <Button variant="outline" onClick={() => controller.stopRecording()} disabled={!recording}>
              Stop recording
            </Button>
            <Button variant="outline" onClick={exportCsv} disabled={sampleCount === 0}>
              Export CSV
            </Button>
            <Button variant="outline" onClick={() => controller.clearRecording()} disabled={recording || !hasLog}>
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
