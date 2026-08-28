"use client"

/**
 * The stored force-calibration readings for this browser.
 *
 * Its own card rather than more of calibration-card.tsx, which already carries a
 * procedure, its instructions and its failure modes. This one only displays what
 * lib/calibration-history.ts holds and offers the three things you can do to it:
 * export, delete one, delete all.
 *
 * Presentational on purpose - the log is OWNED by the page, because two separate
 * things write to it (a calibration run in the other card, and the connect-time
 * read). A card that read localStorage itself would show a stale table whenever
 * the other writer moved.
 */

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  calibrationHistoryToCsv,
  type CalibrationRecord,
} from "@/lib/calibration-history"

interface CalibrationHistoryCardProps {
  records: CalibrationRecord[]
  /** Drop one reading. */
  onDelete: (id: string) => void
  /** Drop every reading. */
  onClear: () => void
}

/**
 * Local date and time, seconds included.
 *
 * Seconds matter here: two calibrations during one bench check land in the same
 * minute, and a table where both read "14:32" cannot be put in order by eye.
 */
function formatWhen(recordedAt: number): string {
  return new Date(recordedAt).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

/**
 * Hand the CSV to the browser as a download.
 *
 * Built as an object URL rather than a data: URI because a long log would exceed
 * what some browsers accept in a URL, and revoked immediately after the click so
 * the blob is not held for the life of the page.
 */
function downloadCsv(records: CalibrationRecord[]): void {
  const blob = new Blob([calibrationHistoryToCsv(records)], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")

  // Date only, so repeated exports on one day overwrite rather than accumulate
  // a pile of near-identical files in the downloads folder.
  anchor.href = url
  anchor.download = `cyclowatt-calibrations-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()

  URL.revokeObjectURL(url)
}

export function CalibrationHistoryCard({
  records,
  onDelete,
  onClear,
}: CalibrationHistoryCardProps) {
  const empty = records.length === 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Calibration history</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {empty && (
          <p className="text-sm text-muted-foreground">
            No readings yet. Connecting to a board records what it already has stored, and every
            calibration you run is added here.
          </p>
        )}

        {!empty && (
          <>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => downloadCsv(records)}>
                Download CSV
              </Button>
              <Button size="sm" variant="ghost" onClick={onClear}>
                Clear all
              </Button>
            </div>

            {/*
              Scrolls inside its own box: the log caps at 200 entries and a table
              that long would push everything below it off the page.
            */}
            <div className="max-h-96 overflow-auto">
              <table className="text-sm w-full">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="pr-3 font-medium">When</th>
                    <th className="pr-3 font-medium">Sensor</th>
                    <th className="pr-3 font-medium">Kind</th>
                    {Array.from({ length: 6 }, (_, channel) => (
                      <th key={channel} className="pr-3 font-medium text-right">
                        ch{channel}
                      </th>
                    ))}
                    <th className="pr-3 font-medium text-right">Avg N</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr key={record.id} className="border-t">
                      <td className="pr-3 whitespace-nowrap tabular-nums">
                        {formatWhen(record.recordedAt)}
                      </td>
                      <td className="pr-3 whitespace-nowrap">{record.deviceName}</td>
                      <td className="pr-3 whitespace-nowrap">
                        {record.kind === "calibration" ? "calibrated" : "read"}
                        {/*
                          A board with no stored calibration reports six zeros,
                          which look exactly like a genuine zero result. Flagged
                          on the row itself because in a table of numbers the
                          distinction is invisible otherwise.
                        */}
                        {!record.calibrated && (
                          <span className="text-destructive"> (none stored)</span>
                        )}
                      </td>
                      {Array.from({ length: 6 }, (_, channel) => (
                        <td key={channel} className="pr-3 text-right tabular-nums">
                          {record.offsetsMv[channel] ?? ""}
                        </td>
                      ))}
                      <td className="pr-3 text-right tabular-nums">
                        {record.avgOffsetN ?? ""}
                      </td>
                      <td className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="Delete this reading"
                          onClick={() => onDelete(record.id)}
                        >
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Units are stated once, here, rather than repeated in every cell. */}
            <p className="text-xs text-muted-foreground">
              Channel values are raw millivolts. Times are this computer&apos;s clock - the board has
              no clock of its own.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
