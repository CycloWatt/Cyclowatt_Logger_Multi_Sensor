"use client"

import { useEffect, useRef, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { UploadCloud } from "lucide-react"
import { DevicePanel } from "@/components/device-panel"
import { ImagePicker } from "@/components/image-picker"
import {
  appendFlashRecord,
  clearFlashHistory,
  readFlashHistory,
  throughputKbps,
  type FlashRecord,
} from "@/lib/flash-history"
import { readGapDeviceName } from "@/lib/gap-name"
import { type ImageSlotState, type SmpClient } from "@/lib/smp/client"
import { openSmpClient } from "@/lib/smp/gatt"
import { type McubootImageInfo } from "@/lib/smp/mcuboot"
import { ImageUploader, type UploadProgress } from "@/lib/smp/upload"

interface DfuCardProps {
  device: BluetoothDevice | null
  isStreaming: boolean
  stopStreaming: () => Promise<void>
  // The page's best current name for `device`, read from the board's own Device
  // Name characteristic. Passed in rather than read off BluetoothDevice.name,
  // which Chrome freezes at grant time (see lib/device-list.ts) and which on a
  // board flashed since the grant names the OLD build.
  deviceName?: string | null
  // Reports the board's name back up after a flash has renamed it. The post-reset
  // reconnect below is the first moment the NEW name is readable, and the page
  // cannot see it on its own: the BluetoothDevice object is unchanged, so nothing
  // there re-renders.
  onDeviceName?: (name: string) => void
}

// One user-visible phase per step of the flash flow; drives status text and buttons.
type DfuPhase =
  | "idle" // no flow running (a file may be picked)
  | "starting" // stopping streaming + attaching to the SMP service
  | "uploading"
  | "disconnected" // BLE dropped mid-upload — resumable (decision D3)
  | "activating" // image-test + reset
  | "reconnecting" // device is rebooting; MCUboot is installing the image
  | "success"
  | "error"

const PHASE_TEXT: Record<DfuPhase, string> = {
  idle: "",
  starting: "Preparing the DFU connection…",
  uploading: "Uploading image…",
  disconnected: "Connection lost mid-upload — the upload can be resumed.",
  activating: "Marking the image for the next boot…",
  reconnecting: "Device is rebooting and installing the image (this can take ~30 s)…",
  success: "Firmware update complete.",
  error: "",
}

export function DfuCard({ device, isStreaming, stopStreaming, deviceName, onDeviceName }: DfuCardProps) {
  const [fileName, setFileName] = useState("")
  const [fileInfo, setFileInfo] = useState<McubootImageInfo | null>(null)
  const [phase, setPhase] = useState<DfuPhase>("idle")
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [bootedVersion, setBootedVersion] = useState("")
  const [errorText, setErrorText] = useState("")
  const [history, setHistory] = useState<FlashRecord[]>([])

  const fileBytesRef = useRef<Uint8Array | null>(null)
  const uploaderRef = useRef<ImageUploader | null>(null)
  // Wall clock of the flash attempt currently in flight, or null when no attempt is
  // open. Doubles as the "an attempt is armed" flag: only an armed attempt may be
  // recorded, and recording disarms it, so nothing double-records.
  const flashStartRef = useRef<number | null>(null)
  // The device is captured when the flow starts: the page clears its own device
  // state on disconnect, but resume and the post-reset reconnect need this exact
  // BluetoothDevice object (a retained device reconnects without a new chooser).
  const deviceRef = useRef<BluetoothDevice | null>(null)
  // The freshest name this card has read off the board itself, which after a
  // successful flash is newer than anything the page can know. A ref because
  // recordFlash is called from paths that must not wait for a re-render.
  const gapNameRef = useRef<string | null>(null)

  const busy =
    phase === "starting" || phase === "uploading" || phase === "activating" || phase === "reconnecting"

  // localStorage is browser-only, so the first render (which also runs during the
  // Next prerender) must not touch it — load the log after mount instead.
  useEffect(() => setHistory(readFlashHistory()), [])

  /**
   * Close the flash attempt currently in flight and log it. Passive: it only
   * reads state the flow already keeps, never steers the flow.
   *
   * Guarded on flashStartRef, because failWith also fires on paths where no
   * upload ever started (no image picked, openSmpClient throws before the flow
   * arms) and because a flow must produce exactly ONE record: recording disarms
   * the ref, so a later failWith on the same attempt is a no-op.
   */
  const recordFlash = (outcome: FlashRecord["outcome"]) => {
    const startedAt = flashStartRef.current
    if (startedAt === null) return
    flashStartRef.current = null
    appendFlashRecord({
      deviceId: deviceRef.current?.id ?? "unknown",
      // Name preference is strictly freshest-first. deviceRef.current.name is the
      // last resort precisely because it is the one value that never updates.
      deviceName: gapNameRef.current ?? deviceName ?? deviceRef.current?.name ?? "unknown",
      version: fileInfo?.version ?? "?",
      startedAt,
      durationMs: Date.now() - startedAt,
      sizeBytes: fileBytesRef.current?.length ?? 0,
      outcome,
    })
    setHistory(readFlashHistory())
  }

  /**
   * A new image was chosen (ImagePicker already validated it through
   * parseMcubootImage, and owns the per-source error reporting). Clear the
   * previous run's result so the card never shows a stale success panel or
   * progress bar next to a freshly picked image.
   */
  const handleImagePicked = (bytes: Uint8Array, info: McubootImageInfo, label: string) => {
    fileBytesRef.current = bytes
    // Drop any abandoned uploader with it: a resumable one still reports
    // canResume, so a later startFlow that fails BEFORE arming (board asleep →
    // openSmpClient throws) would offer Resume, and resumeFlow would push the
    // OLD bytes — which pass verification whenever both builds share the
    // version triple, i.e. the normal bench case.
    uploaderRef.current = null
    setFileInfo(info)
    setFileName(label)
    setErrorText("")
    setBootedVersion("")
    setPhase("idle")
    setProgress(null)
  }

  /** Retry gatt.connect() until the rebooting device advertises again. */
  const reconnectWithRetry = async (target: BluetoothDevice, timeoutMs: number): Promise<void> => {
    // On an already-connected gatt, connect() is a no-op that resolves instantly —
    // drop any stale link first so the loop only succeeds on a genuinely fresh one.
    if (target.gatt?.connected) target.gatt.disconnect()
    const deadline = Date.now() + timeoutMs
    let lastError: unknown = new Error("reconnect timed out")
    while (Date.now() < deadline) {
      try {
        await target.gatt!.connect()
        return
      } catch (err) {
        lastError = err
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  const failWith = (err: unknown) => {
    setErrorText(err instanceof Error ? err.message : "Unknown error")
    const resumable = uploaderRef.current?.canResume ?? false
    setPhase(resumable ? "disconnected" : "error")
    // A resumable drop is not an outcome yet — leave the attempt armed so a
    // successful resume logs ONE record whose duration spans the whole
    // interrupted affair (that is the number the bench cares about).
    if (!resumable) recordFlash("failed")
  }

  /** Upload finished → mark pending, reboot, wait for the new image, verify it booted. */
  const activateAndVerify = async (client: SmpClient, expected: McubootImageInfo) => {
    setPhase("activating")
    try {
      const states = await client.imageStateRead()
      // The upload landed in the non-active slot (slot 1); its hash comes from the
      // device (the image TLV hash — NOT the file's SHA-256, which covers the whole file).
      const uploaded = states.find((s: ImageSlotState) => s.slot === 1)
      if (!uploaded) throw new Error("Uploaded image is not visible in the device's image list")
      if (!versionMatches(uploaded.version, expected)) {
        throw new Error(
          `Device reports uploaded version ${uploaded.version}, expected ${expected.version}`,
        )
      }
      await client.imageTest(uploaded.hash)
      await client.reset()
    } finally {
      // Dispose on the failure paths too — a leaked client keeps its notification
      // listener, pending timers and GATT subscription alive on the characteristic.
      client.dispose()
    }

    setPhase("reconnecting")
    const target = deviceRef.current
    if (!target) throw new Error("Lost the device reference during reset")
    // The firmware ANSWERS the reset request and only reboots ~250 ms later
    // (CONFIG_MCUMGR_GRP_OS_RESET_MS), so the old link is still up right here.
    // Reconnecting immediately would reuse that doomed pre-reboot link and
    // "verify" the OLD image — wait for the real drop first.
    await waitForDisconnect(target, 10000)
    // Give MCUboot a head start on the overwrite copy before polling reconnects.
    await new Promise((resolve) => setTimeout(resolve, 2000))
    try {
      // MCUboot copies the image into the primary slot before the app boots —
      // allow generous time before giving up (a ~318 KB copy plus boot).
      await reconnectWithRetry(target, 120000)
      // The board is now running the flashed image, so its GAP name carries the
      // NEW version suffix. Read it here, while the link is up and before the
      // finally below drops it: this is the only moment the new name is
      // obtainable, and both the flash record and the page's device list want it.
      const flashedName = await readGapDeviceName(target)
      if (flashedName) {
        gapNameRef.current = flashedName
        onDeviceName?.(flashedName)
      }
      const verifyClient = await openSmpClient(target)
      try {
        const booted = (await verifyClient.imageStateRead()).find((s: ImageSlotState) => s.active)
        if (!booted || !versionMatches(booted.version, expected)) {
          throw new Error(
            `Device rebooted into ${booted?.version ?? "an unknown version"}, expected ${expected.version}`,
          )
        }
        setBootedVersion(booted.version)
        setPhase("success")
        recordFlash("success")
      } finally {
        verifyClient.dispose()
      }
    } finally {
      // Release the link either way: the board has a single peripheral slot, and the
      // page already shows this session as disconnected (its Disconnect button is
      // gone) — a silently held link would leave the board unreachable by any
      // head unit or other tab with no on-screen way to free it.
      if (target.gatt?.connected) target.gatt.disconnect()
    }
  }

  const startFlow = async () => {
    const bytes = fileBytesRef.current
    const info = fileInfo
    if (!bytes || !info || !device) return
    deviceRef.current = device
    // Starting a fresh flow abandons any still-armed earlier attempt (e.g. a
    // resumable drop the operator chose not to resume) — its stale timestamp must
    // not be inherited by this run.
    flashStartRef.current = null
    setErrorText("")
    setPhase("starting")
    try {
      // The raw stream and the upload share the link's bandwidth — stop streaming first.
      if (isStreaming) await stopStreaming()
      const client = await openSmpClient(device)
      const uploader = new ImageUploader()
      uploaderRef.current = uploader
      uploader.onProgress = setProgress
      // Arm the attempt only now, with the SMP link already open: a failure in
      // stopStreaming or openSmpClient means no bytes ever moved, and logging that
      // as a flash would inject a 1-5 s record carrying the full image size — an
      // ~800 kbit/s phantom in exactly the throughput data this log exists to
      // collect. Everything from the first chunk onwards does get recorded.
      flashStartRef.current = Date.now()
      setPhase("uploading")
      try {
        await uploader.start(bytes, client)
      } catch (err) {
        client.dispose()
        throw err
      }
      if (uploader.phase === "aborted") {
        client.dispose()
        setPhase("idle")
        // A user abort is a cancellation, not an outcome (FlashRecord only knows
        // success/failed) — disarm so it is neither logged now nor later.
        flashStartRef.current = null
        return
      }
      await activateAndVerify(client, info)
    } catch (err) {
      failWith(err)
    }
  }

  const resumeFlow = async () => {
    const uploader = uploaderRef.current
    const info = fileInfo
    const target = deviceRef.current
    if (!uploader?.canResume || !info || !target) return
    setErrorText("")
    setPhase("starting")
    try {
      await reconnectWithRetry(target, 60000)
      const client = await openSmpClient(target)
      setPhase("uploading")
      try {
        await uploader.resume(client)
      } catch (err) {
        client.dispose()
        throw err
      }
      if (uploader.phase === "aborted") {
        client.dispose()
        setPhase("idle")
        // A user abort is a cancellation, not an outcome (FlashRecord only knows
        // success/failed) — disarm so it is neither logged now nor later.
        flashStartRef.current = null
        return
      }
      await activateAndVerify(client, info)
    } catch (err) {
      failWith(err)
    }
  }

  const percent = progress ? Math.floor((progress.sentBytes / progress.totalBytes) * 100) : 0
  const etaSeconds =
    progress && progress.bytesPerSecond > 0
      ? Math.round((progress.totalBytes - progress.sentBytes) / progress.bytesPerSecond)
      : null

  return (
    <Card className="bg-white border-gray-200">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UploadCloud className="w-5 h-5" />
          Firmware Update (DFU)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <ImagePicker disabled={busy} onImage={handleImagePicked} />
          {fileInfo && (
            <div className="text-sm text-gray-600 p-3 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="font-medium">{fileName}</div>
              <div>
                Signed image, version {fileInfo.version} · {(fileInfo.imageSize / 1024).toFixed(1)} KB
              </div>
            </div>
          )}
        </div>

        {!device && phase === "idle" && (
          <p className="text-sm text-gray-500">
            Connect to a sensor first (normal or firmware-update-only connection).
          </p>
        )}

        {errorText && (
          <Alert variant="destructive" className="bg-red-50 border-red-200 text-red-800">
            <AlertDescription>{errorText}</AlertDescription>
          </Alert>
        )}

        {phase !== "idle" && PHASE_TEXT[phase] && (
          <p className="text-sm text-gray-600">{PHASE_TEXT[phase]}</p>
        )}

        {(phase === "uploading" || phase === "disconnected") && progress && (
          <div className="space-y-1">
            {/* Relative wrapper + top padding: the rider is taller than the h-4
              * bar and needs headroom above the track. It cannot be nested inside
              * <Progress> - that root sets overflow-hidden (see .chameleon-rider
              * in app/globals.css). */}
            <div className="relative pt-12">
              <Progress value={percent} />
              <div
                className="chameleon-rider"
                /* Just the percentage: the CSS centres the sprite on it, so this
                 * stays correct whatever size the generated artwork turns out. */
                style={{ left: `${percent}%` }}
                /* Purely decorative - PHASE_TEXT and the KB/s line carry the real
                 * status, so keep the rider out of the accessibility tree. */
                aria-hidden
                /* Pedalling stops when the upload is not actually advancing. */
                data-stalled={phase === "disconnected" ? "" : undefined}
              />
            </div>
            <div className="text-xs text-gray-500">
              {(progress.sentBytes / 1024).toFixed(1)} / {(progress.totalBytes / 1024).toFixed(1)} KB
              {" · "}
              {(progress.bytesPerSecond / 1024).toFixed(1)} KB/s
              {etaSeconds !== null && ` · ~${etaSeconds}s left`}
            </div>
          </div>
        )}

        {phase === "success" && (
          <div className="text-sm text-gray-600 p-3 bg-green-50 border border-green-200 rounded-lg">
            <div className="font-medium">Device is now running {bootedVersion}</div>
          </div>
        )}

        {/*
          Bench controls: read-only image state plus a remote reboot. Disabled
          while a flash flow runs so its short-lived SMP client can never take
          the characteristic out from under the uploader.
        */}
        <DevicePanel device={device} busy={busy} />

        {/*
          Bench log of past flashes (this browser only). The wall clock and the
          derived kbit/s are the raw material for the pipelined-upload decision.
          Both are END-TO-END (upload + activate + reboot + verify), never the
          upload alone — hence the explicit "total"/"avg" labels, so a low kbit/s
          is not misread as the link being slow.
        */}
        {history.length > 0 && (
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium">Flash history (end-to-end)</div>
              {/*
                Disabled mid-flash for the same reason as the bench controls: the
                run in flight is about to append a record, and clearing underneath
                it would leave the log looking like the clear had failed. The whole
                block is gated on a non-empty log, so this button removes itself.
              */}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setHistory(clearFlashHistory())}
              >
                Clear
              </Button>
            </div>
            {history.slice(0, 5).map((r) => (
              // startedAt alone can collide only in the conceivable same-millisecond
              // pair, so the outcome and the board join the key.
              <div
                key={`${r.startedAt}-${r.outcome}-${r.deviceId}`}
                className="text-sm text-gray-500"
              >
                {new Date(r.startedAt).toLocaleString()} — v{r.version} → {r.deviceName} ·{" "}
                {(r.durationMs / 1000).toFixed(1)} s total · {throughputKbps(r).toFixed(0)} kbit/s
                avg · {r.outcome}
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2 flex-wrap">
          <Button onClick={startFlow} disabled={!device || !fileInfo || busy}>
            Upload & Activate
          </Button>
          {phase === "disconnected" && (
            <Button variant="outline" onClick={resumeFlow}>
              Resume Upload
            </Button>
          )}
          {phase === "uploading" && (
            <Button variant="destructive" onClick={() => uploaderRef.current?.abort()}>
              Abort
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Resolve once the device's GATT link has actually dropped (or force-drop it at
 * the timeout). Needed after an SMP reset: the firmware acknowledges the request
 * first and reboots ~250 ms later, so "reset returned" does NOT mean "link down".
 */
function waitForDisconnect(target: BluetoothDevice, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (!target.gatt?.connected) return resolve()
    const done = () => {
      target.removeEventListener("gattserverdisconnected", done)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      target.gatt?.disconnect() // force the stale link down so connect() really reconnects
      done()
    }, timeoutMs)
    target.addEventListener("gattserverdisconnected", done)
  })
}

/** Firmware reports "0.1.1"- or "0.1.1+0"-style strings; compare the numeric triple. */
function versionMatches(reported: string, expected: McubootImageInfo): boolean {
  const parts = reported.split(/[.+]/).map(Number)
  return parts[0] === expected.major && parts[1] === expected.minor && parts[2] === expected.revision
}
