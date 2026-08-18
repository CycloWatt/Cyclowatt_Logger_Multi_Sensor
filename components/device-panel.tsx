"use client"

/**
 * Bench status panel: reads the SMP image list on demand (running version,
 * slot hashes, confirmed/pending flags) and offers a remote reboot — the same
 * OS-group reset the DFU flow already uses. Opens a short-lived SMP client per
 * action so it never holds the characteristic while a flash flow runs.
 *
 * It also answers "is an update running?" on the line above the buttons, via
 * describeDfuActivity - which combines the in-flight flag this panel already
 * receives with the image flags it already reads. Under safe boot an update is
 * still underway after the upload ends (staged for the next boot, or running its
 * unconfirmed trial), and neither state was visible here before.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { describeDfuActivity } from "@/lib/dfu-status"
import { openSmpClient } from "@/lib/smp/gatt"
import type { ImageSlotState } from "@/lib/smp/client"

interface DevicePanelProps {
  device: BluetoothDevice | null
  busy: boolean
}

/**
 * A failure must not read like a confirmation on a bench panel, so the message
 * carries its own kind and errors render in the destructive colour — the same
 * split the image picker makes between a rejected pick and an informational note.
 */
type PanelMessage = { kind: "info" | "error"; text: string }

export function DevicePanel({ device, busy }: DevicePanelProps) {
  const [slots, setSlots] = useState<ImageSlotState[]>([])
  const [message, setMessage] = useState<PanelMessage | null>(null)

  /** Attach, run one action, and always detach — the client never outlives the click. */
  async function withClient(run: (client: Awaited<ReturnType<typeof openSmpClient>>) => Promise<void>) {
    if (!device) return
    const client = await openSmpClient(device)
    try {
      await run(client)
    } finally {
      client.dispose()
    }
  }

  async function refresh() {
    try {
      await withClient(async (client) => setSlots(await client.imageStateRead()))
      setMessage(null)
    } catch (err) {
      // Clear the listing too: a read that died mid-way (dropped link, SMP
      // timeout) would otherwise leave the PREVIOUS slot rows on screen, which
      // reads as a current bench state next to nothing but an error line.
      setSlots([])
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "image state read failed" })
    }
  }

  async function reboot() {
    try {
      await withClient((client) => client.reset())
      // The listing describes a device that is now rebooting — drop it rather
      // than leave stale slot rows on screen.
      setSlots([])
      setMessage({
        kind: "info",
        text: "Reboot sent — the device drops the link and restarts (~a few seconds).",
      })
    } catch (err) {
      setSlots([])
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "reboot failed" })
    }
  }

  const disabled = !device || busy
  // Whether an update is underway, from the in-flight flag this panel already
  // receives plus the image flags it already reads. `busy` was previously used
  // only to grey the buttons out, never to say why.
  const activity = describeDfuActivity(slots, busy)
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => void refresh()}>
          Read image state
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => void reboot()}>
          Reboot device
        </Button>
      </div>
      {activity.text && (
        // An update in progress is a warning-coloured statement of fact, not an
        // error: a staged or on-trial image is a normal, temporary bench state,
        // but one a reader must not mistake for a settled board.
        <div className={activity.running ? "text-sm font-medium text-amber-700" : "text-sm text-muted-foreground"}>
          {activity.text}
        </div>
      )}
      {slots.map((slot, index) => (
        // A device with several images can report the same slot number twice
        // (one pair per image), so the slot number alone is not a unique key.
        <div key={`${slot.slot}-${index}`} className="text-sm">
          slot {slot.slot}: v{slot.version}
          {slot.active ? " - running" : ""}
          {slot.confirmed ? " - confirmed" : ""}
          {slot.pending ? " - pending" : ""}
          {/*
            Both of these were parsed and then dropped on the floor. "not bootable"
            is the interesting direction - a slot holding an image MCUboot has
            rejected looks identical to an empty one without it.
          */}
          {slot.bootable ? "" : " - not bootable"}
          {slot.permanent ? " - permanent" : ""}
          <span className="text-muted-foreground"> - {toHex(slot.hash).slice(0, 12)}...</span>
        </div>
      ))}
      {message && (
        <div className={message.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {message.text}
        </div>
      )}
    </div>
  )
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}
