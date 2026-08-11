"use client"

/**
 * Bench status panel: reads the SMP image list on demand (running version,
 * slot hashes, confirmed/pending flags) and offers a remote reboot — the same
 * OS-group reset the DFU flow already uses. Opens a short-lived SMP client per
 * action so it never holds the characteristic while a flash flow runs.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
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
      {slots.map((slot, index) => (
        // A device with several images can report the same slot number twice
        // (one pair per image), so the slot number alone is not a unique key.
        <div key={`${slot.slot}-${index}`} className="text-sm">
          slot {slot.slot}: v{slot.version}
          {slot.active ? " · running" : ""}
          {slot.confirmed ? " · confirmed" : ""}
          {slot.pending ? " · pending" : ""}
          <span className="text-muted-foreground"> · {toHex(slot.hash).slice(0, 12)}…</span>
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
