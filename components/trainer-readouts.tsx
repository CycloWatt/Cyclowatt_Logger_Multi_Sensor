"use client"

/**
 * The four live numbers a rider actually looks at while a trainer session
 * runs: power, cadence, the current target, and where the protocol is.
 *
 * Purely presentational - every value arrives pre-formatted from the panel
 * (the thing that owns the FTMS notification stream and the runner) so this
 * file never touches units, clamping or protocol state itself. That keeps the
 * "N W" vs "N %" target-unit decision, the "Step 2 / 5" vs "Manual" wording,
 * and the mm:ss elapsed formatting in exactly one place instead of drifting
 * between here and whatever renders the step editor.
 *
 * `stale` greys every value rather than just power/cadence: a target or step
 * label that keeps updating while the trainer itself has gone quiet would
 * read as "still connected", which is the one thing a stale board must not
 * imply.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export interface TrainerReadoutsProps {
  powerW: number | null
  cadenceRpm: number | null
  targetLabel: string // e.g. "250 W" | "35 %" | "–"
  stepLabel: string // e.g. "Step 2 / 5" | "Manual" | "–"
  elapsedLabel: string // e.g. "04:12 / 15:00"
  stale: boolean // true when no notification for > 3 s: grey the numbers
  trainerReportedTargetW: number | null // shown small under target as "trainer confirms N W" when non-null
}

/** One readout tile: a big value, an optional unit, and an optional small caption below it. */
function ReadoutCard({
  title,
  value,
  unit,
  caption,
  stale,
}: {
  title: string
  value: string
  unit?: string
  caption?: string
  stale: boolean
}) {
  return (
    <Card className="bg-white border-gray-200">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-gray-500">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-4xl font-semibold tabular-nums ${stale ? "text-gray-400" : "text-gray-900"}`}>
          {value}
          {unit && <span className="ml-1 text-sm text-gray-500">{unit}</span>}
        </div>
        {caption && <div className="mt-1 text-sm text-gray-500">{caption}</div>}
      </CardContent>
    </Card>
  )
}

export function TrainerReadouts({
  powerW,
  cadenceRpm,
  targetLabel,
  stepLabel,
  elapsedLabel,
  stale,
  trainerReportedTargetW,
}: TrainerReadoutsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <ReadoutCard title="Power" value={powerW === null ? "–" : String(powerW)} unit="W" stale={stale} />
      <ReadoutCard title="Cadence" value={cadenceRpm === null ? "–" : String(cadenceRpm)} unit="rpm" stale={stale} />
      <ReadoutCard
        title="Target"
        value={targetLabel}
        caption={trainerReportedTargetW !== null ? `trainer confirms ${trainerReportedTargetW} W` : undefined}
        stale={stale}
      />
      <ReadoutCard title="Step / Elapsed" value={stepLabel} caption={elapsedLabel} stale={stale} />
    </div>
  )
}
