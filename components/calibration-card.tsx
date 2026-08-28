"use client"

/**
 * Zero-offset force calibration from the bench.
 *
 * Starts the SAME procedure a head unit starts - the SIG's Start Offset
 * Compensation on the Cycling Power Control Point - so nothing here is a bench
 * back door; it is the standard path driven from a browser. The protocol lives in
 * lib/cps/, this file is only the UI around it.
 *
 * The per-channel detail is a SECOND, separate read, from lib/raw-stream/. The
 * Control Point response carries exactly one value, so the standard procedure can
 * only ever report the average; the board serves all six channels on a vendor
 * characteristic alongside it. That read is deliberately allowed to fail without
 * failing the calibration - by the time it runs the calibration has already
 * succeeded and been saved on the board.
 *
 * Placed in the streaming tab rather than the firmware tab because calibration is
 * a SENSOR operation. It is deliberately available in either connection mode
 * though: a production image has no raw-stream service, so such a board reaches
 * this page only through the firmware-update-only connect - and, for the same
 * reason, reports the average with no per-channel detail behind it.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { runOffsetCompensation } from "@/lib/cps/calibration"
import { readForceOffsets, type ForceOffsetsReport } from "@/lib/raw-stream/force-offsets"
import { forceChannelLabel } from "@/lib/raw-stream/force-channels"

/**
 * One observed board state, handed upward to be logged.
 *
 * Carries no identity and no timestamp on purpose: the PAGE owns both. The name
 * this card could reach is `device.name`, which Chrome freezes at grant time and
 * never refreshes, so a card that stamped its own records would quietly file
 * every reading under a stale board name.
 */
export interface CalibrationReading {
  calibrated: boolean
  offsetsMv: number[]
  /** The per-sensor average in Newtons from the Control Point response. */
  avgOffsetN: number
}

interface CalibrationCardProps {
  device: BluetoothDevice | null
  /** True while a firmware flash is running - the board must not be interrupted. */
  busy?: boolean
  /**
   * Called once per calibration that produced per-channel values.
   *
   * NOT called when the board serves no per-channel detail (a production image):
   * a history row of six blanks records nothing worth keeping, and the card says
   * so on screen instead.
   */
  onReading?: (reading: CalibrationReading) => void
}

/**
 * A failure must not read like a confirmation, so the message carries its own
 * kind and errors render destructive - the same split device-panel.tsx makes.
 */
type CalibrationMessage = { kind: "info" | "error"; text: string }

export function CalibrationCard({ device, busy = false, onReading }: CalibrationCardProps) {
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<CalibrationMessage | null>(null)
  const [offsets, setOffsets] = useState<ForceOffsetsReport | null>(null)
  /** Set when the calibration succeeded but the per-channel detail did not arrive. */
  const [offsetsNote, setOffsetsNote] = useState<string | null>(null)

  async function calibrate() {
    setRunning(true)
    // Clear the previous result up front. Leaving the last run's offset on screen
    // while a new one collects would read as this run's answer.
    setMessage(null)
    setOffsets(null)
    setOffsetsNote(null)
    try {
      const offsetNewtons = await runOffsetCompensation(device)
      setMessage({
        kind: "info",
        text: `Calibrated. Average offset ${offsetNewtons} N per sensor, saved on the board.`,
      })

      /*
       * The per-channel detail is a SEPARATE read, and a second-class one: the
       * calibration has already succeeded and been saved on the board by the time
       * we get here, so nothing this read does may turn a successful run into a
       * failure. Its own try/catch is what guarantees that - without it, a board
       * that legitimately has no such characteristic would report the calibration
       * itself as failed.
       */
      try {
        const report = await readForceOffsets(device)
        if (report) {
          setOffsets(report)
          // Logged only on this branch: see onReading's contract. The average
          // comes from the procedure response, which only a RUN ever sees.
          onReading?.({ ...report, avgOffsetN: offsetNewtons })
        } else {
          setOffsetsNote(
            "Per-channel detail needs a data-acquisition image; this board reports the average only.",
          )
        }
      } catch (err) {
        setOffsetsNote(
          `Calibration succeeded, but reading the per-channel detail failed: ${
            err instanceof Error ? err.message : "unknown error"
          }`,
        )
      }
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "calibration failed" })
    } finally {
      setRunning(false)
    }
  }

  const disabled = !device || busy || running

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Force calibration</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/*
          Stated before the button, not after: this is a ZERO-offset tare, so a
          load present during the window is averaged INTO the offset and quietly
          corrupts every later power reading. There is no way to detect that after
          the fact, which makes the instruction part of the procedure.
        */}
        <p className="text-sm text-muted-foreground">
          Take all load off the pedals and keep the cranks still. The board averages ~2.5 s of
          unloaded readings and stores the result as its zero point.
        </p>

        <Button size="sm" variant="outline" disabled={disabled} onClick={() => void calibrate()}>
          {running ? "Calibrating..." : "Calibrate zero offset"}
        </Button>

        {running && (
          <div className="text-sm font-medium text-amber-700">
            Collecting samples - keep the cranks unloaded and still.
          </div>
        )}

        {!device && <div className="text-sm text-muted-foreground">Connect to a sensor first.</div>}

        {message && (
          <div className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {message.text}
          </div>
        )}

        {offsets && (
          <div className="space-y-1">
            <div className="text-sm font-medium">Per-channel zero offsets</div>

            {/*
              Not a decoration: six zeros from a board that was never calibrated
              look exactly like a genuine zero result, and only this flag tells
              them apart. Rendered destructive because reading uncalibrated
              defaults as a measurement is the expensive mistake here.
            */}
            {!offsets.calibrated && (
              <div className="text-sm text-destructive">
                The board reports no stored calibration - these are uncalibrated defaults.
              </div>
            )}

            <table className="text-sm">
              <tbody>
                {offsets.offsetsMv.map((mv, channel) => (
                  <tr key={channel}>
                    {/*
                      Named from the SAME table the streaming force charts use, so
                      the two screens name a channel identically. That was the point
                      of the even/odd rule this replaced too - it just named four of
                      the six wrong, on both screens at once.
                    */}
                    <td className="pr-4 text-muted-foreground">{forceChannelLabel(channel)}</td>
                    <td className="tabular-nums text-right">{mv} mV</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {offsetsNote && <div className="text-sm text-muted-foreground">{offsetsNote}</div>}

        {message?.kind === "error" && (
          // The single most likely failure on this bench, and the one whose error
          // text ("Origin is not allowed to access the service") explains nothing
          // to an operator. Chrome scopes service access to what was declared when
          // the board was picked, so a grant older than the Cycling Power entry in
          // optionalServices cannot reach the Control Point at all.
          <div className="text-sm text-muted-foreground">
            If this mentions a security or permission error, re-pick the board once through Scan -
            that rebuilds the grant with the Cycling Power service in it.
          </div>
        )}
      </CardContent>
    </Card>
  )
}
