"use client"

/**
 * The "Recording" card: Start/Stop recording, the sample count, Export CSV,
 * Clear, the held-recording amber warning, and the epoch_s clock note.
 *
 * Purely presentational, moved verbatim out of trainer-panel.tsx - see that
 * file's header comment for why the recording is independent of the runner
 * and why a held (unexported) recording blocks Start rather than being
 * silently discarded.
 */

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export interface TrainerRecordingCardProps {
  recording: boolean
  heldRecording: boolean
  sampleCount: number
  hasLog: boolean
  onStartRecording: () => void
  onStopRecording: () => void
  onExport: () => void
  onClear: () => void
}

export function TrainerRecordingCard({
  recording,
  heldRecording,
  sampleCount,
  hasLog,
  onStartRecording,
  onStopRecording,
  onExport,
  onClear,
}: TrainerRecordingCardProps) {
  return (
    <Card className="bg-white border-gray-200">
      <CardHeader>
        <CardTitle>Recording</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Independent of the runner on purpose: a manual-power or resistance
            session is just as much a bench capture as a protocol run. */}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onStartRecording} disabled={recording || heldRecording}>
            Start recording
          </Button>
          <Button variant="outline" onClick={onStopRecording} disabled={!recording}>
            Stop recording
          </Button>
          <Button variant="outline" onClick={onExport} disabled={sampleCount === 0}>
            Export CSV
          </Button>
          <Button variant="outline" onClick={onClear} disabled={recording || !hasLog}>
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
  )
}
