"use client"

/**
 * The Serial Synchronization Input card: connect a USB serial cable whose latest
 * numeric line is stamped onto every raw-stream packet as `synchronization`.
 *
 * Presentational only - the port, the reader loop and the throttled value live in
 * hooks/use-serial-sync.ts, and the page decides whether to render this at all
 * (a DFU-only session has no raw-stream packets to stamp).
 *
 * `supported` and `secure` are separate props because they mean different things
 * to the operator: a browser without Web Serial can never connect, while a page
 * served over plain HTTP could after being reloaded over HTTPS. Both only disable
 * the button here - the page's compatibility Alert is what explains them.
 */

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Cable } from "lucide-react"

export interface SerialSyncCardProps {
  supported: boolean
  secure: boolean
  connected: boolean
  latestValue: number
  onConnect: () => void
  onDisconnect: () => void
}

export function SerialSyncCard({
  supported,
  secure,
  connected,
  latestValue,
  onConnect,
  onDisconnect,
}: SerialSyncCardProps) {
  return (
    <Card className="bg-white border-gray-200">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cable className="w-5 h-5" />
          Serial Synchronization Input
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 items-center">
          {!connected ? (
            <Button onClick={onConnect} disabled={!supported || !secure} variant="outline">
              Connect Serial Port
            </Button>
          ) : (
            <Button onClick={onDisconnect} variant="outline">
              Disconnect Serial
            </Button>
          )}
          {connected && (
            <div className="text-sm text-gray-600 p-3 bg-purple-50 border border-purple-200 rounded-lg">
              <div className="font-medium">Serial Port Connected</div>
              <div>Latest Value: {latestValue}</div>
              <div className="text-xs text-gray-500 mt-1">This value is logged with each Bluetooth data packet</div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
