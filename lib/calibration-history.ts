/**
 * Per-browser log of force-calibration readings: which sensor held which six
 * per-channel zero offsets, when, and whether the entry came from a calibration
 * RUN or from simply reading what the board already had stored.
 *
 * Why a log at all: a single calibration tells you nothing on its own. What the
 * bench actually asks is whether a board repeats, whether one channel is drifting
 * away from its siblings, and whether the offsets on a board today are the ones
 * put there last week. All three are comparisons across time, which means the
 * readings have to outlive the page.
 *
 * localStorage-backed with an injectable store, mirroring lib/flash-history.ts -
 * same reasoning, same failure discipline, and deliberately not a second pattern
 * for the same job.
 *
 * Timestamps are BROWSER local time. The board has no clock and nothing on the
 * wire carries one, so an entry is stamped when this page observed it, which is
 * not necessarily when the board measured it.
 */

import type { StringStore } from "./flash-history"

/** Force channels per board. Matches SENSOR_SAMPLE_FORCE_COUNT in the firmware. */
export const CALIBRATION_CHANNEL_COUNT = 6

/**
 * How an entry came to exist.
 *
 * "calibration" - a run started from this page; the board measured fresh values.
 * "read" - the board's already-stored values, read without calibrating.
 */
export type CalibrationKind = "calibration" | "read"

export interface CalibrationRecord {
  /** Unique within this log; the handle the delete button uses. */
  id: string
  deviceId: string
  /**
   * The sensor's name at the time of the reading.
   *
   * Must come from the page's authoritative post-connect name, NEVER from
   * BluetoothDevice.name - Chrome freezes that at grant time and never refreshes
   * it, so a device.name here would stamp older readings with a stale board name
   * and quietly make the log lie about which sensor was measured.
   */
  deviceName: string
  kind: CalibrationKind
  /** Browser wall clock, milliseconds since epoch. */
  recordedAt: number
  /** Whether the board reported a STORED calibration behind these values. */
  calibrated: boolean
  /** The six per-channel zero offsets in millivolts, in board channel order. */
  offsetsMv: number[]
  /**
   * The per-sensor average in Newtons the Control Point returned.
   *
   * Only a calibration RUN produces one - the value is carried in the procedure's
   * response, and a plain characteristic read never sees it. null for reads.
   */
  avgOffsetN: number | null
}

const KEY = "cyclowatt-calibration-history"

/**
 * Entries kept, newest wins. Matches the flash log's cap: a bench session
 * produces readings in the tens, so this is roughly a season of work, and the
 * six-number payload is small enough that the cap is about tidiness rather than
 * about the storage quota.
 */
const CAP = 200

/** Same rationale as the flash log's: see lib/flash-history.ts. */
const FORGETFUL_STORE: StringStore = { getItem: () => null, setItem: () => {} }

function defaultStore(): StringStore {
  try {
    return window.localStorage
  } catch {
    return FORGETFUL_STORE
  }
}

/**
 * Stamp a record with a unique id.
 *
 * Split out so append() stays a pure function of its input and the tests can
 * build records by hand with fixed ids. crypto.randomUUID is present in every
 * browser this page supports and in the node the tests run under, but the
 * fallback keeps a hostile or ancient environment from producing colliding ids -
 * which would make the delete button remove the wrong row.
 */
export function newCalibrationRecord(fields: Omit<CalibrationRecord, "id">): CalibrationRecord {
  const id =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${fields.recordedAt}-${fields.deviceId}-${Math.random().toString(36).slice(2)}`

  return { id, ...fields }
}

/** The whole log, newest first. Never throws; a corrupt store reads as empty. */
export function readCalibrationHistory(store: StringStore = defaultStore()): CalibrationRecord[] {
  try {
    const parsed: unknown = JSON.parse(store.getItem(KEY) ?? "[]")
    if (!Array.isArray(parsed)) return []
    return (parsed as CalibrationRecord[]).slice().sort((a, b) => b.recordedAt - a.recordedAt)
  } catch {
    return []
  }
}

/** Persist, swallowing storage failures the way the flash log does. */
function write(history: CalibrationRecord[], store: StringStore): CalibrationRecord[] {
  try {
    store.setItem(KEY, JSON.stringify(history))
  } catch (err) {
    // A failed write must never propagate: the callers are a calibration flow and
    // a click handler, and an exception escaping into React would take the whole
    // logger page down through the root error boundary. Losing a log line is the
    // cheaper outcome - but say so rather than swallowing it silently.
    console.warn("calibration history: could not persist the log", err)
  }
  return history
}

export function appendCalibrationRecord(
  record: CalibrationRecord,
  store: StringStore = defaultStore(),
): CalibrationRecord[] {
  // Newest first, so slicing to CAP drops the OLDEST entries.
  return write([record, ...readCalibrationHistory(store)].slice(0, CAP), store)
}

/** Drop one entry. A no-op for an unknown id, so a double click cannot throw. */
export function deleteCalibrationRecord(
  id: string,
  store: StringStore = defaultStore(),
): CalibrationRecord[] {
  return write(
    readCalibrationHistory(store).filter((record) => record.id !== id),
    store,
  )
}

/**
 * Erase the log for this browser. Writes an empty array rather than removing the
 * key, so StringStore keeps the two methods every caller and test double already
 * implements - the same call the flash log makes, for the same reason.
 */
export function clearCalibrationHistory(store: StringStore = defaultStore()): CalibrationRecord[] {
  return write([], store)
}

/** Do two readings describe the same board state? */
export function sameReading(
  a: Pick<CalibrationRecord, "calibrated" | "offsetsMv">,
  b: Pick<CalibrationRecord, "calibrated" | "offsetsMv">,
): boolean {
  return (
    a.calibrated === b.calibrated &&
    a.offsetsMv.length === b.offsetsMv.length &&
    a.offsetsMv.every((mv, i) => mv === b.offsetsMv[i])
  )
}

/**
 * Should a connect-time READ be logged?
 *
 * THE ANTI-SPAM RULE. Reconnecting to an unchanged board must not add a row -
 * do that and a bench afternoon buries the handful of real calibrations under
 * dozens of identical reads. So a read is logged only when the board's state
 * differs from the newest thing already known about THAT board.
 *
 * Compared against the newest entry for the device regardless of kind: the entry
 * a reconnect duplicates is usually the calibration that produced those values,
 * not an earlier read.
 *
 * A calibration RUN never goes through this gate. Two runs producing identical
 * values is a repeatability RESULT and the single most useful thing this log can
 * show; suppressing it would throw away the measurement.
 *
 * @param candidate the freshly read board state.
 * @param history   the existing log (any order).
 */
export function isNewReadingForDevice(
  candidate: Pick<CalibrationRecord, "deviceId" | "calibrated" | "offsetsMv">,
  history: CalibrationRecord[],
): boolean {
  const forDevice = history
    .filter((record) => record.deviceId === candidate.deviceId)
    .sort((a, b) => b.recordedAt - a.recordedAt)

  if (forDevice.length === 0) return true

  return !sameReading(candidate, forDevice[0])
}

/**
 * Quote one CSV cell.
 *
 * Board names are user-facing text that can legitimately contain a comma, and a
 * spreadsheet silently shifting every later column is the kind of corruption
 * nobody notices until the numbers have already been trusted.
 */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Column order of the exported CSV. Also its header row. */
const CSV_COLUMNS = [
  "recorded_at_iso",
  "sensor_name",
  "device_id",
  "kind",
  "calibrated",
  "avg_offset_n",
  ...Array.from({ length: CALIBRATION_CHANNEL_COUNT }, (_, i) => `ch${i}_mv`),
]

/**
 * The whole log as CSV text, newest first, one row per reading.
 *
 * ISO timestamps rather than the on-screen local format: an exported file
 * outlives the browser that wrote it, and a spreadsheet full of ambiguous
 * day/month dates cannot be repaired after the fact.
 *
 * Ends with a trailing newline, which is what makes the last row parse in tools
 * that treat a missing final newline as a truncated file.
 */
export function calibrationHistoryToCsv(records: CalibrationRecord[]): string {
  const rows = records.map((record) =>
    [
      new Date(record.recordedAt).toISOString(),
      csvCell(record.deviceName),
      csvCell(record.deviceId),
      record.kind,
      record.calibrated ? "1" : "0",
      record.avgOffsetN === null ? "" : String(record.avgOffsetN),
      ...Array.from({ length: CALIBRATION_CHANNEL_COUNT }, (_, i) =>
        record.offsetsMv[i] === undefined ? "" : String(record.offsetsMv[i]),
      ),
    ].join(","),
  )

  return [CSV_COLUMNS.join(","), ...rows].join("\n") + "\n"
}
