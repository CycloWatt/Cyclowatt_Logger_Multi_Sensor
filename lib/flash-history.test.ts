import { afterEach, describe, expect, it, vi } from "vitest"
import { appendFlashRecord, readFlashHistory, throughputKbps, type FlashRecord, type StringStore } from "./flash-history"

function memStore(initial?: string): StringStore {
  const map = new Map<string, string>()
  if (initial !== undefined) map.set("cyclowatt-flash-history", initial)
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

const REC: FlashRecord = { deviceId: "id1", deviceName: "Cyclowatt L v0.2.2", version: "0.2.3", startedAt: 1000, durationMs: 20000, sizeBytes: 313683, outcome: "success" }

describe("flash history", () => {
  it("appends and reads newest-first", () => {
    const store = memStore()
    appendFlashRecord(REC, store)
    appendFlashRecord({ ...REC, startedAt: 2000, outcome: "failed" }, store)
    const history = readFlashHistory(store)
    expect(history).toHaveLength(2)
    expect(history[0].startedAt).toBe(2000)
  })
  it("returns [] on corrupt storage instead of throwing", () => {
    expect(readFlashHistory(memStore("{not json"))).toEqual([])
  })
  it("caps at 200 records, dropping the oldest", () => {
    const store = memStore()
    for (let i = 0; i < 205; i++) appendFlashRecord({ ...REC, startedAt: i }, store)
    const history = readFlashHistory(store)
    expect(history).toHaveLength(200)
    expect(history[history.length - 1].startedAt).toBe(5)
  })
  it("computes throughput in kbit/s", () => {
    expect(throughputKbps(REC)).toBeCloseTo((313683 * 8) / 1000 / 20, 1)
    expect(throughputKbps({ ...REC, durationMs: 0 })).toBe(0)
  })
})

/**
 * The default store is reached through `window.localStorage`, whose mere ACCESS
 * throws when the browser blocks site data — and there is no `window` at all under
 * the Next prerender (or here in the node test env). Neither may escape: these run
 * with NO store argument on purpose, exercising defaultStore()'s fallback.
 */
describe("flash history default store", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
    vi.restoreAllMocks()
  })

  it("degrades to a forgetful store when there is no window (prerender / node)", () => {
    expect("window" in globalThis).toBe(false)
    expect(readFlashHistory()).toEqual([])
    expect(() => appendFlashRecord(REC)).not.toThrow()
  })

  it("degrades to a forgetful store when the browser blocks site data", () => {
    // Site-data blocking surfaces as a throwing `localStorage` getter.
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        get localStorage(): never {
          throw new Error("SecurityError: access to storage is denied")
        },
      },
    })
    expect(readFlashHistory()).toEqual([])
    expect(() => appendFlashRecord(REC)).not.toThrow()
  })

  it("warns but does not throw when the write fails (quota / blocked storage)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const readOnly: StringStore = {
      getItem: () => "[]",
      setItem: () => {
        throw new Error("QuotaExceededError")
      },
    }
    // The unpersisted record still comes back, so a caller can render this run.
    expect(appendFlashRecord(REC, readOnly)).toHaveLength(1)
    expect(warn).toHaveBeenCalledOnce()
  })
})
