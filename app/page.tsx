"use client"

import { useState, useRef, useEffect, useCallback } from "react"
// Imported rather than written as "/logo_black.png": a static import is rewritten
// to carry the basePath prefix, while a root-absolute literal would 404 on the
// deployed Pages site, which is served from a subdirectory.
import logoBlack from "@/public/logo_black.png"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { type ChartConfig } from "@/components/ui/chart"
import { Download, Wifi, WifiOff, AlertTriangle, Search, Cable } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  AUTO_AXIS,
  SensorChartCard,
  isZoomed,
  type AxisRange,
  type ChartLineDef,
  type ZoomRange,
} from "@/components/sensor-chart-card"
import { SMP_SERVICE_UUID } from "@/lib/smp/client"
import { BOARD_NAME_PREFIXES, BOARD_NAME_PREFIX_HINT, firmwareVersionFromName, isBoardName } from "@/lib/device-name"
import { applyDeviceName, nextDisplayName } from "@/lib/device-list"
import { readGapDeviceName } from "@/lib/gap-name"
import { CPS_SERVICE_UUID } from "@/lib/cps/protocol"
import { CalibrationCard, type CalibrationReading } from "@/components/calibration-card"
import { CalibrationHistoryCard } from "@/components/calibration-history-card"
import {
  appendCalibrationRecord,
  clearCalibrationHistory,
  deleteCalibrationRecord,
  isNewReadingForDevice,
  newCalibrationRecord,
  readCalibrationHistory,
  type CalibrationRecord,
} from "@/lib/calibration-history"
import { readForceOffsets } from "@/lib/raw-stream/force-offsets"
import {
  FORCE_SLOTS_FIRST,
  FORCE_SLOTS_SECOND,
  forceChannelLabel,
  forceDataKey,
} from "@/lib/raw-stream/force-channels"
import { readBenchPrefs, writeBenchPrefs } from "@/lib/bench-prefs"
import { parseDataPacket as parsePacket, type DataPoint } from "@/lib/raw-stream/packet"
import { rawCsvFilename, rawStreamToCsv } from "@/lib/raw-stream/csv"
import { DfuCard } from "@/components/dfu-card"
import { TrainerPanel } from "@/components/trainer-panel"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"

// Per-packet console output (3 lines per packet at streaming rate, i.e.
// hundreds of lines/s). With DevTools open this was the single largest CPU
// cost of a capture, and the log strings were built even with DevTools closed.
// Flip to true only when actually debugging the packet stream.
const DEBUG_PACKET_LOG = false

// A type alias, not an interface, on purpose: aliases get TypeScript's implicit
// index signature, which lets ChartDataPoint[] flow into the chart card's
// generic Record-typed data prop without casts.
type ChartDataPoint = {
  time: string
  force0: number
  force1: number
  force2: number
  force3: number
  force4: number
  force5: number
  force0_2: number
  accelX: number
  accelY: number
  accelZ: number
  gyroX: number
  gyroY: number
  gyroZ: number
  power: number
  referencePower: number
  synchronization: number
}

/**
 * A board this session has opened a link to. The list built from these is
 * deliberately NOT a discovery list: it shows the CONNECTED board and nothing
 * else. Rows for boards that were merely remembered (a past permission grant
 * from navigator.bluetooth.getDevices()) or merely seen on the air (an
 * advertisement, via watchAdvertisements) used to live here too, and on a bench
 * with many flashed boards that pile of "(remembered)" rows - none of which is
 * evidence the board is even powered on - buried the one row that mattered.
 * Both sources are gone; a board reaches this list only by being picked through
 * the chooser, which connects it straight away.
 */
interface AvailableDevice {
  device: BluetoothDevice
  name: string
  id: string
  hasTargetService: boolean
}

// Chart styling/labels and the five charts' line sets, at module scope so the
// memoized chart cards receive the SAME object every render - rebuilding these
// per render would defeat the memo and re-render five recharts trees on every
// unrelated state change (serial line, battery update, reference power).
const CHART_CONFIG = {
  // Force labels come from lib/raw-stream/force-channels.ts, never from the index
  // itself: the rule this replaced derived them arithmetically (even channel =
  // compression, odd = shear) and got channels 1 and 4 wrong, on both this screen
  // and the calibration readout. Colour is keyed to POSITION rather than to the
  // card, so front-right is the same colour on both force graphs and the two
  // channels of one load cell are visually a pair.
  force0: {
    label: forceChannelLabel(0),
    color: "hsl(var(--chart-1))",
  },
  force1: {
    label: forceChannelLabel(1),
    color: "hsl(var(--chart-2))",
  },
  force2: {
    label: forceChannelLabel(2),
    color: "hsl(var(--chart-3))",
  },
  force3: {
    label: forceChannelLabel(3),
    color: "hsl(var(--chart-1))",
  },
  force4: {
    label: forceChannelLabel(4),
    color: "hsl(var(--chart-2))",
  },
  force5: {
    label: forceChannelLabel(5),
    color: "hsl(var(--chart-3))",
  },
  force0_2: {
    label: "Sum front (Ch 0 + 2)",
    color: "hsl(var(--chart-4))",
  },
  // Units below follow the firmware's wire contract: it packs accel in milli-g
  // and gyro in milli-rad/s, and parseDataPacket divides both by 1000. So these
  // traces are g and rad/s - NOT the m/s2 and deg/s they were labelled as.
  accelX: {
    label: "Accel X (g)",
    color: "hsl(var(--chart-2))",
  },
  accelY: {
    label: "Accel Y (g)",
    color: "hsl(var(--chart-3))",
  },
  accelZ: {
    label: "Accel Z (g)",
    color: "hsl(var(--chart-4))",
  },
  gyroX: {
    label: "Gyro X (rad/s)",
    color: "hsl(var(--chart-5))",
  },
  gyroY: {
    label: "Gyro Y (rad/s)",
    color: "hsl(220, 70%, 50%)",
  },
  gyroZ: {
    label: "Gyro Z (rad/s)",
    color: "hsl(280, 70%, 50%)",
  },
  // Slot 12 of the capture packet is a frozen zero-fill field, not a reading. The
  // on-board estimator produces power per crank REVOLUTION, so there is no
  // per-sample value to pack; power for a capture is computed from the channels
  // offline. The trace is kept (the slot is still parsed and exported) but must
  // not read as a measurement - it is a flat zero line by design.
  power: {
    label: "Board Power (unused - always 0)",
    color: "hsl(45, 90%, 50%)",
  },
  referencePower: {
    label: "Reference Power (W)",
    color: "hsl(200, 80%, 45%)",
  },
  synchronization: {
    label: "Sync",
    color: "hsl(var(--chart-1))",
  },
} satisfies ChartConfig

// The two force graphs split the six channels by which of a load cell's two amp
// outputs they are, NOT by axis: slots 0/1/2 are the first output of front-right,
// back and front-left, slots 3/4/5 the second. Which of a position's two channels
// carries compression and which shear depends on how the cell is soldered to the
// amp inputs, so neither the names nor the titles here claim an axis - see the
// header of lib/raw-stream/force-channels.ts.
const FORCE_LINES_A: readonly ChartLineDef[] = [
  ...FORCE_SLOTS_FIRST.map((slot) => ({ dataKey: forceDataKey(slot), name: forceChannelLabel(slot) })),
  { dataKey: "force0_2", name: "Sum front (Ch 0 + 2)" },
]
const FORCE_LINES_B: readonly ChartLineDef[] = FORCE_SLOTS_SECOND.map((slot) => ({
  dataKey: forceDataKey(slot),
  name: forceChannelLabel(slot),
}))
const ACCEL_LINES: readonly ChartLineDef[] = [
  { dataKey: "accelX", name: "Accel X" },
  { dataKey: "accelY", name: "Accel Y" },
  { dataKey: "accelZ", name: "Accel Z" },
]
const GYRO_LINES: readonly ChartLineDef[] = [
  { dataKey: "gyroX", name: "Gyro X" },
  { dataKey: "gyroY", name: "Gyro Y" },
  { dataKey: "gyroZ", name: "Gyro Z" },
]
const POWER_LINES: readonly ChartLineDef[] = [
  { dataKey: "power", name: "CycloWatt Power" },
  { dataKey: "referencePower", name: "Reference Power" },
]

export default function BluetoothDataLogger() {
  const [isConnected, setIsConnected] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [device, setDevice] = useState<BluetoothDevice | null>(null)
  const [service, setService] = useState<BluetoothRemoteGATTService | null>(null)
  const [characteristic, setCharacteristic] = useState<BluetoothRemoteGATTCharacteristic | null>(null)
  const [error, setError] = useState<string>("")
  const [bluetoothSupported, setBluetoothSupported] = useState<boolean>(true)
  const [isSecureContext, setIsSecureContext] = useState<boolean>(true)
  const [availableDevices, setAvailableDevices] = useState<AvailableDevice[]>([])
  const [isScanning, setIsScanning] = useState(false)
  // Narrows the chooser to CycloWatt boards by name prefix. Was a raw-stream
  // service-UUID filter, which could only ever find DAQ boards - prod images do not
  // advertise that service; renamed so it no longer claims to filter on a UUID.
  const [useDeviceFilter, setUseDeviceFilter] = useState(false)
  // "normal" = raw-stream logging session; "dfu" = firmware-update-only session.
  // DFU-only mode exists because prod images don't advertise the raw-stream service
  // (decision D1) — without it, a board flashed to prod could never be reached again.
  const [connectionMode, setConnectionMode] = useState<"normal" | "dfu">("normal")
  // Sensor battery percentage from the firmware's standard Battery Service (BAS).
  // null = unknown/unavailable, so the connected panel simply omits the line.
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null)
  // Firmware version parsed from the device name, LATCHED at connect time so a CSV
  // exported after the link is gone still carries the build it was captured on. It
  // deliberately outlives the session (handleDisconnection nulls `device` while
  // the recording survives and Export stays enabled), and is overwritten by the next
  // successful connect. null = the name carried no parsable version.
  const [connectedFwVersion, setConnectedFwVersion] = useState<string | null>(null)
  // The connected board's name as the BOARD reports it, read from its Device Name
  // characteristic. Every "Connected to:" line renders this instead of
  // device.name, which Chrome freezes when the grant is made and never refreshes,
  // so on a board flashed since then it shows the version it USED to run. Kept in
  // state rather than derived, because nothing about the BluetoothDevice object
  // changes when the board is renamed - there would be nothing to re-render on.
  //
  // Tagged with the id it was read from, and only believed when that id still
  // matches the connected device. Clearing it on disconnect instead would leave a
  // window where connecting to a SECOND board whose name read fails displays the
  // FIRST board's name - a wrong board is worse than a stale version.
  const [connectedName, setConnectedName] = useState<{ id: string; name: string } | null>(null)

  // The stored force-calibration readings for this browser. Owned HERE rather
  // than in either card because two independent things write to it: a calibration
  // run in the calibration card, and the connect-time read below. A card holding
  // its own copy would show a stale table whenever the other writer moved.
  //
  // Starts empty and is filled by the effect below rather than read inline:
  // localStorage does not exist during the Next prerender, and an initializer
  // that touched it would make the server and client renders disagree.
  const [calibrationHistory, setCalibrationHistory] = useState<CalibrationRecord[]>([])

  useEffect(() => {
    setCalibrationHistory(readCalibrationHistory())
  }, [])

  const [serialPort, setSerialPort] = useState<SerialPort | null>(null)
  const [isSerialConnected, setIsSerialConnected] = useState(false)
  const [serialSupported, setSerialSupported] = useState<boolean>(true)
  const [latestSerialValue, setLatestSerialValue] = useState<number>(0)

  // Reference power meter (standard Cycling Power Service)
  const [refDevice, setRefDevice] = useState<BluetoothDevice | null>(null)
  const [isRefConnected, setIsRefConnected] = useState(false)
  const [isRefConnecting, setIsRefConnecting] = useState(false)
  const [latestRefPower, setLatestRefPower] = useState<number>(0)

  // Data management. The recording itself lives ONLY in dataBufferRef - keeping
  // a state copy meant re-copying the whole (unbounded) recording on every
  // 100 ms chart tick. The UI needs just the count; exportToCSV reads the ref.
  const [recordedCount, setRecordedCount] = useState(0)
  const [chartData, setChartData] = useState<ChartDataPoint[]>([])
  // Master switch for CSV capture. ON (the historical behaviour) keeps every
  // received sample in memory for Export to CSV; OFF keeps the charts live but
  // retains only the rolling chart window, so a long idle bench session cannot
  // grow memory without bound. Turning it OFF mid-session keeps what was already
  // recorded - it pauses capture, it does not discard a recording.
  const [csvCaptureEnabled, setCsvCaptureEnabled] = useState(true)
  const [stats, setStats] = useState({
    totalSamples: 0,
    samplingRate: 0,
    duration: 0,
    packetsPerSecond: 0,
  })

  const [forceAZoom, setForceAZoom] = useState<{ startIndex?: number; endIndex?: number }>({})
  const [forceBZoom, setForceBZoom] = useState<{ startIndex?: number; endIndex?: number }>({})
  const [accelZoom, setAccelZoom] = useState<{ startIndex?: number; endIndex?: number }>({})
  const [gyroZoom, setGyroZoom] = useState<{ startIndex?: number; endIndex?: number }>({})
  const [powerZoom, setPowerZoom] = useState<{ startIndex?: number; endIndex?: number }>({})

  // Per-chart Y-axis range. One state each, mirroring the zoom states above,
  // so editing one chart's range leaves the other four memoized cards alone.
  // All five start on the SHARED AUTO_AXIS constant - a fresh object literal
  // per chart would be five distinct identities for the same default.
  const [forceARange, setForceARange] = useState<AxisRange>(AUTO_AXIS)
  const [forceBRange, setForceBRange] = useState<AxisRange>(AUTO_AXIS)
  const [accelRange, setAccelRange] = useState<AxisRange>(AUTO_AXIS)
  const [gyroRange, setGyroRange] = useState<AxisRange>(AUTO_AXIS)
  const [powerRange, setPowerRange] = useState<AxisRange>(AUTO_AXIS)

  // Per-line visibility for each chart
  const [lineVisibility, setLineVisibility] = useState<Record<string, boolean>>({
    force0: true,
    force1: true,
    force2: true,
    force3: true,
    force4: true,
    force5: true,
    force0_2: false,
    accelX: true,
    accelY: true,
    accelZ: true,
    gyroX: true,
    gyroY: true,
    gyroZ: true,
    power: true,
    referencePower: true,
  })

  // Stable identity (useCallback + functional update) - this is a prop of every
  // memoized chart card, and a fresh function per render would defeat the memo.
  const toggleLine = useCallback((key: string) => {
    setLineVisibility((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  // State drives the switch UI; the ref is what the streaming closure reads.
  const setCsvCapture = (enabled: boolean) => {
    csvCaptureEnabledRef.current = enabled
    setCsvCaptureEnabled(enabled)
    writeBenchPrefs({ csvCaptureEnabled: enabled })
  }

  const setDeviceFilter = (enabled: boolean) => {
    setUseDeviceFilter(enabled)
    writeBenchPrefs({ useDeviceFilter: enabled })
  }

  // Restore the bench switches from the previous session. Done in an effect,
  // not in the useState initializers, because those also run during the Next
  // prerender where localStorage does not exist (same reasoning as the flash
  // history's post-mount load).
  useEffect(() => {
    const prefs = readBenchPrefs()
    if (typeof prefs.csvCaptureEnabled === "boolean") {
      csvCaptureEnabledRef.current = prefs.csvCaptureEnabled
      setCsvCaptureEnabled(prefs.csvCaptureEnabled)
    }
    if (typeof prefs.useDeviceFilter === "boolean") setUseDeviceFilter(prefs.useDeviceFilter)
  }, [])

  // Pull a connected board's LIVE name into the scan list by asking the BOARD,
  // not Chrome. On this bench names change constantly (each flash bumps the
  // " v<version>" suffix), and BluetoothDevice.name is frozen at grant time and
  // never updated - reading it back is what used to revert a corrected row to the
  // build the board used to run (see lib/device-list.ts). The Device Name
  // characteristic read inside readGapDeviceName is the authoritative source.
  //
  // Returns the name so a caller that also needs the version can stamp it from
  // the same read. Requires an OPEN link, so it is called right after a connect
  // succeeds; a disconnect handler has nothing left to read over.
  const syncNameFromGatt = async (target: BluetoothDevice | null | undefined) => {
    const gapName = await readGapDeviceName(target)
    if (gapName && target) {
      // applyDeviceName returns the same array when nothing changed, so React bails
      // out instead of re-rendering.
      setAvailableDevices((prev) => applyDeviceName(prev, target.id, gapName, "gap"))
      setConnectedName({ id: target.id, name: gapName })
    }

    // Log what the board already has stored, from the same open link. Not awaited:
    // this is a bench nicety and every caller of this function is on the critical
    // path of a connect, which must not wait on a second GATT round trip.
    // Deliberately runs even when the name read failed - a reading filed under a
    // fallback name is worth more than no reading.
    void recordStoredCalibration(target, gapName)

    return gapName ?? null
  }

  /**
   * Read a freshly connected board's stored offsets into the calibration log.
   *
   * THE ANTI-SPAM RULE lives here: only a board whose state differs from the
   * newest thing already logged about it produces a row. Reconnecting repeatedly
   * to an unchanged board adds nothing, which is what keeps the handful of real
   * calibrations visible among a bench afternoon's connects.
   *
   * The store, not React state, is what gets compared against - it is the source
   * of truth, and reading it here avoids doing a localStorage write inside a
   * state updater, which React would run twice in development and double-log.
   */
  const recordStoredCalibration = async (
    target: BluetoothDevice | null | undefined,
    gapName: string | null,
  ) => {
    if (!target) return

    try {
      const report = await readForceOffsets(target)
      // null means this board does not serve per-channel detail at all (a
      // production image). Nothing to log, and not a failure.
      if (!report) return

      const candidate = {
        deviceId: target.id,
        calibrated: report.calibrated,
        offsetsMv: report.offsetsMv,
      }
      if (!isNewReadingForDevice(candidate, readCalibrationHistory())) return

      setCalibrationHistory(
        appendCalibrationRecord(
          newCalibrationRecord({
            ...candidate,
            deviceName: gapName ?? target.name ?? "Unknown Device",
            kind: "read",
            recordedAt: Date.now(),
            // Only a calibration RUN sees the Control Point's average.
            avgOffsetN: null,
          }),
        ),
      )
    } catch (err) {
      // Never surfaced as a connect failure: the link is up and everything else
      // on this page works without the log.
      console.warn("calibration history: could not read the board's stored offsets", err)
    }
  }

  /** Record a calibration the operator just ran. Always logged - see below. */
  const handleCalibrationReading = (reading: CalibrationReading) => {
    if (!device) return

    // No changed-since-last gate here, unlike the connect-time read: two runs
    // producing identical values is a repeatability RESULT and the single most
    // useful thing this log shows. Suppressing it would discard the measurement.
    setCalibrationHistory(
      appendCalibrationRecord(
        newCalibrationRecord({
          deviceId: device.id,
          deviceName: displayedDeviceName,
          kind: "calibration",
          recordedAt: Date.now(),
          calibrated: reading.calibrated,
          offsetsMv: reading.offsetsMv,
          avgOffsetN: reading.avgOffsetN,
        }),
      ),
    )
  }

  // A completed flash renames the board, and the DFU card's post-reset reconnect is
  // the first moment that new name can be read. Fold it into both places a name is
  // shown, so the firmware-update tab stops naming the build it just replaced.
  const handleFlashedDeviceName = (name: string) => {
    const id = device?.id
    if (!id) return
    setConnectedName({ id, name })
    setAvailableDevices((prev) => applyDeviceName(prev, id, name, "gap"))
  }

  // What the "Connected to:" lines show: the board's own name when it was read
  // from the board now connected, otherwise Chrome's frozen one as a last resort.
  const displayedDeviceName =
    (connectedName && connectedName.id === device?.id ? connectedName.name : null) ||
    device?.name ||
    "Unknown Device"

  // The single row the device list renders: the board currently CONNECTED, or
  // nothing at all.
  //
  // Derived from the connection state rather than by filtering availableDevices
  // on `gatt.connected`, because that property is not React state - a list
  // filtered on it would go on rendering a row for a board that had already
  // dropped, until some unrelated state change happened to force a re-render.
  // isConnected/device change on every connect and every disconnect route
  // (handleDisconnection), which is exactly when this row must appear or go.
  const connectedDeviceRow = (() => {
    if (!isConnected || !device) return null
    const known = availableDevices.find((d) => d.id === device.id)
    return {
      id: device.id,
      // The row's own name, kept current by lib/device-list.ts from Device Name
      // reads. displayedDeviceName is the fallback for the same reason it exists
      // at all: Chrome's frozen BluetoothDevice.name is the last resort, never
      // the first choice.
      name: known?.name || displayedDeviceName,
      // Only a scan MEASURES this. A firmware-update-only connect registers its
      // row without probing services, so that row simply shows no badge rather
      // than claiming incompatibility it never checked.
      hasTargetService: known?.hasTargetService ?? false,
    }
  })()

  // Refs for efficient data handling
  const dataBufferRef = useRef<DataPoint[]>([])
  // The charts' own rolling buffer, fed on every packet regardless of the CSV
  // switch and trimmed to the chart window - dataBufferRef used to serve both
  // roles, which is exactly what made "chart without recording" impossible.
  const chartBufferRef = useRef<DataPoint[]>([])
  // Mirror of csvCaptureEnabled for the notification handler, which is a closure
  // created once at stream start and never sees later state values.
  const csvCaptureEnabledRef = useRef<boolean>(true)
  const lastUpdateRef = useRef<number>(Date.now())
  const startTimeRef = useRef<number>(0)
  const sampleCountRef = useRef<number>(0)
  const packetCountRef = useRef<number>(0)
  const lastPacketTimeRef = useRef<number>(Date.now())

  const serialValueRef = useRef<number>(0)
  // The reader yields decoded STRINGS (it sits behind a TextDecoderStream).
  const serialReaderRef = useRef<ReadableStreamDefaultReader<string> | null>(null)
  // Throttle state for the on-screen serial value: the ref above is always
  // current (every packet logs it), but re-rendering the page per received
  // line is pointless - the display updates at most ~5x/s, with a trailing
  // flush so the last value of a burst still lands.
  const serialFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSerialFlushRef = useRef<number>(0)

  const refPowerValueRef = useRef<number>(0)
  const refCharacteristicRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null)

  // Holds the active notification handler so it can be removed on stop (prevents duplicate listeners)
  const notificationHandlerRef = useRef<((event: Event) => void) | null>(null)
  const streamingCharacteristicRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null)

  // Battery characteristic + its listener, kept so a disconnect can detach the
  // listener instead of leaving it behind on the dead characteristic object.
  const batteryCharacteristicRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null)
  const batteryHandlerRef = useRef<((event: Event) => void) | null>(null)

  // CycloWatt specific UUIDs
  const CYCLOWATT_SERVICE_UUID = "5a1d0001-c7a1-4b2e-9e4f-1a2b3c4d5e6f"
  const CYCLOWATT_DATA_CHAR_UUID = "5a1d0002-c7a1-4b2e-9e4f-1a2b3c4d5e6f"

  // Standard Cycling Power Service (CPS) UUIDs. The service id itself now comes
  // from lib/cps/protocol, which the calibration flow shares - two copies of it
  // could drift and the symptom would be a SecurityError seconds into a procedure.
  const CPS_MEASUREMENT_CHAR_UUID = "00002a63-0000-1000-8000-00805f9b34fb" // cycling_power_measurement

  // Check browser compatibility on mount
  useEffect(() => {
    console.log("=== CYCLOWATT DATA LOGGER INITIALIZED ===")
    console.log("Target Service UUID:", CYCLOWATT_SERVICE_UUID)
    console.log("Target Characteristic UUID:", CYCLOWATT_DATA_CHAR_UUID)
    console.log(
      "Expected Data Format: 16x int32 (6x Force, AccelX/Y/Z, GyroX/Y/Z, Power, Tick, TicksMCU lo, TicksMCU hi)",
    )
    console.log("User Agent:", navigator.userAgent)
    console.log("Is Secure Context:", window.isSecureContext)
    console.log("Protocol:", window.location.protocol)

    setIsSecureContext(window.isSecureContext)

    if (!navigator.bluetooth) {
      console.error("Web Bluetooth API not supported")
      setBluetoothSupported(false)
      setError("Web Bluetooth API is not supported in this browser. Please use Chrome, Edge, or Opera.")
    } else {
      console.log("Web Bluetooth API is supported")
      setBluetoothSupported(true)
    }

    if (!("serial" in navigator)) {
      console.error("Web Serial API not supported")
      setSerialSupported(false)
    } else {
      console.log("Web Serial API is supported")
      setSerialSupported(true)
    }

    if (!window.isSecureContext) {
      console.error("Not in secure context")
      setError("Bluetooth and Serial require HTTPS. Please access this page via HTTPS or localhost.")
    }
  }, [])

  const updateCharts = () => {
    const now = Date.now()

    // The charts only ever show the last 500 samples, so only that many are
    // kept. Trimming here (10x/s) instead of on every packet keeps the
    // notification hot path down to a push.
    if (chartBufferRef.current.length > 500) {
      chartBufferRef.current.splice(0, chartBufferRef.current.length - 500)
    }

    const chartPoints = chartBufferRef.current.map((point) => ({
      // Formatted once at parse time - see DataPoint.timeLabel.
      time: point.timeLabel,
      force0: point.force0,
      force1: point.force1,
      force2: point.force2,
      force3: point.force3,
      force4: point.force4,
      force5: point.force5,
      // The two FRONT cells, front-right (Ch 0) + front-left (Ch 2): they sit on
      // the same axis on the bench, so their combined load is what the readout
      // wants. A position pair, deliberately - not "the first two compression
      // channels", which is what this sum was mistaken for while the labels still
      // claimed an axis per channel.
      force0_2: point.force0 + point.force2,
      accelX: Number(point.accelX.toFixed(3)),
      accelY: Number(point.accelY.toFixed(3)),
      accelZ: Number(point.accelZ.toFixed(3)),
      gyroX: Number(point.gyroX.toFixed(3)),
      gyroY: Number(point.gyroY.toFixed(3)),
      gyroZ: Number(point.gyroZ.toFixed(3)),
      power: point.power,
      referencePower: point.referencePower,
      synchronization: point.synchronization,
    }))

    setChartData(chartPoints)

    // Publish only the COUNT - the recording itself stays in the ref, so this
    // costs nothing however large the capture grows (React bails out of the
    // set when the number is unchanged, e.g. while CSV capture is off).
    setRecordedCount(dataBufferRef.current.length)

    // Update stats
    const duration = startTimeRef.current > 0 ? (now - startTimeRef.current) / 1000 : 0
    const packetsPerSecond = duration > 0 ? packetCountRef.current / duration : 0

    setStats({
      totalSamples: sampleCountRef.current,
      samplingRate: duration > 0 ? sampleCountRef.current / duration : 0,
      duration,
      packetsPerSecond,
    })

    lastUpdateRef.current = now
  }

  const connectSerial = async () => {
    try {
      if (!("serial" in navigator)) {
        setError("Web Serial API is not supported in this browser.")
        return
      }

      console.log("\n🔌 CONNECTING TO SERIAL PORT...")
      // Typed since @types/w3c-web-serial - the `as any` escape hatch is gone.
      const port = await navigator.serial.requestPort()
      await port.open({ baudRate: 9600 })

      setSerialPort(port)
      setIsSerialConnected(true)
      console.log("✅ Serial port connected")

      // Start reading serial data
      startSerialReading(port)
    } catch (err) {
      console.error("Serial connection failed:", err)
      setError(`Serial connection failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    }
  }

  // Leading + trailing throttle: immediate when the display is stale, else one
  // deferred flush so the final value of a burst is never lost.
  const queueSerialDisplayUpdate = () => {
    const now = Date.now()
    if (now - lastSerialFlushRef.current >= 200) {
      lastSerialFlushRef.current = now
      setLatestSerialValue(serialValueRef.current)
    } else if (serialFlushTimerRef.current === null) {
      serialFlushTimerRef.current = setTimeout(() => {
        serialFlushTimerRef.current = null
        lastSerialFlushRef.current = Date.now()
        setLatestSerialValue(serialValueRef.current)
      }, 200)
    }
  }

  const startSerialReading = async (port: SerialPort) => {
    try {
      const textDecoder = new TextDecoderStream()
      // The cast bridges two libs' stream generics: w3c-web-serial types the
      // port as ReadableStream<Uint8Array> while lib.dom types the decoder's
      // sink as WritableStream<BufferSource>; a Uint8Array IS a BufferSource.
      const readableStreamClosed = port.readable!.pipeTo(textDecoder.writable as WritableStream<Uint8Array>)
      const reader = textDecoder.readable.getReader()
      serialReaderRef.current = reader

      console.log("📡 Starting serial data reading...")

      // Read data continuously
      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          console.log("📡 Serial reader closed")
          break
        }

        if (value) {
          // Parse the incoming value as a number
          const trimmedValue = value.trim()
          const numValue = Number.parseFloat(trimmedValue)

          if (!isNaN(numValue)) {
            serialValueRef.current = numValue
            queueSerialDisplayUpdate()
            // Per-line log at serial line rate - debug only, like the packet log.
            if (DEBUG_PACKET_LOG) console.log(`Serial data received: ${numValue}`)
          }
        }
      }
    } catch (err) {
      console.error("Serial reading error:", err)
      if (err instanceof Error && err.message.includes("device has been lost")) {
        setIsSerialConnected(false)
        setSerialPort(null)
      }
    }
  }

  const disconnectSerial = async () => {
    try {
      if (serialReaderRef.current) {
        await serialReaderRef.current.cancel()
        serialReaderRef.current = null
      }

      if (serialPort) {
        await serialPort.close()
        setSerialPort(null)
      }

      setIsSerialConnected(false)
      serialValueRef.current = 0
      // Cancel any deferred display flush so it cannot resurrect a stale value
      // after the zeroing below.
      if (serialFlushTimerRef.current !== null) {
        clearTimeout(serialFlushTimerRef.current)
        serialFlushTimerRef.current = null
      }
      setLatestSerialValue(0)
      console.log("🔌 Serial port disconnected")
    } catch (err) {
      console.error("Serial disconnect error:", err)
    }
  }

  // Connect to a reference power meter via the standard Cycling Power Service
  const connectReferencePowerMeter = async () => {
    try {
      // Bound once and reused below, so the availability check covers both
      // chooser calls (typed via @types/web-bluetooth).
      const ble = navigator.bluetooth
      if (!ble) {
        setError("Web Bluetooth API is not supported in this browser.")
        return
      }

      setIsRefConnecting(true)
      setError("")
      console.log("\n🚴 CONNECTING TO REFERENCE POWER METER (CPS)...")
      console.log("CPS Service UUID:", CPS_SERVICE_UUID)

      // This area is the SRM's alone. Our own boards advertise the standard Cycling
      // Power service (0x1818) exactly as a commercial meter does (firmware
      // src/ble/ble_adv.c), so filtering on that service alone lists every CycloWatt
      // board in this chooser next to the real reference meter. Picking one made it
      // the "reference" meter and printed a CycloWatt name inside this card - a
      // measurement compared against itself, presented as an independent reference.
      //
      // Two layers, because neither suffices alone. exclusionFilters keeps our boards
      // out of the chooser, which is the half the user actually sees, but it is
      // Chrome 114+ and older engines reject the whole call. The post-pick check
      // below is the half that GUARANTEES it: Web Bluetooth filters are OR-ed and
      // cannot express "this service but not that name".
      const refRequestOptions: RequestDeviceOptions = {
        filters: [{ services: [CPS_SERVICE_UUID] }],
        optionalServices: [CPS_SERVICE_UUID],
      }

      // .catch rather than try/catch keeps this a single const binding for the
      // whole flow below, whichever chooser call produced it.
      const refCandidate = await ble
        .requestDevice({
          ...refRequestOptions,
          exclusionFilters: BOARD_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
        } as RequestDeviceOptions)
        .catch((err: unknown) => {
          // A cancelled chooser is a DOMException (NotFoundError) and has to keep
          // propagating to the outer catch. Only an engine that does not understand
          // exclusionFilters throws TypeError, and it gets a second, plain chooser
          // rather than a button that appears broken.
          if (!(err instanceof TypeError)) throw err
          console.warn("exclusionFilters unsupported here; relying on the post-pick check")
          return ble.requestDevice(refRequestOptions)
        })

      console.log(`📱 Selected reference device: ${refCandidate.name || "Unknown"} (${refCandidate.id})`)

      // Reject before connecting, so no ref* state is ever touched by one of ours.
      // The id comparison catches the same physical board arriving under a name the
      // prefix list does not know, e.g. a peer that renamed it over GATT.
      if (isBoardName(refCandidate.name) || (refCandidate.id && refCandidate.id === device?.id)) {
        setError(
          `${refCandidate.name || "That device"} is a CycloWatt board, not a reference meter. ` +
            "This panel is for the SRM (or another independent power meter) only - connect a " +
            "CycloWatt board with the sensor connection above instead.",
        )
        console.warn("Rejected a CycloWatt board picked as the reference meter")
        return
      }

      const server = await refCandidate.gatt!.connect()
      console.log("✅ Connected to reference GATT server")

      const cpsService = await server.getPrimaryService(CPS_SERVICE_UUID)
      console.log("✅ Found Cycling Power Service")

      const measurementChar = await cpsService.getCharacteristic(CPS_MEASUREMENT_CHAR_UUID)
      console.log("✅ Found Cycling Power Measurement characteristic")

      measurementChar.addEventListener("characteristicvaluechanged", handleReferencePowerNotification)
      await measurementChar.startNotifications()
      console.log("📡 Reference power notifications started")

      refCharacteristicRef.current = measurementChar
      setRefDevice(refCandidate)
      setIsRefConnected(true)

      refCandidate.addEventListener("gattserverdisconnected", handleReferenceDisconnection)
    } catch (err) {
      console.error("Reference power meter connection failed:", err)
      setError(`Reference power meter connection failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally {
      setIsRefConnecting(false)
    }
  }

  // Parse the standard Cycling Power Measurement characteristic
  const handleReferencePowerNotification = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic
    const dataView = target.value
    if (!dataView || dataView.byteLength < 4) return

    // Byte 0-1: flags (uint16, little-endian)
    // Byte 2-3: instantaneous power (sint16, watts, little-endian)
    const instantaneousPower = dataView.getInt16(2, true)
    refPowerValueRef.current = instantaneousPower
    setLatestRefPower(instantaneousPower)
  }

  const handleReferenceDisconnection = () => {
    console.log("🔌 Reference power meter disconnected")
    setIsRefConnected(false)
    setRefDevice(null)
    refCharacteristicRef.current = null
    refPowerValueRef.current = 0
    setLatestRefPower(0)
  }

  const disconnectReferencePowerMeter = async () => {
    try {
      if (refCharacteristicRef.current) {
        try {
          await refCharacteristicRef.current.stopNotifications()
        } catch {
          // ignore
        }
        refCharacteristicRef.current.removeEventListener(
          "characteristicvaluechanged",
          handleReferencePowerNotification,
        )
      }
      if (refDevice?.gatt?.connected) {
        await refDevice.gatt.disconnect()
      }
      handleReferenceDisconnection()
    } catch (err) {
      console.error("Reference power meter disconnect error:", err)
    }
  }

  // Scan for all available devices
  const scanForDevices = async () => {
    try {
      setIsScanning(true)
      setError("")
      console.log("\n🔍 SCANNING FOR BLUETOOTH DEVICES...")
      console.log("Target Service UUID (post-connect):", CYCLOWATT_SERVICE_UUID)
      console.log("Name-prefix filtering:", useDeviceFilter ? `ENABLED (${BOARD_NAME_PREFIX_HINT})` : "DISABLED")

      // Chrome only lets a page talk to services declared at requestDevice time —
      // the SMP (DFU) service must be in optionalServices on EVERY connect path or
      // the DFU card can't reach it later (decision D1).
      //
      // The filtered branch matches device-name PREFIXES, not the raw-stream service
      // UUID, for the same reason the DFU-only path below does: a services filter can
      // only ever find DAQ boards, because prod images do not advertise the raw-stream
      // service at all. Name prefixes reach both images with one filter list.
      //
      // The DAQ image DOES still advertise that UUID and must keep doing so - it is
      // the capture dongle's only match key - so this is not a workaround for a
      // missing advertisement. But the UUID still has to move into optionalServices:
      // a name filter grants no service access on its own, so without it the chooser
      // would work and raw-stream logging would fail right after connecting.
      const requestOptions: RequestDeviceOptions = useDeviceFilter
        ? {
            filters: BOARD_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
            optionalServices: [
              CYCLOWATT_SERVICE_UUID,
              SMP_SERVICE_UUID,
              // Cycling Power, for the Control Point that starts a calibration.
              // Chrome scopes service access to what was declared HERE, so a grant
              // made before this line existed stays locked out of calibration until
              // the board is re-picked through Scan once.
              CPS_SERVICE_UUID,
              "battery_service",
              "generic_access",
              "generic_attribute",
            ],
          }
        : {
            acceptAllDevices: true,
            optionalServices: [
              CYCLOWATT_SERVICE_UUID,
              SMP_SERVICE_UUID,
              // Cycling Power, for the Control Point that starts a calibration.
              // Chrome scopes service access to what was declared HERE, so a grant
              // made before this line existed stays locked out of calibration until
              // the board is re-picked through Scan once.
              CPS_SERVICE_UUID,
              "battery_service",
              "generic_access",
              "generic_attribute",
            ],
          }

      const device = await navigator.bluetooth.requestDevice(requestOptions)

      console.log(`📱 Selected device: ${device.name || "Unknown"} (${device.id})`)

      // Check if this device has our target service
      let hasTargetService = false
      // The board's own name, read over the probe link below. device.name is the
      // name Chrome cached when the grant was made and never refreshes, so on a
      // board flashed since then it is the OLD name - and this scan path REPLACES
      // the whole row, which is how picking a board through the chooser used to
      // undo a name an advertisement had already corrected.
      let gapName: string | null = null
      // true = the probe left its GATT link OPEN for the auto-connect to adopt.
      // Passed on so a failed connect knows the open link is THIS flow's to
      // release, and not another session's to leave alone.
      let probeLinkOpen = false
      try {
        if (device.gatt) {
          const server = await device.gatt.connect()
          // Read the name FIRST: this is the only moment in the scan with an open
          // link, and the name is wanted even if service probing below throws.
          gapName = await readGapDeviceName(device)
          console.log("✅ Connected to GATT server for scanning")

          try {
            const services = await server.getPrimaryServices()
            console.log(`Found ${services.length} services:`)

            services.forEach((service, index) => {
              const isTarget = service.uuid.toLowerCase() === CYCLOWATT_SERVICE_UUID.toLowerCase()
              console.log(`  ${index + 1}. ${service.uuid} ${isTarget ? "⭐ TARGET SERVICE" : ""}`)
              if (isTarget) hasTargetService = true
            })

            // If we found the target service, check its characteristics
            if (hasTargetService) {
              try {
                const targetService = await server.getPrimaryService(CYCLOWATT_SERVICE_UUID)
                const characteristics = await targetService.getCharacteristics()
                console.log(`\n📡 Target service characteristics:`)
                characteristics.forEach((char, index) => {
                  const isTargetChar = char.uuid.toLowerCase() === CYCLOWATT_DATA_CHAR_UUID.toLowerCase()
                  console.log(`  ${index + 1}. ${char.uuid} ${isTargetChar ? "🎯 DATA CHARACTERISTIC" : ""}`)
                  console.log(`     Properties:`, {
                    read: char.properties.read,
                    write: char.properties.write,
                    notify: char.properties.notify,
                    indicate: char.properties.indicate,
                  })
                })
              } catch (charErr) {
                console.warn("Could not examine target service characteristics:", charErr)
              }
            }
          } catch (serviceErr) {
            console.warn("Could not scan services:", serviceErr)
          }

          // A compatible board is about to be connected for real (see the
          // auto-connect below), so its probe link is HANDED OVER rather than
          // dropped: disconnecting and immediately re-connecting the same device
          // is the Web Bluetooth pattern that intermittently rejects with "GATT
          // operation already in progress", and it costs a second of bench time
          // on every scan. Anything else - a production image, or a probe that
          // threw before finding the service - is released here, because nothing
          // downstream will claim it and the board has ONE peripheral slot: a
          // dangling link stops it advertising and locks out the coupled shoe.
          if (hasTargetService) {
            probeLinkOpen = true
            console.log("🔗 Keeping the scan link open to connect")
          } else {
            await server.disconnect()
            console.log("🔌 Disconnected after scanning")
          }
        }
      } catch (connectErr) {
        console.warn("Could not connect for service scanning:", connectErr)
      }

      // Add to available devices list
      const newDevice: AvailableDevice = {
        device,
        name: gapName || device.name || "Unknown Device",
        id: device.id,
        hasTargetService,
      }

      setAvailableDevices((prev) => {
        const existing = prev.find((d) => d.id === device.id)
        if (existing) {
          // Every other field on the rebuilt row is fresher than the old one, but
          // the NAME may not be: if the GAP read failed, newDevice.name fell back
          // to Chrome's frozen cache, which must not displace a name a previous
          // Device Name read already established. Origin "gap" only when this
          // read actually succeeded, since only an authoritative read earns the
          // right to shorten the name already on the row.
          const name = nextDisplayName(existing.name, newDevice.name, gapName ? "gap" : "advertisement")
          return prev.map((d) => (d.id === device.id ? { ...newDevice, name } : d))
        }
        return [...prev, newDevice]
      })

      console.log(`\n📋 Device added to list: ${newDevice.name} (Target Service: ${hasTargetService ? "✅" : "❌"})`)

      // Straight into the session. The list shows connected boards only, so a
      // picked-but-idle board would be invisible and there would be nothing left
      // to press Connect on - the chooser pick IS the connect gesture now.
      //
      // Gated on the probe above: connectToSpecificDevice needs the raw-stream
      // service and a production image has none, so auto-connecting one would
      // only produce a GATT lookup failure. Say what to do about it instead.
      if (hasTargetService) {
        await connectToSpecificDevice(newDevice, { ownsOpenLink: probeLinkOpen })
      } else {
        setError(
          `${newDevice.name} does not expose the raw-stream service, so it cannot be logged. ` +
            `It is most likely running a production image - use "Connect (firmware-update-only)" ` +
            `on the Firmware Update tab to reach it.`,
        )
      }
    } catch (err) {
      console.error("Device scan failed:", err)
      setError(`Scan failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally {
      setIsScanning(false)
    }
  }

  // Connect to a specific device.
  //
  // `ownsOpenLink` is set by the scan path, which probes over a GATT link and
  // hands it straight to this call rather than closing it. It only affects
  // FAILURE handling: it tells the catch that an already-open link belongs to
  // this flow and may be released. See alreadyLinked.
  const connectToSpecificDevice = async (
    selectedDevice: AvailableDevice,
    { ownsOpenLink = false }: { ownsOpenLink?: boolean } = {},
  ) => {
    // Distinguishes "the link never came up" from "the link came up but the board isn't
    // what we expected" — the two need different error copy (see the catch).
    let gattConnected = false
    // Flips once the page has taken ownership of the link (the state-setter block below).
    // Only a failure BEFORE that point may tear the link down: after it,
    // the page owns a live session and an unsolicited disconnect here would kill it behind
    // the UI's back. Today's post-ownership steps (battery probe, stream start) swallow
    // their own errors, so this guard is currently belt-and-braces — kept explicit so a
    // future throw added after ownership can't silently start tearing sessions down.
    let sessionOwned = false
    // Was the link ALREADY up before this call? gatt.connect() on an
    // already-connected server resolves instantly as a no-op, so gattConnected
    // alone cannot tell "this call opened the link" from "someone else's link
    // was already open". Without this, picking the LIVE reference CPS meter out
    // of the chooser — its session is tracked by isRefConnected, not
    // isConnected, so nothing here knows it is in use — would make the catch
    // below tear down the reference capture mid-recording. Only release a link
    // this call actually opened, or one the caller has explicitly handed over
    // (see ownsOpenLink).
    const alreadyLinked = !!selectedDevice.device.gatt?.connected && !ownsOpenLink
    try {
      setError("")
      console.log(`\n🔗 CONNECTING TO: ${selectedDevice.name}`)
      console.log(`Device ID: ${selectedDevice.id}`)
      console.log(`Has Target Service: ${selectedDevice.hasTargetService}`)

      const device = selectedDevice.device
      const server = await device.gatt!.connect()
      gattConnected = true
      console.log("✅ Connected to GATT server")

      // Get the CycloWatt service
      const cycloWattService = await server.getPrimaryService(CYCLOWATT_SERVICE_UUID)
      console.log("✅ Found CycloWatt service:", CYCLOWATT_SERVICE_UUID)

      // Get the data characteristic
      const dataCharacteristic = await cycloWattService.getCharacteristic(CYCLOWATT_DATA_CHAR_UUID)
      console.log("✅ Found data characteristic:", CYCLOWATT_DATA_CHAR_UUID)

      console.log("📋 Characteristic properties:", {
        broadcast: dataCharacteristic.properties.broadcast,
        read: dataCharacteristic.properties.read,
        writeWithoutResponse: dataCharacteristic.properties.writeWithoutResponse,
        write: dataCharacteristic.properties.write,
        notify: dataCharacteristic.properties.notify,
        indicate: dataCharacteristic.properties.indicate,
      })

      // Verify notification support
      if (!dataCharacteristic.properties.notify && !dataCharacteristic.properties.indicate) {
        throw new Error("Data characteristic does not support notifications")
      }

      setDevice(device)
      setService(cycloWattService)
      setCharacteristic(dataCharacteristic)
      setIsConnected(true)
      setConnectionMode("normal")
      sessionOwned = true

      device.addEventListener("gattserverdisconnected", handleDisconnection)

      // Ask the board for its current GAP name now that a link exists, and both
      // correct its row and stamp the CSV filename's build from that one read.
      // device.name is only the fallback: it is whatever Chrome cached when the
      // grant was made, so on a board flashed since then it names the OLD build.
      const gapName = await syncNameFromGatt(device)
      // Latch the build for the CSV filename while the name is in hand.
      setConnectedFwVersion(firmwareVersionFromName(gapName ?? device.name))

      console.log("🎉 CONNECTION SUCCESSFUL!")
      console.log("🚀 Ready to start data streaming...")

      // Battery is best-effort: an absent service (old grant / non-CycloWatt device) must
      // not fail the connect. Web Bluetooth subtlety — if the device was granted BEFORE
      // "battery_service" was listed in optionalServices, getPrimaryService throws
      // SecurityError, which the catch treats as "no battery shown"; re-picking the device
      // through the chooser once repairs the grant. The listener is attached BEFORE
      // startNotifications so the first notification can't be missed.
      try {
        const batteryService = await server.getPrimaryService("battery_service")
        const batteryChar = await batteryService.getCharacteristic("battery_level")
        const initial = await batteryChar.readValue()
        setBatteryLevel(initial.getUint8(0))
        const batteryHandler = (event: Event) => {
          const value = (event.target as BluetoothRemoteGATTCharacteristic).value
          if (value) setBatteryLevel(value.getUint8(0))
        }
        batteryChar.addEventListener("characteristicvaluechanged", batteryHandler)
        // Remembered so handleDisconnection can detach the listener.
        batteryCharacteristicRef.current = batteryChar
        batteryHandlerRef.current = batteryHandler
        await batteryChar.startNotifications()
        console.log("🔋 Battery Service subscribed")
      } catch (batteryErr) {
        // No reset here: batteryLevel is already null on entry to any connect path (initial
        // state, and handleDisconnection clears it on every disconnect route), so the panel
        // omits the line by itself. Nulling would instead discard a good reading in the case
        // where readValue succeeded and only startNotifications failed — that value is kept,
        // it just won't refresh.
        console.warn("No battery level available (service not granted/present):", batteryErr)
      }

      // Auto-start streaming
      await startDataStreaming(dataCharacteristic)
    } catch (err) {
      console.error("Connection failed:", err)
      const message = err instanceof Error ? err.message : "Unknown error"

      // Release the link on a failed connect. The board has ONE peripheral slot: leaving a
      // dangling GATT connection makes it stop advertising and locks out the coupled shoe /
      // head unit — i.e. it manufactures the very "single BLE slot is taken" state the copy
      // below warns about. Only safe while the page hasn't taken ownership (see sessionOwned),
      // and only for a link THIS call opened (see alreadyLinked); if gatt never connected
      // there is nothing to release.
      if (gattConnected && !alreadyLinked && !sessionOwned) {
        selectedDevice.device.gatt?.disconnect()
        console.log("🔌 Released the GATT link after a failed connect")
      }

      if (gattConnected) {
        // The link came up, so the board is awake and reachable — the failure is about
        // what it exposes (e.g. a prod image with no raw-stream service, or a granted
        // non-CycloWatt device). Don't blame sleep or a busy radio here.
        setError(`Connection failed: ${message}`)
      } else {
        // On this hardware an unreachable-but-recently-advertising board is almost always
        // one of two things, and Chrome's raw error ("Bluetooth Device is no longer in
        // range" / "connection attempt failed") says neither. Name both so the bench user
        // acts instead of retrying blindly.
        setError(
          `Could not connect to ${selectedDevice.name}. If it advertised recently it is likely either ` +
            `asleep (inactivity power-off — move or tap the shoe to wake it) or its single BLE slot is ` +
            `taken (coupled to the other shoe, or a head unit is connected). Original error: ${message}`,
        )
      }
    }
  }

  const handleDisconnection = () => {
    console.log("🔌 Device disconnected")
    setIsConnected(false)
    setIsStreaming(false)
    setDevice(null)
    setService(null)
    setCharacteristic(null)
    // Detach the battery listener with the session it belongs to - reconnecting
    // subscribes afresh, and a leftover listener would double-fire then.
    if (batteryCharacteristicRef.current && batteryHandlerRef.current) {
      batteryCharacteristicRef.current.removeEventListener(
        "characteristicvaluechanged",
        batteryHandlerRef.current,
      )
    }
    batteryCharacteristicRef.current = null
    batteryHandlerRef.current = null
    setBatteryLevel(null)
    // Any disconnect ends the session's mode. Without this, a DFU-only session
    // would leave the logging UI hidden until a successful raw-stream connect —
    // which a freshly-flashed prod image (no raw-stream service) can never provide.
    // The DFU card is unaffected: it stays mounted and keeps its own device ref.
    setConnectionMode("normal")
    // Deliberately NOT refreshing the name here. A session can end with the board
    // carrying a different name than it started with (a DFU rename), but the only
    // trustworthy source is a Device Name read over an open link, and by now the
    // link is gone. Chrome's cached BluetoothDevice.name is no substitute - reading
    // it here is precisely what used to overwrite a corrected row with a stale
    // name. The row self-corrects on the next advertisement or the next connect.
  }

  const disconnect = async () => {
    try {
      if (device?.gatt?.connected) {
        await device.gatt.disconnect()
      }
      handleDisconnection()
    } catch (err) {
      setError(`Disconnect error: ${err instanceof Error ? err.message : "Unknown error"}`)
    }
  }

  // DFU-only connect mode (decision D1). Prod images don't advertise the raw-stream
  // service, and the SMP service isn't in ANY variant's advertising payload (Chrome
  // chooser filters match advertised data only) — so the chooser filters on the
  // device-name PREFIXES the firmware uses (BOARD_NAME_PREFIXES owns the list and
  // the reason each entry is in it). Names carry a " v<version>" suffix, and a DAQ
  // board's 11-char on-air name truncates it away, but the base prefix always
  // survives, so namePrefix matching is unaffected.
  const connectDfuOnly = async () => {
    try {
      setError("")
      console.log("\n🔧 CONNECTING IN DFU-ONLY MODE...")
      const dfuDevice = await navigator.bluetooth.requestDevice({
        filters: BOARD_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
        optionalServices: [
          SMP_SERVICE_UUID,
          CYCLOWATT_SERVICE_UUID,
          // Cycling Power, so calibration is reachable in this mode too - which
          // matters most here: a production image has no raw-stream service, so
          // firmware-update-only is the ONLY way such a board connects at all.
          CPS_SERVICE_UUID,
          "battery_service",
          "generic_access",
          "generic_attribute",
        ],
      })
      await dfuDevice.gatt!.connect()
      console.log(`✅ DFU-only connection to: ${dfuDevice.name || "Unknown"} (${dfuDevice.id})`)
      // Register the row this mode connects through, so the connected-device list
      // is right in BOTH modes. It used to be populated only by Scan, which was
      // invisible while the list also carried every remembered device; now that a
      // row means "this is the connected board", a missing one is a lie.
      // hasTargetService stays false - nothing here probed for it, and a board
      // reached this way most often genuinely lacks it.
      setAvailableDevices((prev) => {
        // An existing row is left ALONE rather than rebuilt. Everything this path
        // could put on it is worse than what is already there: its name is
        // Chrome's cache, frozen at grant time, and its hasTargetService is a
        // guess where a scan's is a measurement.
        if (prev.some((d) => d.id === dfuDevice.id)) return prev
        return [
          ...prev,
          {
            device: dfuDevice,
            name: dfuDevice.name || "Unknown Device",
            id: dfuDevice.id,
            hasTargetService: false,
          },
        ]
      })
      setDevice(dfuDevice)
      setIsConnected(true)
      setConnectionMode("dfu")
      dfuDevice.addEventListener("gattserverdisconnected", handleDisconnection)
      // Same reason as the normal connect path - and this one matters most: a
      // DFU-only session is usually opened to flash the board, so its name is
      // about to change, and the row should start from the truth.
      await syncNameFromGatt(dfuDevice)
    } catch (err) {
      console.error("DFU-only connection failed:", err)
      setError(`DFU connect failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    }
  }

  // The decode itself lives in lib/raw-stream/packet.ts (pure, and pinned by
  // test vectors). What stays here is what only the page can supply: the two
  // stamped values that are not on the wire, and the per-packet debug log, which
  // needs the packet COUNTER the page owns.
  const parseDataPacket = (dataView: DataView): DataPoint | null => {
    const labelDate = new Date()
    const dataPoint = parsePacket(dataView, {
      timestamp: labelDate,
      referencePower: refPowerValueRef.current,
      synchronization: serialValueRef.current,
    })
    if (!dataPoint) return null

    if (DEBUG_PACKET_LOG) {
      const iso = labelDate.toISOString()
      const { tick, ticksMcu, force0, force1, force2, force3, force4, force5, power } = dataPoint
      const { accelX, accelY, accelZ, gyroX, gyroY, gyroZ } = dataPoint
      console.log(`[${iso}] Packet #${packetCountRef.current + 1} tick=${tick} ticksMcu=${ticksMcu}`)
      console.log(
        `[${iso}] Force=[${force0}, ${force1}, ${force2}, ${force3}, ${force4}, ${force5}] PowerSlot=${power}`,
      )
      console.log(
        `[${iso}] Accel=[${accelX}, ${accelY}, ${accelZ}] Gyro=[${gyroX}, ${gyroY}, ${gyroZ}] Sync=${serialValueRef.current}`,
      )
    }

    return dataPoint
  }

  // Start data streaming
  const startDataStreaming = async (charOverride?: BluetoothRemoteGATTCharacteristic) => {
    try {
      const activeCharacteristic = charOverride ?? characteristic
      if (!activeCharacteristic) {
        throw new Error("No characteristic available for streaming")
      }

      console.log("\n🚀 STARTING DATA STREAMING...")
      console.log("Service UUID:", CYCLOWATT_SERVICE_UUID)
      console.log("Characteristic UUID:", CYCLOWATT_DATA_CHAR_UUID)

      // Set up data handler
      const handleNotification = (event: Event) => {
        const target = event.target as BluetoothRemoteGATTCharacteristic
        const dataView = target.value

        if (dataView) {
          packetCountRef.current++
          const now = Date.now()

          // Calculate packets per second
          const timeSinceLastPacket = now - lastPacketTimeRef.current
          lastPacketTimeRef.current = now

          const dataPoint = parseDataPacket(dataView)
          if (dataPoint) {
            // Charts always get the sample; the export buffer only while the
            // CSV switch is on (read via the ref - this closure is created once
            // at stream start and never sees later state values).
            chartBufferRef.current.push(dataPoint)
            if (csvCaptureEnabledRef.current) {
              dataBufferRef.current.push(dataPoint)
            }
            sampleCountRef.current++

            // Update charts periodically (every 100 ms) - but not while the tab
            // is hidden: rendering five charts nobody can see is pure waste.
            // Buffers keep filling regardless, and the first tick after the tab
            // becomes visible again catches the display up.
            if (document.visibilityState === "visible" && now - lastUpdateRef.current > 100) {
              updateCharts()
            }
          }
        }
      }

      // Remove any previously attached handler to avoid stacking duplicate listeners
      if (streamingCharacteristicRef.current && notificationHandlerRef.current) {
        streamingCharacteristicRef.current.removeEventListener(
          "characteristicvaluechanged",
          notificationHandlerRef.current,
        )
      }

      // Add event listener and remember it so we can remove it on stop
      activeCharacteristic.addEventListener("characteristicvaluechanged", handleNotification)
      notificationHandlerRef.current = handleNotification
      streamingCharacteristicRef.current = activeCharacteristic

      // Start notifications
      await activeCharacteristic.startNotifications()
      console.log("✅ Notifications started successfully!")

      setIsStreaming(true)
      startTimeRef.current = Date.now()
      sampleCountRef.current = 0
      packetCountRef.current = 0
      dataBufferRef.current = []
      chartBufferRef.current = []
      setRecordedCount(0)

      console.log("📡 Listening for 16x int32 data packets (64 bytes)...")
    } catch (err) {
      console.error("❌ Failed to start streaming:", err)
      setError(`Failed to start streaming: ${err instanceof Error ? err.message : "Unknown error"}`)
    }
  }

  const stopDataStreaming = async () => {
    try {
      // Remove the notification listener so restarting doesn't stack duplicate handlers
      if (streamingCharacteristicRef.current && notificationHandlerRef.current) {
        streamingCharacteristicRef.current.removeEventListener(
          "characteristicvaluechanged",
          notificationHandlerRef.current,
        )
        notificationHandlerRef.current = null
      }

      if (characteristic) {
        await characteristic.stopNotifications()
        console.log("⏹️ Data streaming stopped")
      }
      setIsStreaming(false)
    } catch (err) {
      setError(`Failed to stop streaming: ${err instanceof Error ? err.message : "Unknown error"}`)
    }
  }

  const exportToCSV = () => {
    // The recording lives in the ref, not in state - see recordedCount.
    const recorded = dataBufferRef.current
    if (recorded.length === 0) return

    // Columns, rows and filename all live in lib/raw-stream/csv.ts, where the
    // 17 header strings are pinned by test - bench analysis scripts select them
    // by name. What is left here is the Blob/anchor download dance, which needs
    // a document.
    const csvContent = rawStreamToCsv(recorded)

    const blob = new Blob([csvContent], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    // Read the LATCH, not `device?.name`: the usual bench order is record →
    // disconnect → export, and by export time handleDisconnection has already
    // nulled `device` while the recording survives and Export stays enabled — parsing
    // the live name here dropped the _fw tag exactly when it mattered most. The
    // live name is only a fallback for a session that predates the latch.
    a.download = rawCsvFilename(new Date(), connectedFwVersion ?? firmwareVersionFromName(device?.name))
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const resetAllZoom = () => {
    setForceAZoom({})
    setForceBZoom({})
    setAccelZoom({})
    setGyroZoom({})
    setPowerZoom({})
  }

  return (
    <div className="min-h-screen bg-white">
      {/* Branded Header */}
      <div className="bg-black text-white shadow-lg border-b border-gray-800">
        <div className="container mx-auto px-6 py-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <img src={logoBlack.src} alt="CycloWatt Logo" className="h-32 w-32 object-contain" />
              <div>
                <h1 className="text-4xl font-bold tracking-tight text-white">CycloWatt</h1>
                <p className="text-gray-300 text-lg font-medium">Bluetooth Data Streamer</p>
                <p className="text-gray-400 text-sm">Service: {CYCLOWATT_SERVICE_UUID}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isConnected ? (
                <Badge variant="secondary" className="bg-green-600 text-white border-green-500 flex items-center gap-1">
                  <Wifi className="w-3 h-3" />
                  Connected
                </Badge>
              ) : (
                <Badge
                  variant="secondary"
                  className="bg-gray-700 text-gray-300 border-gray-600 flex items-center gap-1"
                >
                  <WifiOff className="w-3 h-3" />
                  Disconnected
                </Badge>
              )}
              {isConnected && (
                <Badge
                  variant="secondary"
                  className={`${isStreaming ? "bg-blue-600 text-white border-blue-500" : "bg-gray-500 text-white border-gray-400"} flex items-center gap-1`}
                >
                  {isStreaming ? "Streaming Active" : "Streaming Paused"}
                </Badge>
              )}
              {isSerialConnected ? (
                <Badge
                  variant="secondary"
                  className="bg-purple-600 text-white border-purple-500 flex items-center gap-1"
                >
                  <Cable className="w-3 h-3" />
                  Serial Connected
                </Badge>
              ) : (
                <Badge
                  variant="secondary"
                  className="bg-gray-700 text-gray-300 border-gray-600 flex items-center gap-1"
                >
                  <Cable className="w-3 h-3" />
                  Serial Disconnected
                </Badge>
              )}
              {isRefConnected && (
                <Badge variant="secondary" className="bg-sky-600 text-white border-sky-500 flex items-center gap-1">
                  <Wifi className="w-3 h-3" />
                  Ref Meter Connected
                </Badge>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="w-full p-6 space-y-6">
        {/* Browser Compatibility Warnings */}
        {(!bluetoothSupported || !isSecureContext || !serialSupported) && (
          <Alert variant="destructive" className="bg-red-50 border-red-200 text-red-800">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {!bluetoothSupported && "Web Bluetooth API is not supported in this browser. "}
              {!serialSupported && "Web Serial API is not supported in this browser. "}
              {!isSecureContext && "Bluetooth and Serial require HTTPS or localhost. "}
              Please use Chrome, Edge, or Opera and ensure you're on HTTPS or localhost.
            </AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive" className="bg-red-50 border-red-200 text-red-800">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Tabs defaultValue="streaming">
          <TabsList className="grid w-full max-w-md grid-cols-3">
            <TabsTrigger value="streaming">Data Streaming</TabsTrigger>
            <TabsTrigger value="firmware">Firmware Update</TabsTrigger>
            <TabsTrigger value="trainer">Trainer</TabsTrigger>
          </TabsList>

          {/* Both panels are forceMount-ed: an in-flight DFU flow and the recorded
              chart data must survive tab switches. With forceMount Radix never sets
              its own `hidden` attribute, so the inactive panel is hidden via the
              data-state class — do not drop it, or both tabs render at once. */}
          <TabsContent value="streaming" forceMount className="mt-4 space-y-6 data-[state=inactive]:hidden">
            {connectionMode === "normal" && (
              <Card className="bg-white border-gray-200">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Cable className="w-5 h-5" />
                    Serial Synchronization Input
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-2 items-center">
                    {!isSerialConnected ? (
                      <Button onClick={connectSerial} disabled={!serialSupported || !isSecureContext} variant="outline">
                        Connect Serial Port
                      </Button>
                    ) : (
                      <Button onClick={disconnectSerial} variant="outline">
                        Disconnect Serial
                      </Button>
                    )}
                    {isSerialConnected && (
                      <div className="text-sm text-gray-600 p-3 bg-purple-50 border border-purple-200 rounded-lg">
                        <div className="font-medium">Serial Port Connected</div>
                        <div>Latest Value: {latestSerialValue}</div>
                        <div className="text-xs text-gray-500 mt-1">This value is logged with each Bluetooth data packet</div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Reference Power Meter */}
            {connectionMode === "normal" && (
              <Card className="bg-white border-gray-200">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Wifi className="w-5 h-5" />
                    Reference Power Meter (Cycling Power Service)
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-2 items-center flex-wrap">
                    {!isRefConnected ? (
                      <Button
                        onClick={connectReferencePowerMeter}
                        disabled={!bluetoothSupported || !isSecureContext || isRefConnecting}
                        variant="outline"
                      >
                        {isRefConnecting ? "Connecting..." : "Connect Reference Power Meter"}
                      </Button>
                    ) : (
                      <Button onClick={disconnectReferencePowerMeter} variant="outline">
                        Disconnect Reference Meter
                      </Button>
                    )}
                    {isRefConnected && (
                      <div className="text-sm text-gray-600 p-3 bg-sky-50 border border-sky-200 rounded-lg">
                        <div className="font-medium">{refDevice?.name || "Reference Power Meter"} Connected</div>
                        <div>Latest Power: {latestRefPower} W</div>
                        <div className="text-xs text-gray-500 mt-1">
                          Logged with each packet and shown on the Power chart in blue
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Device Discovery */}
            <Card className="bg-white border-gray-200">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Search className="w-5 h-5" />
                  Device Discovery
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center space-x-2 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                  <Switch
                    id="device-filter"
                    checked={useDeviceFilter}
                    onCheckedChange={setDeviceFilter}
                    disabled={isConnected}
                  />
                  <Label htmlFor="device-filter" className="cursor-pointer">
                    <div className="font-medium">Show only CycloWatt boards</div>
                    <div className="text-xs text-gray-500">
                      {useDeviceFilter
                        ? `Only devices named ${BOARD_NAME_PREFIX_HINT} will appear`
                        : "All Bluetooth devices will appear in the scan"}
                    </div>
                  </Label>
                </div>

                <div className="flex items-center space-x-2 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                  {/* Deliberately NOT disabled while connected/streaming: pausing
                      capture mid-session (e.g. between test runs) is the point. */}
                  <Switch id="csv-capture" checked={csvCaptureEnabled} onCheckedChange={setCsvCapture} />
                  <Label htmlFor="csv-capture" className="cursor-pointer">
                    <div className="font-medium">Record samples for CSV export</div>
                    <div className="text-xs text-gray-500">
                      {csvCaptureEnabled
                        ? "Every received sample is kept in memory and included in Export to CSV"
                        : "Charts stay live, but new samples are not recorded - already-recorded samples are kept"}
                    </div>
                  </Label>
                </div>

                <div className="flex gap-2">
                  <Button
                    onClick={scanForDevices}
                    disabled={!bluetoothSupported || !isSecureContext || isScanning || isConnected}
                  >
                    {/* One gesture now: the chooser pick is the connect, so the
                        label says so rather than promising a list to choose from
                        afterwards. */}
                    {isScanning ? "Connecting..." : "Scan & Connect"}
                  </Button>
                  {isConnected && (
                    <Button variant="outline" onClick={disconnect}>
                      Disconnect
                    </Button>
                  )}
                </div>

                {isConnected && connectionMode === "normal" && (
                  <div className="flex gap-2 flex-wrap">
                    {!isStreaming ? (
                      <Button onClick={() => startDataStreaming()} variant="default">
                        Start Streaming
                      </Button>
                    ) : (
                      <Button onClick={stopDataStreaming} variant="destructive">
                        Stop Streaming
                      </Button>
                    )}
                    <Button onClick={exportToCSV} disabled={recordedCount === 0} className="flex items-center gap-2">
                      <Download className="w-4 h-4" />
                      Export to CSV ({recordedCount.toLocaleString()} samples)
                    </Button>
                  </div>
                )}

                {/* Connected boards ONLY. This used to be an "Available Devices"
                    list carrying every past permission grant, which on a bench
                    with a dozen flashed boards was a dozen rows saying nothing
                    more than "Chrome remembers this one" - and the row an
                    operator actually needed was somewhere inside it. The chooser
                    now doubles as the connect gesture (see scanForDevices), so a
                    row here always means a live link. */}
                {connectedDeviceRow && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium">Connected Device:</h3>
                    <div className="flex items-center justify-between p-3 border rounded-lg">
                      <div className="flex items-center gap-3">
                        <div className="flex flex-col">
                          <span className="font-medium">{connectedDeviceRow.name}</span>
                          <span className="text-xs text-gray-500">{connectedDeviceRow.id}</span>
                        </div>
                        {connectedDeviceRow.hasTargetService && (
                          <Badge variant="secondary" className="bg-green-100 text-green-800 border-green-300">
                            ✅ Compatible
                          </Badge>
                        )}
                      </div>
                      <Button size="sm" variant="outline" disabled>
                        Connected
                      </Button>
                    </div>
                  </div>
                )}

                {isConnected && (
                  <div className="text-sm text-gray-600 p-3 bg-green-50 border border-green-200 rounded-lg">
                    <div className="font-medium">
                      Connected to: {displayedDeviceName}
                    </div>
                    {batteryLevel !== null && <div>Battery: {batteryLevel}%</div>}
                    <div>Service: {CYCLOWATT_SERVICE_UUID}</div>
                    <div>Characteristic: {CYCLOWATT_DATA_CHAR_UUID}</div>
                    <div>Data Format: 16x int32 (6x Force, Accel X/Y/Z, Gyro X/Y/Z, Power, Tick, TicksMCU)</div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Zero-offset force calibration. Shown in BOTH connection modes on
                purpose: a production image has no raw-stream service, so such a
                board only ever connects here in firmware-update-only mode, and
                that is exactly the board most likely to need a tare. */}
            <CalibrationCard device={device} onReading={handleCalibrationReading} />

            {/* Sits directly under the card that writes to it, so a run and its
                new row are visible together without scrolling. */}
            <CalibrationHistoryCard
              records={calibrationHistory}
              onDelete={(id) => setCalibrationHistory(deleteCalibrationRecord(id))}
              onClear={() => setCalibrationHistory(clearCalibrationHistory())}
            />

            {/* Statistics */}
            {connectionMode === "normal" && (
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <Card className="bg-white border-gray-200">
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold">{stats.totalSamples.toLocaleString()}</div>
                    <p className="text-xs text-gray-600">Total Samples</p>
                  </CardContent>
                </Card>
                <Card className="bg-white border-gray-200">
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold">{stats.samplingRate.toFixed(1)} Hz</div>
                    <p className="text-xs text-gray-600">Sampling Rate</p>
                  </CardContent>
                </Card>
                <Card className="bg-white border-gray-200">
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold">{stats.packetsPerSecond.toFixed(1)} pps</div>
                    <p className="text-xs text-gray-600">Packets/Second</p>
                  </CardContent>
                </Card>
                <Card className="bg-white border-gray-200">
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold">{stats.duration.toFixed(1)}s</div>
                    <p className="text-xs text-gray-600">Duration</p>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Charts - one memoized card each (see sensor-chart-card.tsx): they
                re-render on chart ticks, visibility toggles and brush moves, and
                skip the page's other re-renders (serial lines, battery, ref power). */}
            {connectionMode === "normal" && (
              <div className="grid grid-cols-1 gap-6">
                <SensorChartCard
                  title="Force - first channel per position (Channels 0, 1, 2)"
                  lines={FORCE_LINES_A}
                  data={chartData}
                  config={CHART_CONFIG}
                  visibility={lineVisibility}
                  zoom={forceAZoom}
                  range={forceARange}
                  onZoomChange={setForceAZoom}
                  onRangeChange={setForceARange}
                  onToggleLine={toggleLine}
                />
                <SensorChartCard
                  title="Force - second channel per position (Channels 3, 4, 5)"
                  lines={FORCE_LINES_B}
                  data={chartData}
                  config={CHART_CONFIG}
                  visibility={lineVisibility}
                  zoom={forceBZoom}
                  range={forceBRange}
                  onZoomChange={setForceBZoom}
                  onRangeChange={setForceBRange}
                  onToggleLine={toggleLine}
                />
                <SensorChartCard
                  title="Acceleration Data (g)"
                  lines={ACCEL_LINES}
                  data={chartData}
                  config={CHART_CONFIG}
                  visibility={lineVisibility}
                  zoom={accelZoom}
                  range={accelRange}
                  onZoomChange={setAccelZoom}
                  onRangeChange={setAccelRange}
                  onToggleLine={toggleLine}
                />
                <SensorChartCard
                  title="Gyroscope Data (rad/s)"
                  lines={GYRO_LINES}
                  data={chartData}
                  config={CHART_CONFIG}
                  visibility={lineVisibility}
                  zoom={gyroZoom}
                  range={gyroRange}
                  onZoomChange={setGyroZoom}
                  onRangeChange={setGyroRange}
                  onToggleLine={toggleLine}
                />
                <SensorChartCard
                  title="Power Data (W) - Reference meter (board power unused)"
                  lines={POWER_LINES}
                  data={chartData}
                  config={CHART_CONFIG}
                  visibility={lineVisibility}
                  zoom={powerZoom}
                  range={powerRange}
                  onZoomChange={setPowerZoom}
                  onRangeChange={setPowerRange}
                  onToggleLine={toggleLine}
                />
              </div>
            )}

            {/* Chart Controls */}
            {connectionMode === "normal" && (
              <Card className="bg-white border-gray-200">
                <CardHeader>
                  <CardTitle>Chart Controls</CardTitle>
                </CardHeader>
                <CardContent className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={resetAllZoom}
                    /* isZoomed, not startIndex truthiness: a brush that starts on
                       the very first sample (index 0) is still a zoom. */
                    disabled={![forceAZoom, forceBZoom, accelZoom, gyroZoom, powerZoom].some(isZoomed)}
                  >
                    Reset All Zoom
                  </Button>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="firmware" forceMount className="mt-4 space-y-6 data-[state=inactive]:hidden">
            <Card className="bg-white border-gray-200">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Wifi className="w-5 h-5" />
                  Device Connection
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-gray-500">
                  Connect here to update a sensor without streaming (works with production firmware, which
                  does not advertise the raw-stream service). A sensor already connected on the Data
                  Streaming tab can be updated directly below.
                </p>
                <div className="flex gap-2">
                  <Button
                    onClick={connectDfuOnly}
                    disabled={!bluetoothSupported || !isSecureContext || isConnected}
                  >
                    Connect for Firmware Update
                  </Button>
                  {isConnected && (
                    <Button variant="outline" onClick={disconnect}>
                      Disconnect
                    </Button>
                  )}
                </div>
                {isConnected && (
                  <div className="text-sm text-gray-600 p-3 bg-green-50 border border-green-200 rounded-lg">
                    <div className="font-medium">
                      Connected to: {displayedDeviceName}{" "}
                      {connectionMode === "dfu" ? "(firmware-update-only)" : "(streaming connection)"}
                    </div>
                    {batteryLevel !== null && <div>Battery: {batteryLevel}%</div>}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Kept permanently mounted (forceMount on this panel) so an in-flight flow
                (upload, resume, post-reset reconnect) survives tab switches and the
                page's isConnected flapping. */}
            <DfuCard
              device={device}
              isStreaming={isStreaming}
              stopStreaming={stopDataStreaming}
              deviceName={connectedName?.id === device?.id ? connectedName?.name : null}
              onDeviceName={handleFlashedDeviceName}
            />
          </TabsContent>

          {/* forceMount for the same reason the DFU panel gives above: a running
              protocol and the recorded session log must survive tab switches. */}
          <TabsContent value="trainer" forceMount className="mt-4 space-y-6 data-[state=inactive]:hidden">
            <TrainerPanel
              bluetoothAvailable={bluetoothSupported && isSecureContext}
              boardDeviceId={device?.id ?? null}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
