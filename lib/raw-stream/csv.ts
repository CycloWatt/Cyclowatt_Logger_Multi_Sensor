/**
 * The raw-stream CSV: its columns, its rows, and its filename.
 *
 * THE SCHEMA IS LOGGER-FW'S `cyclowatt.csv`. The first 17 columns are the header
 * `logger-fw/srm_cw_logger_raw.py` writes in `main()`, in the same order, with
 * the cells `parse_cyclowatt()` builds - so a bench capture taken here goes
 * through the same power-analysis-suite chain as one taken with the logger
 * (`templates/session/schema_map.json` maps exactly these names). A change on
 * the logger side is a change here; csv.test.ts pins the list.
 *
 * Header and cell live in ONE table rather than in two parallel lists, so a
 * name can never drift away from the value written under it.
 *
 * Four things a reader comparing the two files should know:
 *   - THE FORCE COLUMNS ARE PERMUTED. This app carries the six forces in wire
 *     order everywhere else (`force0..5` = amp slots, see force-channels.ts):
 *     slots 0-2 are the three sensors' normal amps, 3-5 their shear amps. The
 *     logger regroups them per sensor, `force{s}_channel{1=normal,2=shear}`,
 *     and so does this table - the same `[0,3,1,4,2,5]` as `parse_cyclowatt`.
 *   - `cw_time` is this PC's wall clock when the notification arrived, the
 *     browser's stand-in for the logger's `time.time()`. It skips the logger's
 *     dongle-to-UART hop, so against a Python-captured srm.csv expect an
 *     offset of a few ms, not zero.
 *   - `synch` has the logger's ROLE but not its values: the logger writes the
 *     CW dongle's button pin byte (0/1), this app the latest number read from
 *     the Web Serial sync cable (hooks/use-serial-sync.ts; 0 while it is not
 *     connected). Do not mix the two sources in one alignment.
 *   - `reference_power` (the trainer's power) has no logger column and is
 *     appended LAST, so every logger column keeps its position and a reader
 *     that selects by name never sees it.
 *
 * Cell formatting is deliberately plain JavaScript number-to-string: no fixed
 * decimals, no quoting, no escaping. Nothing in a DataPoint is a string or can
 * contain a comma, so there is nothing to escape - and rounding here would
 * silently lose resolution the capture actually has. The one exception is
 * `cw_time`, a join key, which uses the trainer log's fixed 3-decimal format;
 * an integer millisecond count divided by 1000 loses nothing at 3 decimals.
 * The logger's own file differs only in ways no CSV reader sees (`\r\n`
 * line ends, `1.0` where this writes `1`).
 */

import { formatEpochSeconds } from "../trainer/session-log"
import type { DataPoint } from "./packet"

interface RawCsvColumn {
  header: string
  cell: (point: DataPoint) => string | number
}

const RAW_CSV_COLUMNS: readonly RawCsvColumn[] = [
  { header: "cw_time", cell: (p) => formatEpochSeconds(p.timestamp) },
  { header: "force1_channel1", cell: (p) => p.force0 }, // sensor 1 normal (wire slot 0)
  { header: "force1_channel2", cell: (p) => p.force3 }, // sensor 1 shear  (wire slot 3)
  { header: "force2_channel1", cell: (p) => p.force1 }, // sensor 2 normal (wire slot 1)
  { header: "force2_channel2", cell: (p) => p.force4 }, // sensor 2 shear  (wire slot 4)
  { header: "force3_channel1", cell: (p) => p.force2 }, // sensor 3 normal (wire slot 2)
  { header: "force3_channel2", cell: (p) => p.force5 }, // sensor 3 shear  (wire slot 5)
  { header: "accel_x", cell: (p) => p.accelX },
  { header: "accel_y", cell: (p) => p.accelY },
  { header: "accel_z", cell: (p) => p.accelZ },
  { header: "gyro_x", cell: (p) => p.gyroX },
  { header: "gyro_y", cell: (p) => p.gyroY },
  { header: "gyro_z", cell: (p) => p.gyroZ },
  { header: "power", cell: (p) => p.power },
  { header: "tick", cell: (p) => p.tick },
  { header: "tick_mcu", cell: (p) => p.ticksMcu },
  { header: "synch", cell: (p) => p.synchronization },
  { header: "reference_power", cell: (p) => p.referencePower },
]

export const RAW_CSV_HEADERS: readonly string[] = RAW_CSV_COLUMNS.map((column) => column.header)

/** The whole file body: header line, then one line per sample in capture order. */
export function rawStreamToCsv(points: readonly DataPoint[]): string {
  return [
    RAW_CSV_HEADERS.join(","),
    ...points.map((point) => RAW_CSV_COLUMNS.map((column) => column.cell(point)).join(",")),
  ].join("\n")
}

/**
 * `<YYYY-MM-DD>[_fw<version>]_cyclowatt.csv`.
 *
 * It ENDS in `cyclowatt.csv` because that is how power-analysis-suite finds the
 * CW source in a take folder (`"file_glob": "*cyclowatt.csv"`), so a download
 * can be dropped next to the logger's files without a rename.
 *
 * The date is the UTC calendar day (the ISO string's date part), and the
 * firmware version is stamped into the FILENAME only - the CSV content stays
 * byte-identical - so a bench capture is attributable to a build.
 */
export function rawCsvFilename(date: Date, fwVersion: string | null): string {
  const timestampPart = date.toISOString().split("T")[0]
  const versionTag = fwVersion ? `_fw${fwVersion}` : ""
  return `${timestampPart}${versionTag}_cyclowatt.csv`
}
