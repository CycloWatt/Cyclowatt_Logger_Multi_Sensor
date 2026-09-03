/**
 * The Trainer tab's session log: one row per Indoor Bike Data notification
 * (a "sample") plus sparse operator/protocol events, held in memory for the
 * duration of a session and exported together as a single CSV.
 *
 * Samples and events share one file rather than two. The CSV's whole reason
 * to exist is time-correlation with a separate Python logger, whose own CSV
 * carries a `cw_time` column that is Python `time.time()` - a float epoch
 * seconds, PC wall clock. Joining the two is a `merge_asof` on that one key,
 * and a static export page cannot fire two downloads from a single click
 * anyway. So every row here - sample or event - carries the same `epoch_s`,
 * and a reader tells the two kinds apart by which columns are blank.
 *
 * `epoch_s` is the one format that must be exact, because it is the join key.
 * Everything else (iso_time, elapsed_s) is for a human skimming the file.
 */

/** How the trainer is currently being driven. */
export type TrainerMode = "protocol" | "manual-power" | "manual-resistance"

/** One Indoor Bike Data notification, decorated with session context. */
export interface SampleRow {
  epochMs: number
  elapsedS: number
  mode: TrainerMode
  protocolName: string
  stepIndex: number | null
  stepTargetW: number | null
  targetResistancePct: number | null
  powerW: number | null
  cadenceRpm: number | null
  speedKmh: number | null
  hrBpm: number | null
}

/**
 * What happened. Deliberately a closed set rather than a free-text field, so
 * a later reader can filter/group on it without first discovering the
 * vocabulary by scanning the whole file.
 */
export type LogEventKind =
  | "session-start"
  | "connected"
  | "disconnected"
  | "step-started"
  | "paused"
  | "resumed"
  | "stopped"
  | "finished"
  | "target-set"
  | "control-result"
  | "control-lost"
  | "status"

/** A sparse, human-readable marker: what happened and (optionally) detail. */
export interface EventRow {
  epochMs: number
  elapsedS: number
  mode: TrainerMode
  protocolName: string
  stepIndex: number | null
  event: LogEventKind
  detail: string
}

/** The whole in-memory log for one session. */
export interface SessionLog {
  startedAtMs: number
  samples: SampleRow[]
  events: EventRow[]
}

export function createSessionLog(startedAtMs: number): SessionLog {
  return { startedAtMs, samples: [], events: [] }
}

/**
 * Mutating push, matching how the caller holds this: a React ref (like
 * dataBufferRef in page.tsx), appended to on every notification without a
 * re-render, and read out only when the session ends or exports.
 */
export function appendSample(log: SessionLog, row: SampleRow): void {
  log.samples.push(row)
}

/** See appendSample - same reasoning, the sparse event stream. */
export function appendEvent(log: SessionLog, row: EventRow): void {
  log.events.push(row)
}

/** Column order of the exported CSV. Also its header row. */
export const SESSION_CSV_COLUMNS = [
  "epoch_s",
  "iso_time",
  "elapsed_s",
  "event",
  "event_detail",
  "mode",
  "protocol_name",
  "step_index",
  "step_target_w",
  "target_resistance_pct",
  "power_w",
  "cadence_rpm",
  "speed_kmh",
  "hr_bpm",
] as const

/**
 * The join key for the Python logger's `cw_time` column: `epochMs / 1000` to
 * exactly 3 decimals, e.g. `1756800000123` -> `"1756800000.123"`. Fixed
 * decimals rather than a natural-precision float so every row in the file
 * lines up in a text diff and no downstream parser has to guess how many
 * digits to expect.
 */
export function formatEpochSeconds(epochMs: number): string {
  return (epochMs / 1000).toFixed(3)
}

/**
 * Quote one CSV cell.
 *
 * Copied from lib/calibration-history.ts (private there) rather than
 * exported and imported, per the task brief - it is three lines, and pulling
 * a whole module dependency across for it would outweigh just repeating it.
 */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** null -> blank cell; otherwise the plain string form of the number. */
function numCell(value: number | null): string {
  return value === null ? "" : String(value)
}

/**
 * Samples and events merged, sorted by epochMs ascending (stable; on a tie
 * the sample comes before the event). Sample rows leave event/event_detail
 * blank; event rows leave the measurement columns (step_target_w..hr_bpm)
 * blank. null -> blank cell. elapsed_s with 3 decimals. Text cells quoted via
 * csvCell when they contain , " or newline. Header row first, trailing
 * newline.
 *
 * The tie-break is why this is not a plain concatenate-then-sort: a
 * comparator that only orders by epochMs would leave same-millisecond rows in
 * whatever order they happened to be concatenated in, and a sample and an
 * event landing in the same millisecond is exactly the case a reader most
 * wants the sample to anchor.
 */
export function sessionLogToCsv(log: SessionLog): string {
  type Tagged = { epochMs: number; kind: 0 | 1; line: string }

  const sampleLine = (row: SampleRow): string =>
    [
      formatEpochSeconds(row.epochMs),
      new Date(row.epochMs).toISOString(),
      row.elapsedS.toFixed(3),
      "", // event
      "", // event_detail
      csvCell(row.mode),
      csvCell(row.protocolName),
      numCell(row.stepIndex),
      numCell(row.stepTargetW),
      numCell(row.targetResistancePct),
      numCell(row.powerW),
      numCell(row.cadenceRpm),
      numCell(row.speedKmh),
      numCell(row.hrBpm),
    ].join(",")

  const eventLine = (row: EventRow): string =>
    [
      formatEpochSeconds(row.epochMs),
      new Date(row.epochMs).toISOString(),
      row.elapsedS.toFixed(3),
      csvCell(row.event),
      csvCell(row.detail),
      csvCell(row.mode),
      csvCell(row.protocolName),
      numCell(row.stepIndex),
      "", // step_target_w
      "", // target_resistance_pct
      "", // power_w
      "", // cadence_rpm
      "", // speed_kmh
      "", // hr_bpm
    ].join(",")

  const tagged: Tagged[] = [
    ...log.samples.map((row): Tagged => ({ epochMs: row.epochMs, kind: 0, line: sampleLine(row) })),
    ...log.events.map((row): Tagged => ({ epochMs: row.epochMs, kind: 1, line: eventLine(row) })),
  ]

  tagged.sort((a, b) => a.epochMs - b.epochMs || a.kind - b.kind)

  return [SESSION_CSV_COLUMNS.join(","), ...tagged.map((t) => t.line)].join("\n") + "\n"
}

/** Two digits, zero-padded - for the local-time pieces of the filename. */
function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/**
 * `kickr_<slug>_<YYYY-MM-DD>_<HHMMSS>.csv` in LOCAL time.
 *
 * Local time, not UTC or epoch: this is the name a person sees in a
 * downloads folder and picks a file by, on the same PC whose clock the
 * epoch_s column is timestamped against.
 *
 * slug: protocolName lowercased, runs of non [a-z0-9] collapsed to a single
 * "-", trimmed of leading/trailing "-". A manual-power or manual-resistance
 * session (no protocol name) or a protocol name that is nothing but
 * punctuation both fall back to "session" rather than producing a filename
 * ending in "kickr__2026-...".
 */
export function sessionLogFilename(protocolName: string, startedAtMs: number): string {
  const slugged = protocolName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const slug = slugged === "" ? "session" : slugged

  const d = new Date(startedAtMs)
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`

  return `kickr_${slug}_${date}_${time}.csv`
}
