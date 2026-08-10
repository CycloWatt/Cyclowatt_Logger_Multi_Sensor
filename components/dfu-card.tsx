"use client"

import { useRef, useState, type ChangeEvent } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { UploadCloud } from "lucide-react"
import {
  SMP_CHARACTERISTIC_UUID,
  SMP_SERVICE_UUID,
  SmpClient,
  type ImageSlotState,
} from "@/lib/smp/client"
import { parseMcubootImage, type McubootImageInfo } from "@/lib/smp/mcuboot"
import { ImageUploader, type UploadProgress } from "@/lib/smp/upload"

interface DfuCardProps {
  device: BluetoothDevice | null
  isStreaming: boolean
  stopStreaming: () => Promise<void>
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

export function DfuCard({ device, isStreaming, stopStreaming }: DfuCardProps) {
  const [fileName, setFileName] = useState("")
  const [fileInfo, setFileInfo] = useState<McubootImageInfo | null>(null)
  const [phase, setPhase] = useState<DfuPhase>("idle")
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [bootedVersion, setBootedVersion] = useState("")
  const [errorText, setErrorText] = useState("")

  const fileBytesRef = useRef<Uint8Array | null>(null)
  const uploaderRef = useRef<ImageUploader | null>(null)
  // The device is captured when the flow starts: the page clears its own device
  // state on disconnect, but resume and the post-reset reconnect need this exact
  // BluetoothDevice object (a retained device reconnects without a new chooser).
  const deviceRef = useRef<BluetoothDevice | null>(null)

  const busy =
    phase === "starting" || phase === "uploading" || phase === "activating" || phase === "reconnecting"

  const handleFilePicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setErrorText("")
    setBootedVersion("")
    setPhase("idle")
    setProgress(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const info = parseMcubootImage(bytes) // rejects unsigned/truncated files up front
      fileBytesRef.current = bytes
      setFileInfo(info)
      setFileName(file.name)
    } catch (err) {
      fileBytesRef.current = null
      setFileInfo(null)
      setFileName(file.name)
      setErrorText(err instanceof Error ? err.message : "Could not read the file")
    }
  }

  /** Connect (or re-connect) the GATT link and attach an SMP client to it. */
  const openSmpClient = async (target: BluetoothDevice): Promise<SmpClient> => {
    if (!target.gatt) throw new Error("Device has no GATT interface")
    const server = target.gatt.connected ? target.gatt : await target.gatt.connect()
    const service = await server.getPrimaryService(SMP_SERVICE_UUID)
    const characteristic = await service.getCharacteristic(SMP_CHARACTERISTIC_UUID)
    const client = new SmpClient(characteristic)
    await client.initialize()
    return client
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
    setPhase(uploaderRef.current?.canResume ? "disconnected" : "error")
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
    setErrorText("")
    setPhase("starting")
    try {
      // The raw stream and the upload share the link's bandwidth — stop streaming first.
      if (isStreaming) await stopStreaming()
      const client = await openSmpClient(device)
      const uploader = new ImageUploader()
      uploaderRef.current = uploader
      uploader.onProgress = setProgress
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
          <Input type="file" accept=".bin" onChange={handleFilePicked} disabled={busy} />
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
            <Progress value={percent} />
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
