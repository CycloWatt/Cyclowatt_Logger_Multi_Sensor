import { describe, expect, it, vi } from "vitest"
import type { StringStore } from "./flash-history"
import {
  appendCalibrationRecord,
  calibrationHistoryToCsv,
  clearCalibrationHistory,
  deleteCalibrationRecord,
  isNewReadingForDevice,
  newCalibrationRecord,
  readCalibrationHistory,
  sameReading,
  type CalibrationRecord,
} from "./calibration-history"

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

/** A record with sane defaults; override only what a test is about. */
const record = (over: Partial<CalibrationRecord> = {}): CalibrationRecord => ({
  id: "id-1",
  deviceId: "board-a",
  deviceName: "CycloRaw 6630",
  kind: "calibration",
  recordedAt: 1_000,
  calibrated: true,
  offsetsMv: [1, 2, 3, 4, 5, 6],
  avgOffsetN: 7,
  ...over,
})

describe("readCalibrationHistory", () => {
  it("is empty for a store that has never been written", () => {
    expect(readCalibrationHistory(memoryStore())).toEqual([])
  })

  it("returns entries newest first regardless of stored order", () => {
    const store = memoryStore(
      JSON.stringify([
        record({ id: "old", recordedAt: 1 }),
        record({ id: "new", recordedAt: 9 }),
        record({ id: "mid", recordedAt: 5 }),
      ]),
    )
    expect(readCalibrationHistory(store).map((r) => r.id)).toEqual(["new", "mid", "old"])
  })

  it("reads corrupt stored data as empty rather than throwing", () => {
    // The callers render this straight into React. A JSON parse error escaping
    // here would take the whole page down through the root error boundary.
    expect(readCalibrationHistory(memoryStore("not json at all"))).toEqual([])
    expect(readCalibrationHistory(memoryStore('{"not":"an array"}'))).toEqual([])
  })
})

describe("appendCalibrationRecord", () => {
  it("puts the new entry first and persists it", () => {
    const store = memoryStore()
    appendCalibrationRecord(record({ id: "first", recordedAt: 1 }), store)
    const history = appendCalibrationRecord(record({ id: "second", recordedAt: 2 }), store)

    expect(history.map((r) => r.id)).toEqual(["second", "first"])
    expect(readCalibrationHistory(store).map((r) => r.id)).toEqual(["second", "first"])
  })

  it("does not throw when the store refuses to write", () => {
    // Quota exceeded, or a browser blocking site data. The caller is a
    // calibration flow whose success must not be reported as a failure just
    // because a log line could not be kept.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const hostile: StringStore = {
      getItem: () => "[]",
      setItem: () => {
        throw new Error("QuotaExceededError")
      },
    }

    const history = appendCalibrationRecord(record(), hostile)

    // Still returned, so a caller rendering the return value shows the run it
    // just observed even though nothing was persisted.
    expect(history).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("deleteCalibrationRecord", () => {
  it("removes only the named entry", () => {
    const store = memoryStore(
      JSON.stringify([record({ id: "a", recordedAt: 3 }), record({ id: "b", recordedAt: 2 })]),
    )
    expect(deleteCalibrationRecord("a", store).map((r) => r.id)).toEqual(["b"])
    expect(readCalibrationHistory(store).map((r) => r.id)).toEqual(["b"])
  })

  it("is a no-op for an unknown id", () => {
    // A double click must not throw or clear anything.
    const store = memoryStore(JSON.stringify([record({ id: "a" })]))
    expect(deleteCalibrationRecord("nope", store).map((r) => r.id)).toEqual(["a"])
  })
})

describe("clearCalibrationHistory", () => {
  it("empties the log", () => {
    const store = memoryStore(JSON.stringify([record({ id: "a" }), record({ id: "b" })]))
    expect(clearCalibrationHistory(store)).toEqual([])
    expect(readCalibrationHistory(store)).toEqual([])
  })
})

describe("sameReading", () => {
  it("is true only when the flag and every channel match", () => {
    const base = { calibrated: true, offsetsMv: [1, 2, 3, 4, 5, 6] }
    expect(sameReading(base, { calibrated: true, offsetsMv: [1, 2, 3, 4, 5, 6] })).toBe(true)
    expect(sameReading(base, { calibrated: false, offsetsMv: [1, 2, 3, 4, 5, 6] })).toBe(false)
    expect(sameReading(base, { calibrated: true, offsetsMv: [1, 2, 3, 4, 5, 9] })).toBe(false)
  })

  it("does not call a shorter reading equal to a longer one", () => {
    expect(
      sameReading({ calibrated: true, offsetsMv: [1, 2] }, { calibrated: true, offsetsMv: [1, 2, 3] }),
    ).toBe(false)
  })
})

describe("isNewReadingForDevice", () => {
  const reading = { deviceId: "board-a", calibrated: true, offsetsMv: [1, 2, 3, 4, 5, 6] }

  it("logs the first sight of a board", () => {
    expect(isNewReadingForDevice(reading, [])).toBe(true)
  })

  it("does NOT log a reconnect that found the board unchanged", () => {
    // The anti-spam rule. Without this, a bench afternoon buries the handful of
    // real calibrations under dozens of identical reconnect reads.
    const history = [record({ deviceId: "board-a", offsetsMv: [1, 2, 3, 4, 5, 6] })]
    expect(isNewReadingForDevice(reading, history)).toBe(false)
  })

  it("logs when the board's values changed since it was last seen", () => {
    const history = [record({ deviceId: "board-a", offsetsMv: [9, 9, 9, 9, 9, 9] })]
    expect(isNewReadingForDevice(reading, history)).toBe(true)
  })

  it("compares against the NEWEST entry, not just any match", () => {
    // An older identical entry must not suppress a genuinely changed board.
    const history = [
      record({ id: "old", deviceId: "board-a", recordedAt: 1, offsetsMv: [1, 2, 3, 4, 5, 6] }),
      record({ id: "new", deviceId: "board-a", recordedAt: 9, offsetsMv: [8, 8, 8, 8, 8, 8] }),
    ]
    expect(isNewReadingForDevice(reading, history)).toBe(true)
  })

  it("ignores other boards entirely", () => {
    // Two boards on one bench must not silence each other.
    const history = [record({ deviceId: "board-b", offsetsMv: [1, 2, 3, 4, 5, 6] })]
    expect(isNewReadingForDevice(reading, history)).toBe(true)
  })

  it("logs a board that lost its calibration even with identical values", () => {
    const history = [record({ deviceId: "board-a", calibrated: false, offsetsMv: [1, 2, 3, 4, 5, 6] })]
    expect(isNewReadingForDevice(reading, history)).toBe(true)
  })
})

describe("newCalibrationRecord", () => {
  it("gives two records made from identical fields distinct ids", () => {
    // Ids are what the delete button targets; a collision would remove the wrong
    // row.
    const fields = { ...record() } as Partial<CalibrationRecord>
    delete fields.id
    const a = newCalibrationRecord(fields as Omit<CalibrationRecord, "id">)
    const b = newCalibrationRecord(fields as Omit<CalibrationRecord, "id">)
    expect(a.id).not.toBe(b.id)
  })
})

describe("calibrationHistoryToCsv", () => {
  it("writes a header and one row per reading", () => {
    const csv = calibrationHistoryToCsv([record({ recordedAt: 0 })])
    const lines = csv.trimEnd().split("\n")

    expect(lines[0]).toBe(
      "recorded_at_iso,sensor_name,device_id,kind,calibrated,avg_offset_n,ch0_mv,ch1_mv,ch2_mv,ch3_mv,ch4_mv,ch5_mv",
    )
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe("1970-01-01T00:00:00.000Z,CycloRaw 6630,board-a,calibration,1,7,1,2,3,4,5,6")
  })

  it("leaves the Newton column empty for a read", () => {
    // A plain characteristic read never sees the Control Point's average, and an
    // empty cell says that far better than a 0 would.
    const csv = calibrationHistoryToCsv([record({ kind: "read", avgOffsetN: null, recordedAt: 0 })])
    expect(csv.trimEnd().split("\n")[1]).toBe(
      "1970-01-01T00:00:00.000Z,CycloRaw 6630,board-a,read,1,,1,2,3,4,5,6",
    )
  })

  it("quotes a sensor name containing a comma", () => {
    // Otherwise every later column shifts by one and the file is silently wrong.
    const csv = calibrationHistoryToCsv([record({ deviceName: "Board A, left", recordedAt: 0 })])
    expect(csv).toContain('"Board A, left"')
  })

  it("doubles embedded quotes", () => {
    const csv = calibrationHistoryToCsv([record({ deviceName: 'the "spare" board', recordedAt: 0 })])
    expect(csv).toContain('"the ""spare"" board"')
  })

  it("ends with a newline so the last row is not treated as truncated", () => {
    expect(calibrationHistoryToCsv([record()])).toMatch(/\n$/)
  })

  it("is header-only for an empty log", () => {
    expect(calibrationHistoryToCsv([]).trimEnd().split("\n")).toHaveLength(1)
  })
})
