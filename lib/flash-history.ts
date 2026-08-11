/**
 * Per-browser flash log: which version went to which board, when, and the
 * end-to-end flash wall clock (upload + activate + reboot + verify) — NOT the
 * upload alone, so a record's throughput is a floor on link speed, not a
 * measurement of it. The wall-clock numbers feed the deferred pipelined-upload
 * decision (logger T24). localStorage-backed; store injectable for node tests.
 */

export interface FlashRecord {
  deviceId: string
  deviceName: string
  version: string
  startedAt: number
  durationMs: number
  sizeBytes: number
  outcome: "success" | "failed"
}

export interface StringStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const KEY = "cyclowatt-flash-history"
const CAP = 200

/**
 * Reading `window.localStorage` is itself a throwing operation: browsers configured
 * to block site data (and Chrome's "block third-party cookies" in an embedded
 * context) raise SecurityError on the property ACCESS, not on the later get/set.
 * There is no window at all during the Next prerender. Either way the flash log is
 * a bench nicety — degrade to a store that forgets everything rather than let the
 * throw escape into a React render/effect, where the root error boundary would
 * replace the whole logger page.
 */
const FORGETFUL_STORE: StringStore = { getItem: () => null, setItem: () => {} }

function defaultStore(): StringStore {
  try {
    return window.localStorage
  } catch {
    return FORGETFUL_STORE
  }
}

export function readFlashHistory(store: StringStore = defaultStore()): FlashRecord[] {
  try {
    const parsed: unknown = JSON.parse(store.getItem(KEY) ?? "[]")
    if (!Array.isArray(parsed)) return []
    return (parsed as FlashRecord[]).slice().sort((a, b) => b.startedAt - a.startedAt)
  } catch {
    return []
  }
}

export function appendFlashRecord(record: FlashRecord, store: StringStore = defaultStore()): FlashRecord[] {
  // Newest first, so slicing to CAP drops the OLDEST records.
  const history = [record, ...readFlashHistory(store)].slice(0, CAP)
  try {
    store.setItem(KEY, JSON.stringify(history))
  } catch (err) {
    // A failed write (quota exceeded, storage blocked) must never propagate: the
    // caller is a DFU flow whose phase would flip to "error" and present a
    // perfectly good flash as a red failure. Losing a log line is the cheaper
    // outcome — but say so on the console instead of swallowing it silently.
    console.warn("flash history: could not persist the record", err)
  }
  // Returned even when the write failed, so a caller that renders the return value
  // still shows the run it just observed.
  return history
}

/**
 * bytes*8/durationMs ≡ bytes*8/1000/seconds — kbit/s. 0 for a zero/absent duration.
 * Averaged over the END-TO-END flash (see the file header), so it reads well below
 * the raw link throughput; use it to compare runs, not to quantify the link.
 */
export function throughputKbps(record: FlashRecord): number {
  if (record.durationMs <= 0) return 0
  return (record.sizeBytes * 8) / record.durationMs
}
