"use client"

/**
 * One streaming chart card (title bar + Y-axis range control + reset-zoom +
 * legend chips + per-channel statistics + line chart + brush), extracted from
 * the page so it can be MEMOIZED.
 *
 * Why memo matters here: the page re-renders on every serial line, every
 * reference-power notification and every battery update, and before the
 * extraction each of those re-rendered five recharts trees - by far the most
 * expensive subtrees on the page. With memo, a chart only re-renders when a
 * prop it actually shows has changed: new chart data (identity changes on the
 * 100 ms chart tick), a visibility toggle, a brush move, or an axis-range edit.
 * For that to work every prop must be referentially stable across unrelated
 * renders - the page passes module-level constants (title, lines, config,
 * AUTO_AXIS), state values, and useState setters / useCallback handlers. Keep
 * it that way when adding props.
 *
 * The numbers themselves live in lib/chart-stats.ts: the axis domain and the
 * statistics readout answer the same question about the same window, so they
 * come from ONE scan of the data (see the note there).
 */

import { memo, useId, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Brush } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import {
  autoDomainFromStats,
  computeWindowStats,
  formatStat,
  resolveManualDomain,
  type AxisRange,
} from "@/lib/chart-stats"

export { AUTO_AXIS, type AxisRange } from "@/lib/chart-stats"

/** A brush window into the chart data; {} means "not zoomed". */
export interface ZoomRange {
  startIndex?: number
  endIndex?: number
}

/**
 * Zoomed = either bound is SET, not truthy. Index 0 is a legitimate brush
 * start, and the old `!startIndex` check kept Reset Zoom disabled for a brush
 * that began on the very first sample.
 */
export function isZoomed(zoom: ZoomRange): boolean {
  return zoom.startIndex != null || zoom.endIndex != null
}

/** One trace: the data field it plots and the name recharts shows for it. */
export interface ChartLineDef {
  dataKey: string
  name: string
}

interface SensorChartCardProps {
  title: string
  /** Module-level constant in the page - never rebuilt per render. */
  lines: readonly ChartLineDef[]
  data: Array<Record<string, number | string>>
  config: ChartConfig
  visibility: Record<string, boolean>
  zoom: ZoomRange
  /** Autoscale on/off plus the typed bounds. Starts at the shared AUTO_AXIS. */
  range: AxisRange
  onZoomChange: (zoom: ZoomRange) => void
  onRangeChange: (range: AxisRange) => void
  onToggleLine: (key: string) => void
}

function SensorChartCardImpl({
  title,
  lines,
  data,
  config,
  visibility,
  zoom,
  range,
  onZoomChange,
  onRangeChange,
  onToggleLine,
}: SensorChartCardProps) {
  const autoSwitchId = useId()

  // Everything derived from what is actually on screen - the currently visible
  // lines, restricted to the brushed index window - in a single pass. Hiding a
  // line therefore drops it from BOTH the axis and the readout, and the page's
  // non-chart re-renders (which reuse the same data array) never rescan.
  const { stats, autoDomain } = useMemo(() => {
    const visibleKeys = lines.filter((line) => visibility[line.dataKey]).map((line) => line.dataKey)
    const start = Math.max(0, zoom.startIndex ?? 0)
    const end = Math.min(data.length - 1, zoom.endIndex ?? data.length - 1)
    const windowStats = computeWindowStats(data, visibleKeys, start, end)
    return { stats: windowStats, autoDomain: autoDomainFromStats(windowStats) }
  }, [lines, data, visibility, zoom])

  // A manual range wins whenever it parses; until it does (switch just flipped,
  // a field still blank or mistyped) the chart keeps drawing on autoscale
  // rather than collapsing, and the hint below says so.
  const manualDomain = useMemo(() => resolveManualDomain(range), [range])
  const rangeIncomplete = range.manual && manualDomain === null

  const setRange = (patch: Partial<AxisRange>) => onRangeChange({ ...range, ...patch })

  return (
    <Card className="bg-white border-gray-200">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle>{title}</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Switch
              id={autoSwitchId}
              checked={!range.manual}
              onCheckedChange={(checked) => setRange({ manual: !checked })}
            />
            <label htmlFor={autoSwitchId} className="cursor-pointer text-xs font-medium text-gray-700">
              Auto Y
            </label>
          </div>
          {/* type="text", not "number": a number input hands back an empty
              string for a partially typed value such as "1e", which would wipe
              the field mid-edit. Bounds are parsed strictly in
              resolveManualDomain instead. */}
          <Input
            type="text"
            inputMode="decimal"
            value={range.min}
            onChange={(event) => setRange({ min: event.target.value })}
            disabled={!range.manual}
            placeholder="Y min"
            aria-label={`${title} Y axis minimum`}
            aria-invalid={rangeIncomplete}
            className={`h-8 w-24 text-xs ${rangeIncomplete ? "border-amber-500" : ""}`}
          />
          <Input
            type="text"
            inputMode="decimal"
            value={range.max}
            onChange={(event) => setRange({ max: event.target.value })}
            disabled={!range.manual}
            placeholder="Y max"
            aria-label={`${title} Y axis maximum`}
            aria-invalid={rangeIncomplete}
            className={`h-8 w-24 text-xs ${rangeIncomplete ? "border-amber-500" : ""}`}
          />
          <Button variant="outline" size="sm" onClick={() => onZoomChange({})} disabled={!isZoomed(zoom)}>
            Reset Zoom
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-2">
        {/* Clickable legend chips that toggle each line's visibility */}
        <div className="flex flex-wrap gap-2 px-2 pb-2">
          {lines.map((line) => {
            const lineConfig = config[line.dataKey]
            const visible = visibility[line.dataKey]
            return (
              <button
                key={line.dataKey}
                type="button"
                onClick={() => onToggleLine(line.dataKey)}
                aria-pressed={visible}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
                  visible
                    ? "border-gray-300 bg-gray-50 text-gray-900"
                    : "border-gray-200 bg-transparent text-gray-400"
                }`}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{
                    backgroundColor: visible ? lineConfig?.color : "transparent",
                    border: `1px solid ${lineConfig?.color}`,
                  }}
                />
                {lineConfig?.label}
              </button>
            )
          })}
        </div>

        {rangeIncomplete && (
          <p className="px-2 pb-2 text-xs text-amber-600">
            Enter a Y min and a Y max with min below max - drawing on autoscale until then.
          </p>
        )}

        {/* Per-channel statistics over the same window the chart draws: the
            brush selection when zoomed, the whole buffer otherwise. Meant for
            static load tests - drag the brush across a held plateau and read
            that plateau's mean and spread. */}
        {stats.length > 0 && (
          <div className="overflow-x-auto px-2 pb-2">
            <table className="w-full text-xs tabular-nums">
              <thead>
                <tr className="text-gray-500">
                  <th className="py-1 pr-3 text-left font-medium">Channel</th>
                  <th className="py-1 pr-3 text-right font-medium">Mean</th>
                  <th className="py-1 pr-3 text-right font-medium">SD</th>
                  <th className="py-1 pr-3 text-right font-medium">Variance</th>
                  <th className="py-1 text-right font-medium">n</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((entry) => (
                  <tr key={entry.key} className="border-t border-gray-100">
                    <td className="py-1 pr-3 text-left text-gray-700">
                      <span className="flex items-center gap-1.5">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: config[entry.key]?.color }}
                        />
                        {config[entry.key]?.label ?? entry.key}
                      </span>
                    </td>
                    <td className="py-1 pr-3 text-right text-gray-900">{formatStat(entry.mean)}</td>
                    <td className="py-1 pr-3 text-right text-gray-900">{formatStat(entry.stdDev)}</td>
                    <td className="py-1 pr-3 text-right text-gray-900">{formatStat(entry.variance)}</td>
                    <td className="py-1 text-right text-gray-500">{entry.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <ChartContainer config={config} className="h-[400px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 10, right: 10, left: 10, bottom: 50 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
              <XAxis dataKey="time" tick={false} axisLine={false} domain={["dataMin", "dataMax"]} type="category" />
              {/* allowDataOverflow is what makes a manual range CLIP rather than
                  be widened back out by an outlier - the reason to switch
                  autoscale off in the first place. */}
              <YAxis tick={{ fontSize: 10 }} width={60} domain={manualDomain ?? autoDomain} allowDataOverflow />
              <ChartTooltip content={<ChartTooltipContent />} />
              {lines.map((line) => (
                <Line
                  key={line.dataKey}
                  type="monotone"
                  dataKey={line.dataKey}
                  stroke={`var(--color-${line.dataKey})`}
                  strokeWidth={2}
                  dot={false}
                  name={line.name}
                  isAnimationActive={false}
                  hide={!visibility[line.dataKey]}
                />
              ))}
              <Brush
                dataKey="time"
                height={30}
                stroke={`var(--color-${lines[0].dataKey})`}
                startIndex={zoom.startIndex}
                endIndex={zoom.endIndex}
                onChange={(brushData) => {
                  if (brushData) {
                    onZoomChange({ startIndex: brushData.startIndex, endIndex: brushData.endIndex })
                  }
                }}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

export const SensorChartCard = memo(SensorChartCardImpl)
