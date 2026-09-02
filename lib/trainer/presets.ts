/**
 * Named step protocols for the Trainer tab: a handful of built-ins shipped in
 * code, plus whatever the rider saves from the bench, kept in this browser's
 * localStorage.
 *
 * localStorage-backed with an injectable store, mirroring lib/calibration-history.ts
 * - same reasoning, same failure discipline, and deliberately not a second
 * pattern for the same job. Built-ins are never written to the store: they are
 * a fixed part of the code, so persisting a copy would only give a stale copy
 * something to disagree with after the next release changes one.
 */

import type { StringStore } from "../flash-history"

/**
 * One step of constant target power. Defined locally rather than imported from
 * ./protocol-runner (built in parallel by another task) so this module has no
 * dependency on it; the runner's identical structural type unifies with this
 * one under TypeScript's structural typing, so callers can pass either.
 */
export interface ProtocolStep {
  targetWatts: number
  durationSeconds: number
}

export interface TrainerPreset {
  id: string
  name: string
  steps: ProtocolStep[]
  /** true for one of the shipped BUILT_IN_PRESETS; absent on a user preset. */
  builtIn?: boolean
  savedAt: number
}

/**
 * A cap on step count, not a cap on protocol length - a 200-step protocol
 * already takes far longer than a bench session runs, and without a cap a
 * malformed import (or a copy/paste gone wrong) could hand the runner an
 * effectively unbounded list.
 */
export const MAX_STEPS = 200

export const PRESET_STORAGE_KEY = "cyclowatt-trainer-presets"

/** Build the N,N+step,...,end steps of a linear ramp, one call per built-in. */
function rampSteps(
  startWatts: number,
  endWatts: number,
  stepWatts: number,
  durationSeconds: number,
): ProtocolStep[] {
  const steps: ProtocolStep[] = []
  for (let watts = startWatts; watts <= endWatts; watts += stepWatts) {
    steps.push({ targetWatts: watts, durationSeconds })
  }
  return steps
}

/**
 * The shipped presets, in the order the Trainer tab lists them. This is the
 * ONE array the bench adjusts - add, remove, or retune a built-in here rather
 * than anywhere else. `savedAt` is unused for built-ins (they are never
 * persisted) and fixed at 0 so it never sorts ahead of a real user preset.
 */
export const BUILT_IN_PRESETS: readonly TrainerPreset[] = [
  {
    id: "builtin-warmup",
    name: "Warm-up 10 min @ 100 W",
    steps: [{ targetWatts: 100, durationSeconds: 600 }],
    builtIn: true,
    savedAt: 0,
  },
  {
    id: "builtin-step-test",
    name: "Step test 100→300 W / 3 min",
    steps: [100, 150, 200, 250, 300].map((targetWatts) => ({
      targetWatts,
      durationSeconds: 180,
    })),
    builtIn: true,
    savedAt: 0,
  },
  {
    id: "builtin-ramp",
    name: "Ramp 100→400 W +25 W/min",
    steps: rampSteps(100, 400, 25, 60),
    builtIn: true,
    savedAt: 0,
  },
]

/** Same rationale as calibration-history's: see lib/flash-history.ts. */
const FORGETFUL_STORE: StringStore = { getItem: () => null, setItem: () => {} }

function defaultStore(): StringStore {
  try {
    return window.localStorage
  } catch {
    return FORGETFUL_STORE
  }
}

/**
 * Every rule a step list must satisfy, checked in this order, returning the
 * FIRST human-readable problem found rather than collecting all of them - the
 * Trainer tab shows this straight next to a Save button, and one clear
 * sentence beats a list nobody reads.
 */
export function validateSteps(steps: readonly ProtocolStep[]): string | null {
  if (steps.length === 0) return "add at least one step"

  for (const step of steps) {
    if (!Number.isFinite(step.targetWatts) || !Number.isFinite(step.durationSeconds)) {
      return "every step needs a real number for watts and duration"
    }
    if (step.targetWatts < 0) return "target watts cannot be negative"
    if (step.durationSeconds <= 0) return "step duration must be positive"
  }

  if (steps.length > MAX_STEPS) return `a protocol can have at most ${MAX_STEPS} steps`

  return null
}

/**
 * Mint an id for a new user preset.
 *
 * crypto.randomUUID is present in every browser this page supports and in the
 * node the tests run under, but the fallback keeps a hostile or ancient
 * environment from producing colliding ids - which would make one save
 * silently overwrite an unrelated preset. Same fallback shape as
 * lib/calibration-history.ts's newCalibrationRecord.
 */
export function newPresetId(): string {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Is `value` shaped enough to trust as a stored ProtocolStep? */
function isStoredStep(value: unknown): value is ProtocolStep {
  if (typeof value !== "object" || value === null) return false
  const step = value as Record<string, unknown>
  return typeof step.targetWatts === "number" && typeof step.durationSeconds === "number"
}

/** Is `value` shaped enough to trust as a stored user TrainerPreset? */
function isStoredPreset(value: unknown): value is TrainerPreset {
  if (typeof value !== "object" || value === null) return false
  const preset = value as Record<string, unknown>
  return (
    typeof preset.id === "string" &&
    typeof preset.name === "string" &&
    typeof preset.savedAt === "number" &&
    Array.isArray(preset.steps) &&
    preset.steps.every(isStoredStep)
  )
}

/**
 * Just the user presets, newest first. A corrupt store or a non-array reads
 * as empty; within an array, one malformed entry is dropped rather than
 * discarding the whole list - a single hand-edited or half-migrated row must
 * not take every other saved preset down with it.
 */
function readUserPresets(store: StringStore): TrainerPreset[] {
  try {
    const parsed: unknown = JSON.parse(store.getItem(PRESET_STORAGE_KEY) ?? "[]")
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isStoredPreset).sort((a, b) => b.savedAt - a.savedAt)
  } catch {
    return []
  }
}

/** Persist the user presets, swallowing storage failures the way calibration-history does. */
function write(userPresets: TrainerPreset[], store: StringStore): TrainerPreset[] {
  try {
    store.setItem(PRESET_STORAGE_KEY, JSON.stringify(userPresets))
  } catch (err) {
    // A failed write must never propagate: the caller is a Save button click,
    // and an exception escaping into React would take the whole Trainer tab
    // down through the root error boundary. Losing the save is the cheaper
    // outcome - but say so rather than swallowing it silently.
    console.warn("trainer presets: could not persist the list", err)
  }
  return [...BUILT_IN_PRESETS, ...userPresets]
}

/**
 * The whole preset list: built-ins first in declared order, then user presets
 * newest first. Never throws; a corrupt store reads as built-ins only.
 */
export function readPresets(store: StringStore = defaultStore()): TrainerPreset[] {
  return [...BUILT_IN_PRESETS, ...readUserPresets(store)]
}

/**
 * Create or update a user preset, matched by its trimmed name.
 *
 * A name matching a built-in is refused outright - the runner and any export
 * assumes a name identifies one protocol, and a same-named user preset would
 * make that ambiguous. Invalid steps are refused the same way. Either
 * rejection returns the unchanged list and touches the store not at all, so a
 * failed save is indistinguishable from having never been attempted.
 */
export function savePreset(
  preset: { id?: string; name: string; steps: ProtocolStep[] },
  store: StringStore = defaultStore(),
): TrainerPreset[] {
  const name = preset.name.trim()

  if (BUILT_IN_PRESETS.some((builtIn) => builtIn.name === name)) return readPresets(store)
  if (validateSteps(preset.steps) !== null) return readPresets(store)

  const userPresets = readUserPresets(store)
  const existing = userPresets.find((p) => p.name === name)
  const next: TrainerPreset = {
    id: preset.id ?? existing?.id ?? newPresetId(),
    name,
    steps: preset.steps,
    savedAt: Date.now(),
  }

  return write([next, ...userPresets.filter((p) => p.name !== name)], store)
}

/**
 * Drop one user preset. A no-op for a built-in id or an id that is not in the
 * store - a double click, or a stale id from a list rendered before someone
 * else's change, must not throw or touch anything that was not asked for.
 */
export function deletePreset(id: string, store: StringStore = defaultStore()): TrainerPreset[] {
  const userPresets = readUserPresets(store)
  if (!userPresets.some((p) => p.id === id)) return readPresets(store)

  return write(
    userPresets.filter((p) => p.id !== id),
    store,
  )
}
