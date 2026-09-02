import { describe, expect, it } from "vitest"
import { RAW_CSV_HEADERS, rawCsvFilename, rawStreamToCsv } from "./csv"
import type { DataPoint } from "./packet"

const point = (over: Partial<DataPoint> = {}): DataPoint => ({
  timestamp: 1_767_225_907_300,
  timeLabel: "05:07.3",
  tick: 99,
  ticksMcu: 4294967296,
  force0: 1,
  force1: 2,
  force2: 3,
  force3: 4,
  force4: 5,
  force5: 6,
  accelX: 1.5,
  accelY: -1.5,
  accelZ: 9.81,
  gyroX: -0.25,
  gyroY: 0.25,
  gyroZ: 0,
  power: 7,
  referencePower: 150,
  synchronization: 3,
  ...over,
})

describe("RAW_CSV_HEADERS", () => {
  it("is the 17 existing column names, in order", () => {
    // Pinned byte-for-byte: downstream analysis scripts select these by name,
    // so a rename or a reorder here silently breaks every one of them.
    expect([...RAW_CSV_HEADERS]).toEqual([
      "tick",
      "ticks_mcu",
      "force_0",
      "force_1",
      "force_2",
      "force_3",
      "force_4",
      "force_5",
      "accel_x",
      "accel_y",
      "accel_z",
      "gyro_x",
      "gyro_y",
      "gyro_z",
      "power",
      "reference_power",
      "synchronization",
    ])
  })
})

describe("rawStreamToCsv", () => {
  it("starts with the header line", () => {
    expect(rawStreamToCsv([point()]).split("\n")[0]).toBe(RAW_CSV_HEADERS.join(","))
  })

  it("writes one row per sample with the 17 cells in header order", () => {
    const csv = rawStreamToCsv([point()])
    const rows = csv.split("\n")
    expect(rows).toHaveLength(2)
    const cells = rows[1].split(",")
    expect(cells).toHaveLength(RAW_CSV_HEADERS.length)
    expect(cells).toEqual([
      "99",
      "4294967296",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "1.5",
      "-1.5",
      "9.81",
      "-0.25",
      "0.25",
      "0",
      "7",
      "150",
      "3",
    ])
  })

  it("does NOT export timestamp or the chart label", () => {
    // Both are page-side conveniences; the CSV column set is the wire plus the
    // two stamped values, and adding a column would break the consumers above.
    const csv = rawStreamToCsv([point()])
    expect(csv).not.toContain("05:07.3")
    expect(csv).not.toContain("1767225907300")
  })

  it("keeps samples in capture order, one row each, newline-separated", () => {
    const csv = rawStreamToCsv([point({ tick: 1 }), point({ tick: 2 }), point({ tick: 3 })])
    const rows = csv.split("\n")
    expect(rows).toHaveLength(4)
    expect(rows.slice(1).map((row) => row.split(",")[0])).toEqual(["1", "2", "3"])
  })

  it("has no trailing newline", () => {
    expect(rawStreamToCsv([point()]).endsWith("\n")).toBe(false)
  })

  it("emits the header alone for an empty capture", () => {
    expect(rawStreamToCsv([])).toBe(RAW_CSV_HEADERS.join(","))
  })
})

describe("rawCsvFilename", () => {
  it("stamps the UTC date", () => {
    expect(rawCsvFilename(new Date("2026-09-02T14:30:00Z"), null)).toBe("cyclowatt_data_2026-09-02.csv")
  })

  it("appends the firmware tag when a version is known", () => {
    // The version goes in the FILENAME only - the CSV content stays
    // byte-identical - so a bench capture is attributable to a build.
    expect(rawCsvFilename(new Date("2026-09-02T14:30:00Z"), "1.4.2")).toBe("cyclowatt_data_2026-09-02_fw1.4.2.csv")
  })

  it("omits the tag for an empty version string", () => {
    expect(rawCsvFilename(new Date("2026-09-02T14:30:00Z"), "")).toBe("cyclowatt_data_2026-09-02.csv")
  })
})
