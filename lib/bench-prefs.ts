/**
 * One localStorage record for the bench switches (CSV capture, chooser filter),
 * so a page reload keeps the operator's setup.
 *
 * Same store-and-key style as lib/flash-history.ts and lib/calibration-history.ts,
 * and deliberately not a third pattern for the same job: the store is injectable
 * so the round trip is testable in the node-only vitest setup, and both the read
 * and the write are best-effort.
 *
 * WHY NOTHING HERE MAY THROW: the page restores these in a mount effect and
 * writes them from a switch handler. localStorage is not merely absent during
 * the Next prerender - browsers configured to block site data raise SecurityError
 * on the property ACCESS itself - and an escaped throw in either place would hit
 * the root error boundary and replace the whole logger page. Losing a remembered
 * switch position is the cheaper outcome.
 */

import type { StringStore } from "./flash-history"

export const BENCH_PREFS_KEY = "cyclowatt-bench-prefs"

export interface BenchPrefs {
  csvCaptureEnabled?: boolean
  useDeviceFilter?: boolean
}

/** A store that forgets everything, for when `window.localStorage` itself throws. */
const FORGETFUL_STORE: StringStore = { getItem: () => null, setItem: () => {} }

function defaultStore(): StringStore {
  try {
    return window.localStorage
  } catch {
    return FORGETFUL_STORE
  }
}

export function readBenchPrefs(store: StringStore = defaultStore()): BenchPrefs {
  try {
    const raw = store.getItem(BENCH_PREFS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null ? (parsed as BenchPrefs) : {}
  } catch {
    return {}
  }
}

/**
 * Merge `update` over the stored prefs and persist the result.
 *
 * Returns the merged prefs even when the write failed, so a caller that renders
 * the return value still shows the setting it just applied.
 */
export function writeBenchPrefs(update: Partial<BenchPrefs>, store: StringStore = defaultStore()): BenchPrefs {
  const merged: BenchPrefs = { ...readBenchPrefs(store), ...update }
  try {
    store.setItem(BENCH_PREFS_KEY, JSON.stringify(merged))
  } catch {
    // non-fatal - the switch still works for this session
  }
  return merged
}
