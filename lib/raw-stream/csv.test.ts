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
  // Distinct from every other cell, so a mix-up with any column shows.
  synchronization: 8,
  ...over,
})

/** The cells of the first data row, keyed by header - so a test reads a column by NAME. */
const firstRowByHeader = (csv: string): Record<string, string> => {
  const [header, row] = csv.split("\n")
  const cells = row.split(",")
  return Object.fromEntries(header.split(",").map((name, i) => [name, cells[i]]))
}

describe("RAW_CSV_HEADERS", () => {
  it("is logger-fw's 17 cyclowatt.csv columns, then reference_power and serial_input", () => {
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
      "serial_input",
    ])
  })
})

describe("rawStreamToCsv", () => {
  it("starts with the header line", () => {
    expect(rawStreamToCsv([point()]).split("\n")[0]).toBe(RAW_CSV_HEADERS.join(","))
  })

  it("writes one row per sample with the 19 cells in header order", () => {
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
      "0",
      "150",
      "8",
    ])
  })

  it("writes synch as 0 whatever the serial input reads", () => {
    // There is no sync event at the dashboard. PAS anchors time_cw_sync_s on
    // the FIRST 0 -> non-zero step in synch (preprocess_map.json,
    // self_rising_flag), so any non-zero value here would be taken for one and
    // silently mis-anchor the take. A constant 0 makes PAS fail loudly instead.
    const csv = rawStreamToCsv([
      point({ synchronization: 0 }),
      point({ synchronization: 5 }),
      point({ synchronization: -2.5 }),
    ])
    const rows = csv.split("\n").slice(1).map((row) => row.split(","))
    const synchIndex = RAW_CSV_HEADERS.indexOf("synch")
    const serialIndex = RAW_CSV_HEADERS.indexOf("serial_input")
    expect(rows.map((cells) => cells[synchIndex])).toEqual(["0", "0", "0"])
    // The serial reading itself is kept, under a name PAS does not map.
    expect(rows.map((cells) => cells[serialIndex])).toEqual(["0", "5", "-2.5"])
  })

  it("names no extra column so that it contains the substring sync", () => {
    // PAS's find_column (adapters/common.py) falls back to a SUBSTRING match
    // when the exact name is missing; a dashboard-only column containing
    // "synch" would then be read as the sync flag. Checked on the broader
    // "sync" so a future alias spelled that way is covered too.
    const extras = RAW_CSV_HEADERS.slice(17)
    expect(extras.filter((name) => name.toLowerCase().includes("sync"))).toEqual([])
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

  it("writes the row logger-fw parse_cyclowatt writes for the same wire bytes", () => {
    // All 16 slots distinct, negative forces, a tick_mcu high word. The expected
    // cells are parse_cyclowatt's output on these bytes plus a trailing pin byte
    // of 0 (it takes 65; 0 = sync button never pressed, which is what the
    // dashboard always writes), recorded 2026-10-20 by running logger-fw's Python.
    const slots = [1201, -1302, 1403, -1504, 1605, -1706, 12, -998, 1003, -250, 4, 31416, 0, 77, 0x89abcdef | 0, 3]
    const view = new DataView(new ArrayBuffer(EXPECTED_PACKET_SIZE))
    slots.forEach((value, slot) => view.setInt32(slot * 4, value, true))
    const parsed = parseDataPacket(view, {
      timestamp: new Date(1_767_225_907_300),
      referencePower: 250,
      synchronization: 1,
    })
    expect(parsed).not.toBeNull()

    const cells = rawStreamToCsv([parsed as DataPoint]).split("\n")[1].split(",")
    expect(cells).toEqual([
      "1767225907.300",
      "1201",
      "-1504",
      "-1302",
      "1605",
      "1403",
      "-1706",
      "0.012",
      "-0.998",
      "1.003",
      "-0.25",
      "0.004",
      "31.416",
      "0",
      "77",
      "15194639855",
      "0",
      "250",
      "1",
    ])
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
  // Local-time constructor, so the expectations hold in any test timezone.
  const at = new Date(2026, 8, 2, 14, 30, 5)

  it("stamps the local date and time of day", () => {
    expect(rawCsvFilename(at, null)).toBe("2026-09-02_143005_cyclowatt.csv")
  })

  it("zero-pads every date and time field", () => {
    expect(rawCsvFilename(new Date(2026, 0, 3, 4, 5, 6), null)).toBe("2026-01-03_040506_cyclowatt.csv")
  })

  it("appends the firmware tag when a version is known", () => {
    // The version goes in the FILENAME only - the CSV content stays
    // byte-identical - so a bench capture is attributable to a build.
    expect(rawCsvFilename(at, "1.4.2")).toBe("2026-09-02_143005_fw1.4.2_cyclowatt.csv")
  })

  it("omits the tag for an empty version string", () => {
    expect(rawCsvFilename(at, "")).toBe("2026-09-02_143005_cyclowatt.csv")
  })

  it("ends in cyclowatt.csv so PAS's *cyclowatt.csv glob picks it up", () => {
    // power-analysis-suite templates/session/schema_map.json finds the CW
    // source by "file_glob": "*cyclowatt.csv"; any other ending is invisible to it.
    expect(rawCsvFilename(at, "1.4.2").endsWith("cyclowatt.csv")).toBe(true)
  })

  it("names two exports of the same day differently", () => {
    // Same name twice makes the browser save "..._cyclowatt (1).csv", which
    // the glob above no longer matches.
    expect(rawCsvFilename(new Date(2026, 8, 2, 9, 0, 0), null)).not.toBe(
      rawCsvFilename(new Date(2026, 8, 2, 16, 45, 0), null),
    )
  })
})
