import { describe, expect, it } from "vitest"
import { RAW_CSV_HEADERS, rawCsvFilename, rawStreamToCsv } from "./csv"
import { EXPECTED_PACKET_SIZE, parseDataPacket, type DataPoint } from "./packet"

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

/** The cells of the first data row, keyed by header - so a test reads a column by NAME. */
const firstRowByHeader = (csv: string): Record<string, string> => {
  const [header, row] = csv.split("\n")
  const cells = row.split(",")
  return Object.fromEntries(header.split(",").map((name, i) => [name, cells[i]]))
}

describe("RAW_CSV_HEADERS", () => {
  it("is logger-fw's 17 cyclowatt.csv columns, then reference_power", () => {
    // The first 17 are copied from logger-fw srm_cw_logger_raw.py main() and
    // must stay byte-identical to it: power-analysis-suite maps exactly these
    // names (templates/session/schema_map.json). A change there is a change here.
    expect([...RAW_CSV_HEADERS]).toEqual([
      "cw_time",
      "force1_channel1",
      "force1_channel2",
      "force2_channel1",
      "force2_channel2",
      "force3_channel1",
      "force3_channel2",
      "accel_x",
      "accel_y",
      "accel_z",
      "gyro_x",
      "gyro_y",
      "gyro_z",
      "power",
      "tick",
      "tick_mcu",
      "synch",
      "reference_power",
    ])
  })
})

describe("rawStreamToCsv", () => {
  it("starts with the header line", () => {
    expect(rawStreamToCsv([point()]).split("\n")[0]).toBe(RAW_CSV_HEADERS.join(","))
  })

  it("writes one row per sample with the 18 cells in header order", () => {
    const csv = rawStreamToCsv([point()])
    const rows = csv.split("\n")
    expect(rows).toHaveLength(2)
    const cells = rows[1].split(",")
    expect(cells).toHaveLength(RAW_CSV_HEADERS.length)
    expect(cells).toEqual([
      "1767225907.300",
      "1",
      "4",
      "2",
      "5",
      "3",
      "6",
      "1.5",
      "-1.5",
      "9.81",
      "-0.25",
      "0.25",
      "0",
      "7",
      "99",
      "4294967296",
      "3",
      "150",
    ])
  })

  it("regroups the wire slots per sensor exactly like logger-fw parse_cyclowatt", () => {
    // Wire slots 0-2 are the three sensors' normal amps, 3-5 their shear amps;
    // the logger's columns are per sensor. Renaming by position instead
    // (force_1 -> force1_channel2) is the easy mistake this pins.
    const row = firstRowByHeader(rawStreamToCsv([point()]))
    expect(row.force1_channel1).toBe("1")
    expect(row.force1_channel2).toBe("4")
    expect(row.force2_channel1).toBe("2")
    expect(row.force2_channel2).toBe("5")
    expect(row.force3_channel1).toBe("3")
    expect(row.force3_channel2).toBe("6")
  })

  it("pins the logger column order from the wire bytes, not from DataPoint fields", () => {
    // Same bytes through both decoders: parse_cyclowatt on this payload yields
    // force = [10, 13, 11, 14, 12, 15].
    const view = new DataView(new ArrayBuffer(EXPECTED_PACKET_SIZE))
    ;[10, 11, 12, 13, 14, 15].forEach((value, slot) => view.setInt32(slot * 4, value, true))
    const parsed = parseDataPacket(view, { timestamp: new Date(0), referencePower: 0, synchronization: 0 })
    expect(parsed).not.toBeNull()

    const row = firstRowByHeader(rawStreamToCsv([parsed as DataPoint]))
    const forceColumns = RAW_CSV_HEADERS.filter((name) => name.startsWith("force"))
    expect(forceColumns.map((name) => row[name])).toEqual(["10", "13", "11", "14", "12", "15"])
  })

  it("writes cw_time as epoch seconds with exactly 3 decimals", () => {
    // The join key against the logger/SRM side: same clock as Python's
    // time.time(), never a natural-precision float like "1767225907".
    expect(firstRowByHeader(rawStreamToCsv([point({ timestamp: 1_767_225_907_000 })])).cw_time).toBe(
      "1767225907.000",
    )
  })

  it("does NOT export the chart label", () => {
    expect(rawStreamToCsv([point()])).not.toContain("05:07.3")
  })

  it("keeps samples in capture order, one row each, newline-separated", () => {
    const csv = rawStreamToCsv([point({ tick: 1 }), point({ tick: 2 }), point({ tick: 3 })])
    const rows = csv.split("\n")
    expect(rows).toHaveLength(4)
    const tickIndex = RAW_CSV_HEADERS.indexOf("tick")
    expect(rows.slice(1).map((row) => row.split(",")[tickIndex])).toEqual(["1", "2", "3"])
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
    expect(rawCsvFilename(new Date("2026-09-02T14:30:00Z"), null)).toBe("2026-09-02_cyclowatt.csv")
  })

  it("appends the firmware tag when a version is known", () => {
    // The version goes in the FILENAME only - the CSV content stays
    // byte-identical - so a bench capture is attributable to a build.
    expect(rawCsvFilename(new Date("2026-09-02T14:30:00Z"), "1.4.2")).toBe("2026-09-02_fw1.4.2_cyclowatt.csv")
  })

  it("omits the tag for an empty version string", () => {
    expect(rawCsvFilename(new Date("2026-09-02T14:30:00Z"), "")).toBe("2026-09-02_cyclowatt.csv")
  })

  it("ends in cyclowatt.csv so PAS's *cyclowatt.csv glob picks it up", () => {
    // power-analysis-suite templates/session/schema_map.json finds the CW
    // source by "file_glob": "*cyclowatt.csv"; any other ending is invisible to it.
    expect(rawCsvFilename(new Date("2026-09-02T14:30:00Z"), "1.4.2").endsWith("cyclowatt.csv")).toBe(true)
  })
})
