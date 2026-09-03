import { describe, expect, it, vi } from "vitest"
import type { StringStore } from "../flash-history"
import {
  BUILT_IN_PRESETS,
  MAX_STEPS,
  PRESET_STORAGE_KEY,
  deletePreset,
  newPresetId,
  readPresets,
  savePreset,
  validateSteps,
  type ProtocolStep,
} from "./presets"

/** An in-memory store, which is the whole reason StringStore is injectable. */
function memoryStore(initial?: string): StringStore {
  let value = initial ?? null
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next
    },
  }
}

const step = (targetWatts: number, durationSeconds = 60): ProtocolStep => ({
  targetWatts,
  durationSeconds,
})

describe("readPresets", () => {
  it("is built-ins only, in declared order, for a store that has never been written", () => {
    const presets = readPresets(memoryStore())
    expect(presets.map((p) => p.id)).toEqual(BUILT_IN_PRESETS.map((p) => p.id))
    expect(presets.every((p) => p.builtIn)).toBe(true)
  })

  it("reads corrupt stored data as built-ins only rather than throwing", () => {
    // Callers render this straight into the Trainer tab; a JSON parse error
    // escaping here would take the whole page down through the root error boundary.
    expect(readPresets(memoryStore("not json at all")).map((p) => p.id)).toEqual(
      BUILT_IN_PRESETS.map((p) => p.id),
    )
    expect(readPresets(memoryStore('{"not":"an array"}')).map((p) => p.id)).toEqual(
      BUILT_IN_PRESETS.map((p) => p.id),
    )
  })

  it("drops a malformed entry but keeps the valid ones alongside it", () => {
    const store = memoryStore(
      JSON.stringify([
        { id: "u1", name: "Good preset", steps: [step(150)], savedAt: 5 },
        { id: "u2", name: "Missing steps" }, // no `steps` field at all
      ]),
    )
    const names = readPresets(store).map((p) => p.name)
    expect(names).toContain("Good preset")
    expect(names).not.toContain("Missing steps")
  })

  it("orders built-ins first in declared order, then user presets newest first", () => {
    const store = memoryStore(
      JSON.stringify([
        { id: "u-old", name: "Old one", steps: [step(100)], savedAt: 1 },
        { id: "u-new", name: "New one", steps: [step(100)], savedAt: 9 },
      ]),
    )
    const names = readPresets(store).map((p) => p.name)
    expect(names.slice(0, BUILT_IN_PRESETS.length)).toEqual(BUILT_IN_PRESETS.map((p) => p.name))
    expect(names.slice(BUILT_IN_PRESETS.length)).toEqual(["New one", "Old one"])
  })
})

describe("savePreset", () => {
  it("round-trips: the saved preset appears after the built-ins with an id and savedAt", () => {
    const store = memoryStore()
    const list = savePreset({ name: "My interval set", steps: [step(200), step(250)] }, store)

    const saved = list.find((p) => p.name === "My interval set")
    expect(saved).toBeDefined()
    expect(saved?.id).toBeTruthy()
    expect(saved?.savedAt).toBeGreaterThan(0)
    expect(saved?.steps).toEqual([step(200), step(250)])
    expect(list.indexOf(saved!)).toBeGreaterThanOrEqual(BUILT_IN_PRESETS.length)

    // And it is actually persisted, not just returned.
    expect(readPresets(store).find((p) => p.name === "My interval set")).toBeDefined()
  })

  it("replaces a preset saved under the same trimmed name, preserving its id", () => {
    const store = memoryStore()
    const first = savePreset({ name: "Sweet spot", steps: [step(200)] }, store)
    const firstId = first.find((p) => p.name === "Sweet spot")!.id

    const second = savePreset({ name: "Sweet spot", steps: [step(210), step(220)] }, store)
    const updated = second.find((p) => p.name === "Sweet spot")!

    expect(second).toHaveLength(first.length)
    expect(updated.id).toBe(firstId)
    expect(updated.steps).toEqual([step(210), step(220)])
  })

  it("matches on id when one is given, so a rename keeps one row per id and per name", () => {
    const store = memoryStore()
    const first = savePreset({ name: "Sweet spot", steps: [step(200)] }, store)
    const sweetSpotId = first.find((p) => p.name === "Sweet spot")!.id
    savePreset({ name: "Openers", steps: [step(300)] }, store)

    // Rename "Sweet spot" (by its id) onto the name "Openers": neither the id
    // nor the name may end up on two rows, or deletePreset(id) would take both.
    const list = savePreset({ id: sweetSpotId, name: "Openers", steps: [step(310)] }, store)

    const userPresets = list.filter((p) => !p.builtIn)
    expect(userPresets).toHaveLength(1)
    expect(userPresets[0]).toMatchObject({ id: sweetSpotId, name: "Openers", steps: [step(310)] })
    expect(readPresets(store).filter((p) => p.id === sweetSpotId)).toHaveLength(1)
  })

  it("refuses a name matching a built-in and leaves the store untouched", () => {
    const store = memoryStore()
    const before = store.getItem(PRESET_STORAGE_KEY)

    const list = savePreset({ name: BUILT_IN_PRESETS[0].name, steps: [step(200)] }, store)

    expect(list).toEqual(readPresets(store))
    expect(list.filter((p) => p.name === BUILT_IN_PRESETS[0].name)).toHaveLength(1)
    expect(store.getItem(PRESET_STORAGE_KEY)).toBe(before)
  })

  it("refuses invalid steps (empty list) and leaves the store untouched", () => {
    const store = memoryStore()
    const before = store.getItem(PRESET_STORAGE_KEY)

    const list = savePreset({ name: "Bad preset", steps: [] }, store)

    expect(list.find((p) => p.name === "Bad preset")).toBeUndefined()
    expect(store.getItem(PRESET_STORAGE_KEY)).toBe(before)
  })

  it("refuses invalid steps (zero duration) and leaves the store untouched", () => {
    const store = memoryStore()
    const before = store.getItem(PRESET_STORAGE_KEY)

    const list = savePreset({ name: "Zero duration", steps: [step(200, 0)] }, store)

    expect(list.find((p) => p.name === "Zero duration")).toBeUndefined()
    expect(store.getItem(PRESET_STORAGE_KEY)).toBe(before)
  })

  it("does not throw when the store refuses to write, and warns instead", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const hostile: StringStore = {
      getItem: () => "[]",
      setItem: () => {
        throw new Error("QuotaExceededError")
      },
    }

    expect(() => savePreset({ name: "Doomed", steps: [step(200)] }, hostile)).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("deletePreset", () => {
  it("is a no-op for an unknown id", () => {
    const store = memoryStore()
    savePreset({ name: "Keep me", steps: [step(200)] }, store)
    const before = readPresets(store)

    expect(deletePreset("does-not-exist", store)).toEqual(before)
  })

  it("is a no-op for a built-in id", () => {
    const store = memoryStore()
    const before = readPresets(store)

    expect(deletePreset(BUILT_IN_PRESETS[0].id, store)).toEqual(before)
    expect(readPresets(store).map((p) => p.id)).toContain(BUILT_IN_PRESETS[0].id)
  })

  it("removes a user preset by id", () => {
    const store = memoryStore()
    const saved = savePreset({ name: "Temporary", steps: [step(200)] }, store)
    const id = saved.find((p) => p.name === "Temporary")!.id

    const after = deletePreset(id, store)

    expect(after.find((p) => p.name === "Temporary")).toBeUndefined()
    expect(readPresets(store).find((p) => p.name === "Temporary")).toBeUndefined()
  })
})

describe("validateSteps", () => {
  it("is null for a valid step list", () => {
    expect(validateSteps([step(100), step(200)])).toBeNull()
  })

  it("reports an empty list", () => {
    expect(validateSteps([])).toBeTruthy()
  })

  it("reports a non-finite number", () => {
    expect(validateSteps([{ targetWatts: NaN, durationSeconds: 60 }])).toBeTruthy()
    expect(validateSteps([{ targetWatts: 100, durationSeconds: Infinity }])).toBeTruthy()
  })

  it("reports negative watts", () => {
    expect(validateSteps([{ targetWatts: -1, durationSeconds: 60 }])).toBeTruthy()
  })

  it("reports non-positive duration", () => {
    expect(validateSteps([{ targetWatts: 100, durationSeconds: 0 }])).toBeTruthy()
    expect(validateSteps([{ targetWatts: 100, durationSeconds: -5 }])).toBeTruthy()
  })

  it("reports more than MAX_STEPS steps", () => {
    const tooMany = Array.from({ length: MAX_STEPS + 1 }, () => step(100))
    expect(validateSteps(tooMany)).toBeTruthy()
  })

  it("accepts exactly MAX_STEPS steps", () => {
    const justEnough = Array.from({ length: MAX_STEPS }, () => step(100))
    expect(validateSteps(justEnough)).toBeNull()
  })
})

describe("newPresetId", () => {
  it("returns distinct strings", () => {
    expect(newPresetId()).not.toBe(newPresetId())
  })
})
