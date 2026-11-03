"use client"

/**
 * The protocol "Run" card: Start / Pause / Resume / Skip step / Stop and the
 * runner status line ("running · next 200 W").
 *
 * Purely presentational, moved verbatim out of trainer-panel.tsx. `steps` and
 * `runnerStatus` are passed rather than pre-computed booleans for the Start
 * button so its `disabled` expression - `validateSteps(steps) !== null` among
 * others - stays character-for-character identical to the original.
 */

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { validateSteps } from "@/lib/trainer/presets"
import type { ProtocolStep } from "@/lib/trainer/protocol-runner"
import type { RunnerStatus } from "@/lib/trainer/protocol-runner"

export interface TrainerRunCardProps {
  connected: boolean
  protocolActive: boolean
  starting: boolean
  steps: ProtocolStep[]
  runnerStatus: RunnerStatus
  nextStep: ProtocolStep | null
  boardReady: boolean
  boardStreaming: boolean
  onStartWithStreaming: () => void
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onSkip: () => void
  onStop: () => void
}

export function TrainerRunCard({
  connected,
  protocolActive,
  starting,
  steps,
  runnerStatus,
  nextStep,
  onStart,
  boardReady,
  boardStreaming,
  onStartWithStreaming,
  onPause,
  onResume,
  onSkip,
  onStop,
}: TrainerRunCardProps) {
  return (
    <Card className="bg-white border-gray-200">
      <CardHeader>
        <CardTitle>Run protocol</CardTitle>
        <p className="text-sm text-gray-500">
          {boardReady
            ? boardStreaming ? "CycloWatt is streaming. Start the protocol with CSV capture enabled." : "Start CycloWatt CSV capture and the trainer protocol together."
            : "Connect a CycloWatt board in Data Streaming to start both together."}
          {" "}Existing CycloWatt samples are kept. Stopping the protocol leaves CycloWatt recording until you stop it in Data Streaming.
        </p>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Button
          onClick={onStartWithStreaming}
          disabled={!connected || !boardReady || protocolActive || starting || validateSteps(steps) !== null}
        >
          {starting ? "Starting…" : "Start protocol + streaming"}
        </Button>
        <Button variant="outline"
          onClick={onStart}
          disabled={!connected || protocolActive || starting || validateSteps(steps) !== null}
        >
          Start protocol only
        </Button>
        <Button variant="outline" onClick={onPause} disabled={runnerStatus !== "running"}>
          Pause
        </Button>
        <Button variant="outline" onClick={onResume} disabled={runnerStatus !== "paused"}>
          Resume
        </Button>
        <Button variant="outline" onClick={onSkip} disabled={!protocolActive}>
          Skip step
        </Button>
        <Button variant="outline" onClick={onStop} disabled={!protocolActive}>
          Stop
        </Button>
        <span className="text-sm text-gray-500">
          {runnerStatus}
          {nextStep && runnerStatus === "running" && ` · next ${nextStep.targetWatts} W`}
        </span>
      </CardContent>
    </Card>
  )
}
