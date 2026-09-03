/**
 * The raw-stream CSV: its columns, its rows, and its filename.
 *
 * Moved out of app/page.tsx unchanged. The reason this is its own module rather
 * than inline in the export handler is that the COLUMN SET is a published
 * interface - bench analysis scripts select `force_0`, `ticks_mcu`,
 * `reference_power` and friends by name - while the handler around it is nothing
 * but the Blob/anchor download dance, which cannot run outside a browser. Split
 * that way, the part that must not drift is the part under test.
 *
 * Cell formatting is deliberately plain `Array.join(",")` over numbers, i.e.
 * JavaScript's default number-to-string: no fixed decimals, no quoting, no
 * escaping. Nothing in a DataPoint is a string or can contain a comma, so there
 * is nothing to escape - and rounding here would silently lose resolution the
 * capture actually has.
 */

import type { DataPoint } from "./packet"

export const RAW_CSV_HEADERS: readonly string[] = [
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
]

/** The whole file body: header line, then one line per sample in capture order. */
export function rawStreamToCsv(points: readonly DataPoint[]): string {
  return [
    RAW_CSV_HEADERS.join(","),
    ...points.map((point) =>
      [
        point.tick,
        point.ticksMcu,
        point.force0,
        point.force1,
        point.force2,
        point.force3,
        point.force4,
        point.force5,
        point.accelX,
        point.accelY,
        point.accelZ,
        point.gyroX,
        point.gyroY,
        point.gyroZ,
        point.power,
        point.referencePower,
        point.synchronization,
      ].join(","),
    ),
  ].join("\n")
}

/**
 * `cyclowatt_data_<YYYY-MM-DD>[_fw<version>].csv`.
 *
 * The date is the UTC calendar day (the ISO string's date part), and the
 * firmware version is stamped into the FILENAME only - the CSV content stays
 * byte-identical - so a bench capture is attributable to a build.
 */
export function rawCsvFilename(date: Date, fwVersion: string | null): string {
  const timestampPart = date.toISOString().split("T")[0]
  const versionTag = fwVersion ? `_fw${fwVersion}` : ""
  return `cyclowatt_data_${timestampPart}${versionTag}.csv`
}
