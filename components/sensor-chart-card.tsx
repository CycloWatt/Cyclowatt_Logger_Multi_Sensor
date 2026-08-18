"use client"

/**
 * One streaming chart card (title bar + reset-zoom + legend chips + line chart
 * + brush), extracted from the page so it can be MEMOIZED.
 *
 * Why memo matters here: the page re-renders on every serial line, every
 * reference-power notification and every battery update, and before the
 * extraction each of those re-rendered five recharts trees - by far the most
 * expensive subtrees on the page. With memo, a chart only re-renders when a
 * prop it actually shows has changed: new chart data (identity changes on the
 * 100 ms chart tick), a visibility toggle, or a brush move. For that to work
 * every prop must be referentially stable across unrelated renders - the page
 * passes module-level constants (title, lines, config), state values, and
 * useState setters / useCallback handlers. Keep it that way when adding props.
 */

import { memo, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Brush } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"

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
  onZoomChange: (zoom: ZoomRange) => void
  onToggleLine: (key: string) => void
}

function SensorChartCardImpl({
  title,
  lines,
  data,
  config,
  visibility,
  zoom,
  onZoomChange,
  onToggleLine,
}: SensorChartCardProps) {
  // Y-axis range derived from only what is actually on screen: the currently
  // visible lines, restricted to the brushed index window. Hiding a line with a
  // large range therefore rescales the axis around the ones that remain.
  // Memoized so the page's non-chart re-renders (which reuse the same data
  // array) never rescan the window.
  const yDomain = useMemo<[number | "auto", number | "auto"]>(() => {
    const visibleKeys = lines.filter((line) => visibility[line.dataKey]).map((line) => line.dataKey)
    if (visibleKeys.length === 0 || data.length === 0) return ["auto", "auto"]

    const start = Math.max(0, zoom.startIndex ?? 0)
    const end = Math.min(data.length - 1, zoom.endIndex ?? data.length - 1)

    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY

    for (let i = start; i <= end; i++) {
      const point = data[i]
      if (!point) continue
      for (const key of visibleKeys) {
        const value = point[key]
        if (typeof value !== "number" || !Number.isFinite(value)) continue
        if (value < min) min = value
        if (value > max) max = value
      }
    }

    // No usable samples in this window yet - let recharts pick.
    if (min === Number.POSITIVE_INFINITY) return ["auto", "auto"]

    // Flat signal: give it headroom so the line isn't pinned to an axis edge.
    if (min === max) {
      const pad = Math.abs(min) * 0.1 || 1
      return [min - pad, max + pad]
    }

    const pad = (max - min) * 0.05
    return [min - pad, max + pad]
  }, [lines, data, visibility, zoom])

  return (
    <Card className="bg-white border-gray-200">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        <Button variant="outline" size="sm" onClick={() => onZoomChange({})} disabled={!isZoomed(zoom)}>
          Reset Zoom
        </Button>
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
        <ChartContainer config={config} className="h-[400px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 10, right: 10, left: 10, bottom: 50 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
              <XAxis dataKey="time" tick={false} axisLine={false} domain={["dataMin", "dataMax"]} type="category" />
              <YAxis tick={{ fontSize: 10 }} width={60} domain={yDomain} allowDataOverflow />
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
