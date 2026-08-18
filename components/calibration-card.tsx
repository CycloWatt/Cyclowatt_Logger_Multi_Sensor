"use client"

/**
 * Zero-offset force calibration from the bench.
 *
 * Starts the SAME procedure a head unit starts - the SIG's Start Offset
 * Compensation on the Cycling Power Control Point - so nothing here is a bench
 * back door; it is the standard path driven from a browser. The protocol lives in
 * lib/cps/, this file is only the UI around it.
 *
 * Placed in the streaming tab rather than the firmware tab because calibration is
 * a SENSOR operation. It is deliberately available in either connection mode
 * though: a production image has no raw-stream service, so such a board reaches
 * this page only through the firmware-update-only connect.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { runOffsetCompensation } from "@/lib/cps/calibration"

interface CalibrationCardProps {
  device: BluetoothDevice | null
  /** True while a firmware flash is running - the board must not be interrupted. */
  busy?: boolean
}

/**
 * A failure must not read like a confirmation, so the message carries its own
 * kind and errors render destructive - the same split device-panel.tsx makes.
 */
type CalibrationMessage = { kind: "info" | "error"; text: string }

export function CalibrationCard({ device, busy = false }: CalibrationCardProps) {
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<CalibrationMessage | null>(null)

  async function calibrate() {
    setRunning(true)
    // Clear the previous result up front. Leaving the last run's offset on screen
    // while a new one collects would read as this run's answer.
    setMessage(null)
    try {
      const offsetNewtons = await runOffsetCompensation(device)
      setMessage({
        kind: "info",
        text: `Calibrated. Average offset ${offsetNewtons} N per sensor, saved on the board.`,
      })
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
