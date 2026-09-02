"use client"

/**
 * The "Trainer connection" card: chooser buttons, the name/Connected/Control/
 * ERG/Resistance badges, the power-and-resistance range line, and the two
 * capability hints (no Web Bluetooth, unknown Feature characteristic).
 *
 * Purely presentational, moved verbatim out of trainer-panel.tsx - every
 * className, string and `disabled` expression is unchanged; the panel still
 * owns bluetoothAvailable/connecting/hasDevice/etc. and the four connect/
 * reconnect/disconnect/take-control calls, just wired through callbacks here.
 */

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { FtmsCapabilities } from "@/lib/ftms/control"
import type { FtmsFeatures, SupportedRange } from "@/lib/ftms/protocol"

export interface TrainerConnectionCardProps {
  bluetoothAvailable: boolean
  connecting: boolean
  hasDevice: boolean
  connected: boolean
  hasControl: boolean
  /** Always a string: the controller falls back to "Trainer", and "" before a pick. */
  deviceName: string
  capabilities: FtmsCapabilities | null
  powerRange: SupportedRange
  resistanceRange: SupportedRange
  features: FtmsFeatures | null
  ergUnsupported: boolean
  resistanceUnsupported: boolean
  onConnect: () => void
  onReconnect: () => void
  onDisconnect: () => void
  onTakeControl: () => void
}

export function TrainerConnectionCard({
  bluetoothAvailable,
  connecting,
  hasDevice,
  connected,
  hasControl,
  deviceName,
  capabilities,
  powerRange,
  resistanceRange,
  features,
  ergUnsupported,
  resistanceUnsupported,
  onConnect,
  onReconnect,
  onDisconnect,
  onTakeControl,
}: TrainerConnectionCardProps) {
  return (
    <Card className="bg-white border-gray-200">
      <CardHeader>
        <CardTitle>Trainer connection</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {!hasDevice && (
            <Button onClick={onConnect} disabled={!bluetoothAvailable || connecting}>
              {connecting ? "Connecting…" : "Connect trainer"}
            </Button>
          )}
          {hasDevice && !connected && (
            <Button onClick={onReconnect} disabled={!bluetoothAvailable || connecting}>
              {connecting ? "Reconnecting…" : "Reconnect"}
            </Button>
          )}
          {hasDevice && (
            <Button variant="outline" onClick={onDisconnect} disabled={connecting}>
              Disconnect
            </Button>
          )}
          {connected && !hasControl && (
            <Button variant="outline" onClick={onTakeControl}>
              Take Control
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-gray-900">{deviceName || "No trainer"}</span>
          <Badge variant={connected ? "default" : "secondary"}>{connected ? "Connected" : "Disconnected"}</Badge>
          <Badge variant={hasControl ? "default" : "secondary"}>{hasControl ? "Control" : "No control"}</Badge>
          <Badge variant={ergUnsupported ? "destructive" : "secondary"}>
            {features === null ? "ERG: unknown" : ergUnsupported ? "ERG unsupported" : "ERG supported"}
          </Badge>
          <Badge variant={resistanceUnsupported ? "destructive" : "secondary"}>
            {features === null
              ? "Resistance: unknown"
              : resistanceUnsupported
                ? "Resistance unsupported"
                : "Resistance supported"}
          </Badge>
          {capabilities && (
            <span className="text-gray-500">
              power {powerRange.min}–{powerRange.max} W (step {powerRange.increment} W), resistance{" "}
              {resistanceRange.min / 10}–{Math.min(resistanceRange.max, 0xff) / 10}
            </span>
          )}
        </div>

        {!bluetoothAvailable && (
          <p className="text-xs text-gray-500">
            Web Bluetooth needs a supporting browser (Chrome or Edge) over HTTPS or localhost.
          </p>
        )}
        {features === null && connected && (
          <p className="text-xs text-gray-500">
            This trainer did not publish its Fitness Machine Feature characteristic, so ERG and resistance
            support are unknown — both are offered, and the trainer will refuse what it cannot do.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
