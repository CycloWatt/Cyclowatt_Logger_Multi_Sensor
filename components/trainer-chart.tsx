"use client"

/**
 * The Trainer tab's live power/target/cadence trace.
 *
 * Memoized for the same reason components/sensor-chart-card.tsx is: the panel
 * re-renders on every FTMS notification and every runner tick, and recharts
 * trees are by far the most expensive thing on the page. `data` is the only
 * prop and its identity changes exactly once per buffer flush, so `memo`
 * turns "re-render on every notification" into "re-render on every flush".
 *
 * Power and target share the left (W) axis so the dashed target line reads
 * directly against the power trace it is steering; cadence gets its own
 * right-hand axis because rpm and watts don't share a sensible scale. The
 * target line uses `connectNulls` because a still-set target should draw
 * through gaps in the data; cadence deliberately does NOT - a gap in cadence
 * is a real missing reading (freewheeling, a dropped notification) and
 * papering over it with an interpolated line would hide that.
 */

import { memo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from "recharts"

export interface TrainerChartPoint {
  t: number // seconds since chart start
  power: number | null
  target: number | null
  cadence: number | null
}

const TRAINER_CHART_CONFIG: ChartConfig = {
  power: { label: "Power", color: "hsl(var(--chart-1))" },
  target: { label: "Target", color: "hsl(var(--chart-4))" },
  cadence: { label: "Cadence", color: "hsl(var(--chart-2))" },
}

/** `t` is seconds since chart start; the X axis needs it as mm:ss. */
function mmss(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

function TrainerChartImpl({ data }: { data: TrainerChartPoint[] }) {
  return (
    <Card className="bg-white border-gray-200">
      <CardHeader>
        <CardTitle>Power & Cadence</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-[300px] w-full items-center justify-center text-sm text-gray-500">
            Connect a trainer to see live data
          </div>
        ) : (
          <ChartContainer config={TRAINER_CHART_CONFIG} className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 10, right: 10, left: 10, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={mmss} />
                <YAxis yAxisId="w" width={48} unit=" W" />
                <YAxis yAxisId="rpm" orientation="right" width={56} unit=" rpm" />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Line
                  yAxisId="w"
                  dataKey="target"
                  type="stepAfter"
                  stroke="var(--color-target)"
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                  strokeDasharray="4 2"
                />
                <Line
                  yAxisId="w"
                  dataKey="power"
                  type="monotone"
                  stroke="var(--color-power)"
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="rpm"
                  dataKey="cadence"
                  type="monotone"
                  stroke="var(--color-cadence)"
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

export const TrainerChart = memo(TrainerChartImpl)
