"use client"

/**
 * The step-protocol editor: pick or save a named preset, then hand-edit its
 * steps (target watts, duration) or replace them wholesale with a generated
 * ramp.
 *
 * Every cell in the step table keeps its OWN raw text in local state rather
 * than formatting straight from `steps` on every keystroke - see the
 * `type="text"` note on components/sensor-chart-card.tsx L126-129. A number
 * input hands back an empty string for a value mid-edit (e.g. "12" while
 * typing "120"), which would silently wipe the field; parsing a string
 * ourselves lets a not-yet-valid keystroke stay on screen instead. A cell
 * only pushes its value up through `onStepsChange` once it parses as a finite
 * number - until then the previous value in `steps` is left untouched and the
 * cell is flagged amber, exactly like an out-of-range target is (both are
 * "this isn't what will actually get sent" states).
 *
 * The ramp generator REPLACES `steps` outright rather than editing in place:
 * it is a different way to author a whole protocol, not a per-step tool, and
 * mixing the two mental models (some steps hand-typed, some ramped) is more
 * confusing than it is useful on a bench.
 */

import { useEffect, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { SupportedRange } from "@/lib/ftms/protocol"
import { generateRamp, protocolDurationSeconds, type ProtocolStep } from "@/lib/trainer/protocol-runner"
import { MAX_STEPS, validateSteps, type TrainerPreset } from "@/lib/trainer/presets"
import { mmss } from "@/lib/trainer/format"

export interface TrainerStepEditorProps {
  steps: ProtocolStep[]
  onStepsChange: (steps: ProtocolStep[]) => void
  protocolName: string
  onNameChange: (name: string) => void
  presets: TrainerPreset[]
  selectedPresetId: string | null
  onLoadPreset: (id: string) => void
  onSavePreset: () => void
  onDeletePreset: (id: string) => void
  powerRange: SupportedRange
  disabled: boolean // true while a protocol is running/paused
}

const DEFAULT_STEP: ProtocolStep = { targetWatts: 100, durationSeconds: 180 }

/** Key for a step-table cell's in-progress raw text: distinct per row and field. */
type CellKey = `${number}:targetWatts` | `${number}:durationSeconds`

interface RampFields {
  startWatts: string
  endWatts: string
  incrementWatts: string
  stepDurationSeconds: string
}

const DEFAULT_RAMP_FIELDS: RampFields = {
  startWatts: "100",
  endWatts: "300",
  incrementWatts: "25",
  stepDurationSeconds: "60",
}

export function TrainerStepEditor({
  steps,
  onStepsChange,
  protocolName,
  onNameChange,
  presets,
  selectedPresetId,
  onLoadPreset,
  onSavePreset,
  onDeletePreset,
  powerRange,
  disabled,
}: TrainerStepEditorProps) {
  // Only cells the user is actively mid-typing an unparsable value into live
  // here; every other cell reads straight from `steps`, so a reorder or a
  // preset load never has stale text left behind.
  const [rawCells, setRawCells] = useState<Partial<Record<CellKey, string>>>({})
  const [rampOpen, setRampOpen] = useState(false)
  const [rampFields, setRampFields] = useState<RampFields>(DEFAULT_RAMP_FIELDS)
  const [rampMessage, setRampMessage] = useState<string | null>(null)
  /**
   * True while the next `steps` change originates HERE (a cell commit, a
   * move/remove/add, a generated ramp), so the effect below can tell it from an
   * external replacement. Internal edits manage exactly the rawCells entries
   * they invalidate themselves; wiping ALL of them on every internal change
   * would clear a half-typed value in row 1 the moment row 2 committed.
   */
  const internalStepsEditRef = useRef(false)

  function replaceSteps(next: ProtocolStep[]) {
    internalStepsEditRef.current = true
    onStepsChange(next)
  }

  // `steps` also changes out from under this component whenever the PARENT
  // swaps it in wholesale (onLoadPreset), and nothing else observes that.
  // Without this, an in-progress unparsable cell (e.g. "12x") survives a
  // preset load and keeps shadowing the freshly loaded value in `cellValue`.
  useEffect(() => {
    if (internalStepsEditRef.current) {
      internalStepsEditRef.current = false
      return
    }
    setRawCells({})
  }, [steps])

  const validationMessage = validateSteps(steps)
  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? null
  const canDelete = !disabled && selectedPreset !== null && !selectedPreset.builtIn
  const canSave = !disabled && protocolName.trim() !== "" && validationMessage === null

  function commitStep(index: number, patch: Partial<ProtocolStep>) {
    replaceSteps(steps.map((step, i) => (i === index ? { ...step, ...patch } : step)))
  }

  /** One numeric cell: raw text until it parses, then a committed number. */
  function handleCellChange(index: number, field: keyof ProtocolStep, text: string) {
    const key: CellKey = `${index}:${field}`
    const parsed = Number(text)
    if (text.trim() !== "" && Number.isFinite(parsed)) {
      setRawCells((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      commitStep(index, { [field]: parsed } as Partial<ProtocolStep>)
    } else {
      setRawCells((prev) => ({ ...prev, [key]: text }))
    }
  }

  function cellValue(index: number, field: keyof ProtocolStep): string {
    const key: CellKey = `${index}:${field}`
    return rawCells[key] ?? String(steps[index][field])
  }

  function cellIsAmber(index: number, field: keyof ProtocolStep): boolean {
    const key: CellKey = `${index}:${field}`
    if (rawCells[key] !== undefined) return true // mid-edit, not yet a valid number
    if (field === "targetWatts") {
      const value = steps[index].targetWatts
      return value < powerRange.min || value > powerRange.max
    }
    return false
  }

  function clearRawCellsForIndex(index: number) {
    setRawCells((prev) => {
      const next = { ...prev }
      delete next[`${index}:targetWatts`]
      delete next[`${index}:durationSeconds`]
      return next
    })
  }

  function moveStep(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= steps.length) return
    const next = [...steps]
    ;[next[index], next[target]] = [next[target], next[index]]
    setRawCells({}) // indices shifted - any in-progress cell text no longer refers to the same row
    replaceSteps(next)
  }

  function removeStep(index: number) {
    setRawCells({})
    replaceSteps(steps.filter((_, i) => i !== index))
  }

  function addStep() {
    clearRawCellsForIndex(steps.length)
    const template = steps.length > 0 ? steps[steps.length - 1] : DEFAULT_STEP
    replaceSteps([...steps, { ...template }])
  }

  /**
   * Generate never fails silently: a button that does nothing is
   * indistinguishable from a button that worked (the same reasoning as the
   * panel's savePresetFromEditor), so every refusal says why - and the one
   * silent truncation generateRamp performs (its MAX_STEPS cap) is said out
   * loud too, because a ramp that quietly stops short of its end wattage would
   * corrupt a bench sweep.
   */
  function generate() {
    const startWatts = Number(rampFields.startWatts)
    const endWatts = Number(rampFields.endWatts)
    const incrementWatts = Number(rampFields.incrementWatts)
    const stepDurationSeconds = Number(rampFields.stepDurationSeconds)
    if (![startWatts, endWatts, incrementWatts, stepDurationSeconds].every(Number.isFinite)) {
      setRampMessage("No ramp generated: every ramp field needs a number.")
      return
    }

    const ramp = generateRamp({ startWatts, endWatts, incrementWatts, stepDurationSeconds })
    if (ramp.length === 0) {
      const problem =
        incrementWatts === 0
          ? "the increment cannot be 0"
          : stepDurationSeconds <= 0
            ? "the step duration must be positive"
            : "the increment must step from start toward end (make it negative for a descending ramp)"
      setRampMessage(`No ramp generated: ${problem}.`)
      return
    }

    const lastWatts = ramp[ramp.length - 1].targetWatts
    const truncated = Math.abs(endWatts - lastWatts) >= Math.abs(incrementWatts)
    setRampMessage(
      truncated ? `Ramp capped at ${MAX_STEPS} steps - it stops at ${lastWatts} W, short of ${endWatts} W.` : null,
    )

    setRawCells({})
    replaceSteps(ramp)
    if (protocolName.trim() === "") {
      onNameChange(`Ramp ${startWatts}→${endWatts} W +${incrementWatts} W/${stepDurationSeconds}s`)
    }
  }

  return (
    <Card className="bg-white border-gray-200">
      <CardHeader>
        <CardTitle>Protocol</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={selectedPresetId ?? undefined} onValueChange={onLoadPreset} disabled={disabled}>
            <SelectTrigger className="h-10 w-56">
              <SelectValue placeholder="Load a preset..." />
            </SelectTrigger>
            <SelectContent>
              {presets.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  <span className="flex items-center gap-2">
                    {preset.name}
                    {preset.builtIn && (
                      <Badge variant="secondary" className="text-[10px]">
                        built-in
                      </Badge>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            value={protocolName}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder="Protocol name"
            disabled={disabled}
            className="h-10 w-56"
            aria-label="Protocol name"
          />

          <Button size="sm" variant="outline" disabled={!canSave} onClick={onSavePreset}>
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canDelete}
            onClick={() => selectedPresetId && onDeletePreset(selectedPresetId)}
          >
            Delete
          </Button>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Target (W)</TableHead>
              <TableHead>Duration (s)</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {steps.map((step, index) => (
              <TableRow key={index}>
                <TableCell className="text-gray-500">{index + 1}</TableCell>
                <TableCell>
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={cellValue(index, "targetWatts")}
                    onChange={(event) => handleCellChange(index, "targetWatts", event.target.value)}
                    disabled={disabled}
                    aria-label={`Step ${index + 1} target watts`}
                    className={`h-8 w-24 text-xs tabular-nums ${cellIsAmber(index, "targetWatts") ? "border-amber-500" : ""}`}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={cellValue(index, "durationSeconds")}
                    onChange={(event) => handleCellChange(index, "durationSeconds", event.target.value)}
                    disabled={disabled}
                    aria-label={`Step ${index + 1} duration seconds`}
                    className={`h-8 w-24 text-xs tabular-nums ${cellIsAmber(index, "durationSeconds") ? "border-amber-500" : ""}`}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      disabled={disabled || index === 0}
                      onClick={() => moveStep(index, -1)}
                      aria-label={`Move step ${index + 1} up`}
                    >
                      ↑
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      disabled={disabled || index === steps.length - 1}
                      onClick={() => moveStep(index, 1)}
                      aria-label={`Move step ${index + 1} down`}
                    >
                      ↓
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      disabled={disabled}
                      onClick={() => removeStep(index)}
                      aria-label={`Remove step ${index + 1}`}
                    >
                      ✕
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button size="sm" variant="outline" disabled={disabled} onClick={addStep}>
            + Add step
          </Button>
          <div className="text-sm text-gray-500">
            Total: <span className="tabular-nums">{mmss(protocolDurationSeconds({ name: protocolName, steps }))}</span>
          </div>
        </div>

        {validationMessage && <p className="text-sm text-amber-600">{validationMessage}</p>}

        <div className="border-t border-gray-200 pt-3">
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setRampOpen((open) => !open)}>
            Ramp…
          </Button>

          {rampOpen && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500">Start (W)</label>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={rampFields.startWatts}
                  onChange={(event) => setRampFields((prev) => ({ ...prev, startWatts: event.target.value }))}
                  disabled={disabled}
                  className="h-8 w-20 text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500">End (W)</label>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={rampFields.endWatts}
                  onChange={(event) => setRampFields((prev) => ({ ...prev, endWatts: event.target.value }))}
                  disabled={disabled}
                  className="h-8 w-20 text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500">Increment (W)</label>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={rampFields.incrementWatts}
                  onChange={(event) => setRampFields((prev) => ({ ...prev, incrementWatts: event.target.value }))}
                  disabled={disabled}
                  className="h-8 w-24 text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-500">Step duration (s)</label>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={rampFields.stepDurationSeconds}
                  onChange={(event) =>
                    setRampFields((prev) => ({ ...prev, stepDurationSeconds: event.target.value }))
                  }
                  disabled={disabled}
                  className="h-8 w-24 text-xs"
                />
              </div>
              <Button size="sm" variant="outline" disabled={disabled} onClick={generate}>
                Generate
              </Button>
            </div>
          )}

          {rampOpen && rampMessage && <p className="mt-2 text-sm text-amber-600">{rampMessage}</p>}
        </div>
      </CardContent>
    </Card>
  )
}
