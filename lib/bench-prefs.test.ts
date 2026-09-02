import { afterEach, describe, expect, it } from "vitest"
import { BENCH_PREFS_KEY, readBenchPrefs, writeBenchPrefs, type BenchPrefs } from "./bench-prefs"
import type { StringStore } from "./flash-history"

/** An in-memory StringStore, so the round trip is testable without a browser. */
const memoryStore = (seed?: string): StringStore & { raw: () => string | null } => {
  let value: string | null = seed ?? null
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next
    },
    raw: () => value,
  }
}

/** A store whose write always fails, the way a storage-blocked browser behaves. */
const throwingStore: StringStore = {
  getItem: () => null,
  setItem: () => {
    throw new Error("storage blocked")
  },
}

describe("readBenchPrefs", () => {
  it("returns empty prefs when nothing was ever stored", () => {
    expect(readBenchPrefs(memoryStore())).toEqual({})
  })

  it("reads back both switches", () => {
    const store = memoryStore(JSON.stringify({ csvCaptureEnabled: false, useDeviceFilter: true }))
    expect(readBenchPrefs(store)).toEqual({ csvCaptureEnabled: false, useDeviceFilter: true })
  })

  it("falls back to empty prefs on corrupt JSON", () => {
    // A half-written record must not take the logger down - the page reads these
    // in a mount effect, where a throw would hit the root error boundary.
    expect(readBenchPrefs(memoryStore("{not json"))).toEqual({})
  })

  it("falls back to empty prefs when the record is not an object", () => {
    expect(readBenchPrefs(memoryStore("42"))).toEqual({})
    expect(readBenchPrefs(memoryStore("null"))).toEqual({})
  })
})

describe("writeBenchPrefs", () => {
  it("persists an update and merges it over what was already stored", () => {
    const store = memoryStore(JSON.stringify({ csvCaptureEnabled: false }))
    writeBenchPrefs({ useDeviceFilter: true }, store)
    expect(readBenchPrefs(store)).toEqual({ csvCaptureEnabled: false, useDeviceFilter: true })
  })

  it("overwrites the same switch rather than accumulating", () => {
    const store = memoryStore()
    writeBenchPrefs({ csvCaptureEnabled: true }, store)
    writeBenchPrefs({ csvCaptureEnabled: false }, store)
    expect(JSON.parse(store.raw() ?? "null")).toEqual({ csvCaptureEnabled: false })
  })

  it("returns the merged prefs it wrote", () => {
    const store = memoryStore(JSON.stringify({ useDeviceFilter: false }))
    const merged: BenchPrefs = writeBenchPrefs({ csvCaptureEnabled: true }, store)
    expect(merged).toEqual({ useDeviceFilter: false, csvCaptureEnabled: true })
  })

  it("swallows a failing write - the switch still works for this session", () => {
    expect(() => writeBenchPrefs({ csvCaptureEnabled: true }, throwingStore)).not.toThrow()
  })
})

describe("BENCH_PREFS_KEY", () => {
  it("is the key previous sessions already wrote", () => {
    // Changing this string silently forgets every operator's saved setup.
    expect(BENCH_PREFS_KEY).toBe("cyclowatt-bench-prefs")
  })
})

/**
 * With NO store argument these exercise defaultStore(), reached through
 * `window.localStorage` — whose mere ACCESS throws when the browser blocks site
 * data, and which does not exist at all under the Next prerender (or here in the
 * node test env). Same shape as lib/flash-history.test.ts's default-store block.
 */
describe("bench prefs default store", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it("degrades to a forgetful store when there is no window (prerender / node)", () => {
    expect("window" in globalThis).toBe(false)
    expect(readBenchPrefs()).toEqual({})
    expect(() => writeBenchPrefs({ csvCaptureEnabled: true })).not.toThrow()
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
    expect(readBenchPrefs()).toEqual({})
    expect(() => writeBenchPrefs({ useDeviceFilter: true })).not.toThrow()
  })

  it("returns defaults when the store's getItem itself throws", () => {
    // A store can fail on READ too, not just on write: the mount effect must
    // still hand the page a usable prefs object instead of hitting the root
    // error boundary.
    const unreadableStore: StringStore = {
      getItem: () => {
        throw new Error("SecurityError: access to storage is denied")
      },
      setItem: () => {},
    }
    expect(readBenchPrefs(unreadableStore)).toEqual({})
    expect(writeBenchPrefs({ csvCaptureEnabled: true }, unreadableStore)).toEqual({ csvCaptureEnabled: true })
  })
})
