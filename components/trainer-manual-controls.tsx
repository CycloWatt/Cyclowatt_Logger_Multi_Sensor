"use client"

/**
 * Manual trainer control, outside of any step protocol: hold a fixed target
 * power or a fixed resistance level.
 *
 * The two sub-modes are mutually exclusive on the trainer itself (FTMS's Set
 * Target Power and Set Target Resistance Level are different Control Point
 * ops, and only one target is "live" at a time), so this is a toggle rather
 * than two independently-armed panels - switching sub-mode is a deliberate
 * choice about which Control Point op the panel will send next, not just a
 * display filter.
 *
 * Every edit - typed, nudged by a button, or dragged on the slider - is
 * clamped before it reaches the caller: `clampToRange` snaps to the trainer's
 * own increment grid, so a value this panel shows is always one the trainer
 * will accept unmodified, and the ±N buttons can't walk a value off the grid
 * one press at a time.
 */

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { clampToRange, type SupportedRange } from "@/lib/ftms/protocol"

export type ManualSubMode = "power" | "resistance"

export interface TrainerManualControlsProps {
  subMode: ManualSubMode
  onSubModeChange: (m: ManualSubMode) => void
  targetW: number
  onTargetW: (w: number) => void
  resistancePct: number
  onResistancePct: (pct: number) => void
  powerRange: SupportedRange
  disabled: boolean
}

const RESISTANCE_RANGE: SupportedRange = { min: 0, max: 100, increment: 1 }

export function TrainerManualControls({
  subMode,
  onSubModeChange,
  targetW,
  onTargetW,
  resistancePct,
  onResistancePct,
  powerRange,
  disabled,
}: TrainerManualControlsProps) {
  // Raw text for the power input, same "don't reformat while typing" reason
  // as the step editor's table cells: committed only when it parses.
  const [powerText, setPowerText] = useState(String(targetW))

  // Only an EXTERNAL change to targetW (a preset load, the panel syncing a
  // trainer-confirmed value, a nudge-button click) should overwrite what's on
  // screen. Typing itself never touches targetW - onChange only updates
  // powerText - so this can't clobber a keystroke in progress.
  useEffect(() => {
    setPowerText(String(targetW))
  }, [targetW])

  function commitPowerText(text: string) {
    const parsed = Number(text)
    if (text.trim() !== "" && Number.isFinite(parsed)) {
      onTargetW(clampToRange(parsed, powerRange))
    } else {
      setPowerText(String(targetW)) // not a number - revert rather than send a stale target
    }
  }

  function nudgePower(delta: number) {
    onTargetW(clampToRange(targetW + delta, powerRange))
  }

  function nudgeResistance(delta: number) {
    onResistancePct(clampToRange(resistancePct + delta, RESISTANCE_RANGE))
  }

  return (
    <Card className="bg-white border-gray-200">
      <CardHeader>
        <CardTitle>Manual</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={subMode === "power" ? "default" : "outline"}
            disabled={disabled}
            onClick={() => onSubModeChange("power")}
          >
            Target power
          </Button>
          <Button
            size="sm"
            variant={subMode === "resistance" ? "default" : "outline"}
            disabled={disabled}
            onClick={() => onSubModeChange("resistance")}
          >
            Resistance level
          </Button>
        </div>

        {subMode === "power" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="text-3xl font-semibold tabular-nums text-gray-900">{targetW} W</div>
              <Input
                type="text"
                inputMode="numeric"
                value={powerText}
                onChange={(event) => setPowerText(event.target.value)}
                onBlur={(event) => commitPowerText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitPowerText(event.currentTarget.value)
                }}
                disabled={disabled}
                aria-label="Target power watts"
                className="h-9 w-24 text-sm"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => nudgePower(-25)}>
                −25
              </Button>
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => nudgePower(-5)}>
                −5
              </Button>
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => nudgePower(5)}>
                +5
              </Button>
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => nudgePower(25)}>
                +25
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-3xl font-semibold tabular-nums text-gray-900">{resistancePct} %</div>
            <Slider
              min={0}
              max={100}
              step={1}
              value={[resistancePct]}
              onValueChange={([value]) => onResistancePct(clampToRange(value, RESISTANCE_RANGE))}
              disabled={disabled}
              aria-label="Resistance level percent"
            />
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => nudgeResistance(-5)}>
                −5
              </Button>
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => nudgeResistance(-1)}>
                −1
              </Button>
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => nudgeResistance(1)}>
                +1
              </Button>
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => nudgeResistance(5)}>
                +5
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
