"use client"

import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Brush } from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { Download, Wifi, WifiOff, AlertTriangle, Search, Cable } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import type { RequestDeviceOptions } from "web-bluetooth"
import { SMP_SERVICE_UUID } from "@/lib/smp/client"
import { BOARD_NAME_PREFIXES, BOARD_NAME_PREFIX_HINT, firmwareVersionFromName } from "@/lib/device-name"
import { DfuCard } from "@/components/dfu-card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"

interface DataPoint {
  timestamp: number
  tick: number
  ticksMcu: number
  force0: number
  force1: number
  force2: number
  force3: number
  force4: number
  force5: number
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

interface ChartDataPoint {
  time: string
  force0: number
  force1: number
  force2: number
  force3: number
  force4: number
  force5: number
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

interface AvailableDevice {
  device: BluetoothDevice
  name: string
  id: string
  hasTargetService: boolean
  // true = came from Chrome's list of already-granted devices (getDevices()) rather
  // than from a fresh chooser pick, so the row can say so: it is a permission
  // record, NOT evidence the board is powered on or in range right now.
  remembered: boolean
}

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
  // allData survives and Export stays enabled), and is overwritten by the next
  // successful connect. null = the name carried no parsable version.
  const [connectedFwVersion, setConnectedFwVersion] = useState<string | null>(null)

  const [serialPort, setSerialPort] = useState<SerialPort | null>(null)
  const [isSerialConnected, setIsSerialConnected] = useState(false)
  const [serialSupported, setSerialSupported] = useState<boolean>(true)
  const [latestSerialValue, setLatestSerialValue] = useState<number>(0)

  // Reference power meter (standard Cycling Power Service)
  const [refDevice, setRefDevice] = useState<BluetoothDevice | null>(null)
  const [isRefConnected, setIsRefConnected] = useState(false)
  const [isRefConnecting, setIsRefConnecting] = useState(false)
  const [latestRefPower, setLatestRefPower] = useState<number>(0)

  // Data management
  const [allData, setAllData] = useState<DataPoint[]>([])
  const [chartData, setChartData] = useState<ChartDataPoint[]>([])
  const [stats, setStats] = useState({
    totalSamples: 0,
    samplingRate: 0,
    duration: 0,
    packetsPerSecond: 0,
  })

  const [compressionZoom, setCompressionZoom] = useState<{ startIndex?: number; endIndex?: number }>({})
  const [shearZoom, setShearZoom] = useState<{ startIndex?: number; endIndex?: number }>({})
  const [accelZoom, setAccelZoom] = useState<{ startIndex?: number; endIndex?: number }>({})
  const [gyroZoom, setGyroZoom] = useState<{ startIndex?: number; endIndex?: number }>({})
  const [powerZoom, setPowerZoom] = useState<{ startIndex?: number; endIndex?: number }>({})

  // Per-line visibility for each chart
  const [lineVisibility, setLineVisibility] = useState<Record<string, boolean>>({
    force0: true,
    force2: true,
    force4: true,
    force1: true,
    force3: true,
    force5: true,
    accelX: true,
    accelY: true,
    accelZ: true,
    gyroX: true,
    gyroY: true,
    gyroZ: true,
    power: true,
    referencePower: true,
  })

  const toggleLine = (key: string) => {
    setLineVisibility((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  // Refs for efficient data handling
  const dataBufferRef = useRef<DataPoint[]>([])
  const lastUpdateRef = useRef<number>(Date.now())
  const startTimeRef = useRef<number>(0)
  const sampleCountRef = useRef<number>(0)
  const packetCountRef = useRef<number>(0)
  const lastPacketTimeRef = useRef<number>(Date.now())

  const serialValueRef = useRef<number>(0)
  const serialReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)

  const refPowerValueRef = useRef<number>(0)
  const refCharacteristicRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null)

  // Holds the active notification handler so it can be removed on stop (prevents duplicate listeners)
  const notificationHandlerRef = useRef<((event: Event) => void) | null>(null)
  const streamingCharacteristicRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null)

  // CycloWatt specific UUIDs
  const CYCLOWATT_SERVICE_UUID = "5a1d0001-c7a1-4b2e-9e4f-1a2b3c4d5e6f"
  const CYCLOWATT_DATA_CHAR_UUID = "5a1d0002-c7a1-4b2e-9e4f-1a2b3c4d5e6f"

  // Standard Cycling Power Service (CPS) UUIDs
  const CPS_SERVICE_UUID = "00001818-0000-1000-8000-00805f9b34fb" // cycling_power
  const CPS_MEASUREMENT_CHAR_UUID = "00002a63-0000-1000-8000-00805f9b34fb" // cycling_power_measurement

  // Expected packet: 16 x int32 = 64 bytes
  const EXPECTED_PACKET_SIZE = 64

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

  // List devices the user already granted access to, so repeat flash/test cycles skip
  // the chooser after every page reload. Chrome keeps these grants per-origin and
  // exposes them via navigator.bluetooth.getDevices(); it is NOT in the Web Bluetooth
  // spec's baseline, so it is feature-detected rather than assumed.
  //
  // Caveats intentionally accepted: the list is every past grant on this origin — it can
  // include non-CycloWatt devices and devices whose `gatt` is undefined, and it says
  // nothing about whether a board is powered on or in range. Entries therefore get
  // hasTargetService: false (same as an unprobed scan hit) and only turn "Compatible"
  // once a real scan probes their services.
  useEffect(() => {
    const bt = navigator.bluetooth as (Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> }) | undefined
    if (!bt?.getDevices) return
    void bt
      .getDevices()
      .then((granted) => {
        setAvailableDevices((prev) => {
          // Never overwrite an entry a scan already probed — its hasTargetService is
          // real information, and this effect has none to offer.
          const known = new Set(prev.map((d) => d.id))
          const remembered = granted
            .filter((d) => !known.has(d.id))
            .map((device) => ({
              device,
              name: device.name || "Unknown Device",
              id: device.id,
              hasTargetService: false,
              remembered: true,
            }))
          return [...prev, ...remembered]
        })
      })
      .catch(() => {}) // permission-API hiccups are non-fatal — the user can still Scan
  }, [])

  const chartConfig = {
    force0: {
      label: "Compression Ch 0",
      color: "hsl(var(--chart-1))",
    },
    force2: {
      label: "Compression Ch 2",
      color: "hsl(var(--chart-2))",
    },
    force4: {
      label: "Compression Ch 4",
      color: "hsl(var(--chart-3))",
    },
    force1: {
      label: "Shear Ch 1",
      color: "hsl(var(--chart-1))",
    },
    force3: {
      label: "Shear Ch 3",
      color: "hsl(var(--chart-2))",
    },
    force5: {
      label: "Shear Ch 5",
      color: "hsl(var(--chart-3))",
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
  }

  // Renders clickable legend chips that toggle each line's visibility
  const renderLineToggles = (keys: string[]) => (
    <div className="flex flex-wrap gap-2 px-2 pb-2">
      {keys.map((key) => {
        const config = chartConfig[key as keyof typeof chartConfig]
        const visible = lineVisibility[key]
        return (
          <button
            key={key}
            type="button"
            onClick={() => toggleLine(key)}
            aria-pressed={visible}
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
              visible
                ? "border-gray-300 bg-gray-50 text-gray-900"
                : "border-gray-200 bg-transparent text-gray-400"
            }`}
          >
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: visible ? config.color : "transparent", border: `1px solid ${config.color}` }}
            />
            {config.label}
          </button>
        )
      })}
    </div>
  )

  // Y-axis range derived from only what is actually on screen: the currently visible
  // channels, restricted to the brushed index window. Hiding a channel with a large
  // range therefore rescales the axis around the ones that remain.
  const getYDomain = (
    keys: string[],
    zoom: { startIndex?: number; endIndex?: number },
  ): [number | "auto", number | "auto"] => {
    const visibleKeys = keys.filter((key) => lineVisibility[key])
    if (visibleKeys.length === 0 || chartData.length === 0) return ["auto", "auto"]

    const start = Math.max(0, zoom.startIndex ?? 0)
    const end = Math.min(chartData.length - 1, zoom.endIndex ?? chartData.length - 1)

    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY

    for (let i = start; i <= end; i++) {
      const point = chartData[i]
      if (!point) continue
      for (const key of visibleKeys) {
        const value = point[key as keyof ChartDataPoint]
        if (typeof value !== "number" || !Number.isFinite(value)) continue
        if (value < min) min = value
        if (value > max) max = value
      }
    }

    // No usable samples in this window yet — let recharts pick.
    if (min === Number.POSITIVE_INFINITY) return ["auto", "auto"]

    // Flat signal: give it headroom so the line isn't pinned to an axis edge.
    if (min === max) {
      const pad = Math.abs(min) * 0.1 || 1
      return [min - pad, max + pad]
    }

    const pad = (max - min) * 0.05
    return [min - pad, max + pad]
  }

  const updateCharts = () => {
    const now = Date.now()
    const newData = [...dataBufferRef.current]

    // Keep only last 500 points for chart performance
    const chartPoints = newData.slice(-500).map((point) => ({
      time: new Date(point.timestamp).toLocaleTimeString("en-US", {
        hour12: false,
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 1,
      }),
      force0: point.force0,
      force1: point.force1,
      force2: point.force2,
      force3: point.force3,
      force4: point.force4,
      force5: point.force5,
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
    setAllData(newData)

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
      const port = await (navigator as any).serial.requestPort()
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

  const startSerialReading = async (port: SerialPort) => {
    try {
      const textDecoder = new TextDecoderStream()
      const readableStreamClosed = port.readable!.pipeTo(textDecoder.writable)
      const reader = textDecoder.readable.getReader()
      serialReaderRef.current = reader as any

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
            setLatestSerialValue(numValue)
            console.log(`📥 Serial data received: ${numValue}`)
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
      setLatestSerialValue(0)
      console.log("🔌 Serial port disconnected")
    } catch (err) {
      console.error("Serial disconnect error:", err)
    }
  }

  // Connect to a reference power meter via the standard Cycling Power Service
  const connectReferencePowerMeter = async () => {
    try {
      if (!navigator.bluetooth) {
        setError("Web Bluetooth API is not supported in this browser.")
        return
      }

      setIsRefConnecting(true)
      setError("")
      console.log("\n🚴 CONNECTING TO REFERENCE POWER METER (CPS)...")
      console.log("CPS Service UUID:", CPS_SERVICE_UUID)

      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [CPS_SERVICE_UUID] }],
        optionalServices: [CPS_SERVICE_UUID],
      })

      console.log(`📱 Selected reference device: ${device.name || "Unknown"} (${device.id})`)

      const server = await device.gatt!.connect()
      console.log("✅ Connected to reference GATT server")

      const cpsService = await server.getPrimaryService(CPS_SERVICE_UUID)
      console.log("✅ Found Cycling Power Service")

      const measurementChar = await cpsService.getCharacteristic(CPS_MEASUREMENT_CHAR_UUID)
      console.log("✅ Found Cycling Power Measurement characteristic")

      measurementChar.addEventListener("characteristicvaluechanged", handleReferencePowerNotification)
      await measurementChar.startNotifications()
      console.log("📡 Reference power notifications started")

      refCharacteristicRef.current = measurementChar
      setRefDevice(device)
      setIsRefConnected(true)

      device.addEventListener("gattserverdisconnected", handleReferenceDisconnection)
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
              "battery_service",
              "generic_access",
              "generic_attribute",
            ],
          }

      const device = await navigator.bluetooth.requestDevice(requestOptions)

      console.log(`📱 Selected device: ${device.name || "Unknown"} (${device.id})`)

      // Check if this device has our target service
      let hasTargetService = false
      try {
        if (device.gatt) {
          const server = await device.gatt.connect()
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

          await server.disconnect()
          console.log("🔌 Disconnected after scanning")
        }
      } catch (connectErr) {
        console.warn("Could not connect for service scanning:", connectErr)
      }

      // Add to available devices list
      const newDevice: AvailableDevice = {
        device,
        name: device.name || "Unknown Device",
        id: device.id,
        hasTargetService,
        // Picked through the chooser in this session — the row shows live scan
        // results, so no "(remembered)" hint. This also intentionally clears the
        // flag when a re-scan replaces a remembered entry (see the merge below).
        remembered: false,
      }

      setAvailableDevices((prev) => {
        const existing = prev.find((d) => d.id === device.id)
        if (existing) {
          return prev.map((d) => (d.id === device.id ? newDevice : d))
        }
        return [...prev, newDevice]
      })

      console.log(`\n📋 Device added to list: ${newDevice.name} (Target Service: ${hasTargetService ? "✅" : "❌"})`)
    } catch (err) {
      console.error("Device scan failed:", err)
      setError(`Scan failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    } finally {
      setIsScanning(false)
    }
  }

  // Connect to a specific device
  const connectToSpecificDevice = async (selectedDevice: AvailableDevice) => {
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
    // was already open". Without this, misclicking the remembered row of the
    // live reference CPS meter — whose session is tracked by isRefConnected,
    // not isConnected, so the Connect button stays enabled — would make the
    // catch below tear down the reference capture mid-recording. Only release
    // a link this call actually opened.
    const alreadyLinked = !!selectedDevice.device.gatt?.connected
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
      // Latch the build for the CSV filename now, while the name is in hand.
      setConnectedFwVersion(firmwareVersionFromName(device.name))
      sessionOwned = true

      device.addEventListener("gattserverdisconnected", handleDisconnection)

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
        batteryChar.addEventListener("characteristicvaluechanged", (event) => {
          const value = (event.target as BluetoothRemoteGATTCharacteristic).value
          if (value) setBatteryLevel(value.getUint8(0))
        })
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
    setBatteryLevel(null)
    // Any disconnect ends the session's mode. Without this, a DFU-only session
    // would leave the logging UI hidden until a successful raw-stream connect —
    // which a freshly-flashed prod image (no raw-stream service) can never provide.
    // The DFU card is unaffected: it stays mounted and keeps its own device ref.
    setConnectionMode("normal")
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
          "battery_service",
          "generic_access",
          "generic_attribute",
        ],
      })
      await dfuDevice.gatt!.connect()
      console.log(`✅ DFU-only connection to: ${dfuDevice.name || "Unknown"} (${dfuDevice.id})`)
      setDevice(dfuDevice)
      setIsConnected(true)
      setConnectionMode("dfu")
      dfuDevice.addEventListener("gattserverdisconnected", handleDisconnection)
    } catch (err) {
      console.error("DFU-only connection failed:", err)
      setError(`DFU connect failed: ${err instanceof Error ? err.message : "Unknown error"}`)
    }
  }

  const parseDataPacket = (dataView: DataView): DataPoint | null => {
    if (dataView.byteLength !== EXPECTED_PACKET_SIZE) {
      console.warn(`❌ Invalid packet size: ${dataView.byteLength} bytes, expected ${EXPECTED_PACKET_SIZE}`)
      return null
    }

    try {
      // 6 force channels (load cell values) — raw integers, not scaled
      const force0 = dataView.getInt32(0, true) // index 0 — compression
      const force1 = dataView.getInt32(4, true) // index 1 — shear
      const force2 = dataView.getInt32(8, true) // index 2 — compression
      const force3 = dataView.getInt32(12, true) // index 3 — shear
      const force4 = dataView.getInt32(16, true) // index 4 — compression
      const force5 = dataView.getInt32(20, true) // index 5 — shear

      // Accel — packed as milli-g, so /1000 yields g
      const accelX = dataView.getInt32(24, true) / 1000 // index 6
      const accelY = dataView.getInt32(28, true) / 1000 // index 7
      const accelZ = dataView.getInt32(32, true) / 1000 // index 8

      // Gyro — packed as milli-rad/s, so /1000 yields rad/s
      const gyroX = dataView.getInt32(36, true) / 1000 // index 9
      const gyroY = dataView.getInt32(40, true) / 1000 // index 10
      const gyroZ = dataView.getInt32(44, true) / 1000 // index 11

      // Power — frozen zero-fill slot, never a reading (see chartConfig.power).
      // Parsed and exported anyway so the CSV column set stays stable.
      const power = dataView.getInt32(48, true) // index 12

      // Tick — raw integer
      const tick = dataView.getInt32(52, true) // index 13

      // ticks_mcu is a uint64 split into low/high uint32
      const ticksLow = dataView.getUint32(56, true) // index 14 — lower 32 bits
      const ticksHigh = dataView.getUint32(60, true) // index 15 — upper 32 bits
      const ticksMcu = Number((BigInt(ticksHigh) << 32n) | BigInt(ticksLow))

      const dataPoint: DataPoint = {
        timestamp: Date.now(),
        tick,
        ticksMcu,
        force0,
        force1,
        force2,
        force3,
        force4,
        force5,
        accelX,
        accelY,
        accelZ,
        gyroX,
        gyroY,
        gyroZ,
        power,
        referencePower: refPowerValueRef.current,
        synchronization: serialValueRef.current,
      }

      const timestamp = new Date().toISOString()
      console.log(`📦 [${timestamp}] Packet #${packetCountRef.current + 1} tick=${tick} ticksMcu=${ticksMcu}`)
      console.log(
        `📊 [${timestamp}] Force=[${force0}, ${force1}, ${force2}, ${force3}, ${force4}, ${force5}] PowerSlot=${power}`,
      )
      console.log(
        `🔄 [${timestamp}] Accel=[${accelX}, ${accelY}, ${accelZ}] Gyro=[${gyroX}, ${gyroY}, ${gyroZ}] Sync=${serialValueRef.current}`,
      )

      return dataPoint
    } catch (error) {
      console.error("❌ Error parsing data packet:", error)
      return null
    }
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
            dataBufferRef.current.push(dataPoint)
            sampleCountRef.current++

            // Update charts periodically
            if (now - lastUpdateRef.current > 100) {
              // Update every 100ms
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
    if (allData.length === 0) return

    const headers = [
      "tick",
      "ticks_mcu",
      "force_0",
      "force_1",
      "force_2",
      "force_3",
      "force_4",
      "force_5",
      "accel_x",
      "accel_y",
      "accel_z",
      "gyro_x",
      "gyro_y",
      "gyro_z",
      "power",
      "reference_power",
      "synchronization",
    ]
    const csvContent = [
      headers.join(","),
      ...allData.map((point) =>
        [
          point.tick,
          point.ticksMcu,
          point.force0,
          point.force1,
          point.force2,
          point.force3,
          point.force4,
          point.force5,
          point.accelX,
          point.accelY,
          point.accelZ,
          point.gyroX,
          point.gyroY,
          point.gyroZ,
          point.power,
          point.referencePower,
          point.synchronization,
        ].join(","),
      ),
    ].join("\n")

    const blob = new Blob([csvContent], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    // Stamp the connected board's firmware version into the FILENAME only (CSV
    // content stays byte-identical) so a bench capture is attributable to a build.
    const timestampPart = new Date().toISOString().split("T")[0]
    // Read the LATCH, not `device?.name`: the usual bench order is record →
    // disconnect → export, and by export time handleDisconnection has already
    // nulled `device` while allData survives and Export stays enabled — parsing
    // the live name here dropped the _fw tag exactly when it mattered most. The
    // live name is only a fallback for a session that predates the latch.
    const fwVersion = connectedFwVersion ?? firmwareVersionFromName(device?.name)
    const versionTag = fwVersion ? `_fw${fwVersion}` : ""
    a.download = `cyclowatt_data_${timestampPart}${versionTag}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const resetCompressionZoom = () => setCompressionZoom({})
  const resetShearZoom = () => setShearZoom({})
  const resetAccelZoom = () => setAccelZoom({})
  const resetGyroZoom = () => setGyroZoom({})
  const resetPowerZoom = () => setPowerZoom({})
  const resetAllZoom = () => {
    setCompressionZoom({})
    setShearZoom({})
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
              <img src="/logo_black.png" alt="CycloWatt Logo" className="h-32 w-32 object-contain" />
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
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="streaming">Data Streaming</TabsTrigger>
            <TabsTrigger value="firmware">Firmware Update</TabsTrigger>
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
                    onCheckedChange={setUseDeviceFilter}
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

                <div className="flex gap-2">
                  <Button
                    onClick={scanForDevices}
                    disabled={!bluetoothSupported || !isSecureContext || isScanning || isConnected}
                  >
                    {isScanning ? "Scanning..." : "Scan for Devices"}
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
                    <Button onClick={exportToCSV} disabled={allData.length === 0} className="flex items-center gap-2">
                      <Download className="w-4 h-4" />
                      Export to CSV ({allData.length.toLocaleString()} samples)
                    </Button>
                  </div>
                )}

                {availableDevices.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium">Available Devices:</h3>
                    <div className="grid gap-2">
                      {availableDevices.map((availableDevice) => (
                        <div key={availableDevice.id} className="flex items-center justify-between p-3 border rounded-lg">
                          <div className="flex items-center gap-3">
                            <div className="flex flex-col">
                              <span className="font-medium">
                                {availableDevice.name}{" "}
                                {/* Flags a permission record from a past session, not a live
                                    scan hit — the board may well be asleep or busy. */}
                                {availableDevice.remembered && (
                                  <span className="text-xs text-muted-foreground">(remembered)</span>
                                )}
                              </span>
                              <span className="text-xs text-gray-500">{availableDevice.id}</span>
                            </div>
                            {availableDevice.hasTargetService && (
                              <Badge variant="secondary" className="bg-green-100 text-green-800 border-green-300">
                                ✅ Compatible
                              </Badge>
                            )}
                          </div>
                          <Button
                            size="sm"
                            onClick={() => connectToSpecificDevice(availableDevice)}
                            disabled={isConnected}
                            variant={availableDevice.hasTargetService ? "default" : "outline"}
                          >
                            Connect
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {isConnected && (
                  <div className="text-sm text-gray-600 p-3 bg-green-50 border border-green-200 rounded-lg">
                    <div className="font-medium">Connected to: {device?.name || "Unknown Device"}</div>
                    {batteryLevel !== null && <div>Battery: {batteryLevel}%</div>}
                    <div>Service: {CYCLOWATT_SERVICE_UUID}</div>
                    <div>Characteristic: {CYCLOWATT_DATA_CHAR_UUID}</div>
                    <div>Data Format: 16x int32 (6x Force, Accel X/Y/Z, Gyro X/Y/Z, Power, Tick, TicksMCU)</div>
                  </div>
                )}
              </CardContent>
            </Card>

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

            {/* Charts */}
            {connectionMode === "normal" && (
              <div className="grid grid-cols-1 gap-6">
                {/* Compression Force Chart */}
                <Card className="bg-white border-gray-200">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle>Compression Force (Channels 0, 2, 4)</CardTitle>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={resetCompressionZoom}
                      disabled={!compressionZoom.startIndex && !compressionZoom.endIndex}
                    >
                      Reset Zoom
                    </Button>
                  </CardHeader>
                  <CardContent className="p-2">
                    {renderLineToggles(["force0", "force2", "force4"])}
                    <ChartContainer config={chartConfig} className="h-[400px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 50 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                          <XAxis
                            dataKey="time"
                            tick={false}
                            axisLine={false}
                            domain={["dataMin", "dataMax"]}
                            type="category"
                          />
                          <YAxis
                            tick={{ fontSize: 10 }}
                            width={60}
                            domain={getYDomain(["force0", "force2", "force4"], compressionZoom)}
                            allowDataOverflow
                          />
                          <ChartTooltip content={<ChartTooltipContent />} />
                          <Line
                            type="monotone"
                            dataKey="force0"
                            stroke="var(--color-force0)"
                            strokeWidth={2}
                            dot={false}
                            name="Channel 0"
                            isAnimationActive={false}
                            hide={!lineVisibility.force0}
                          />
                          <Line
                            type="monotone"
                            dataKey="force2"
                            stroke="var(--color-force2)"
                            strokeWidth={2}
                            dot={false}
                            name="Channel 2"
                            isAnimationActive={false}
                            hide={!lineVisibility.force2}
                          />
                          <Line
                            type="monotone"
                            dataKey="force4"
                            stroke="var(--color-force4)"
                            strokeWidth={2}
                            dot={false}
                            name="Channel 4"
                            isAnimationActive={false}
                            hide={!lineVisibility.force4}
                          />
                          <Brush
                            dataKey="time"
                            height={30}
                            stroke="var(--color-force0)"
                            startIndex={compressionZoom.startIndex}
                            endIndex={compressionZoom.endIndex}
                            onChange={(brushData) => {
                              if (brushData) {
                                setCompressionZoom({
                                  startIndex: brushData.startIndex,
                                  endIndex: brushData.endIndex,
                                })
                              }
                            }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </ChartContainer>
                  </CardContent>
                </Card>

                {/* Shear Force Chart */}
                <Card className="bg-white border-gray-200">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle>Shear Force (Channels 1, 3, 5)</CardTitle>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={resetShearZoom}
                      disabled={!shearZoom.startIndex && !shearZoom.endIndex}
                    >
                      Reset Zoom
                    </Button>
                  </CardHeader>
                  <CardContent className="p-2">
                    {renderLineToggles(["force1", "force3", "force5"])}
                    <ChartContainer config={chartConfig} className="h-[400px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 50 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                          <XAxis
                            dataKey="time"
                            tick={false}
                            axisLine={false}
                            domain={["dataMin", "dataMax"]}
                            type="category"
                          />
                          <YAxis
                            tick={{ fontSize: 10 }}
                            width={60}
                            domain={getYDomain(["force1", "force3", "force5"], shearZoom)}
                            allowDataOverflow
                          />
                          <ChartTooltip content={<ChartTooltipContent />} />
                          <Line
                            type="monotone"
                            dataKey="force1"
                            stroke="var(--color-force1)"
                            strokeWidth={2}
                            dot={false}
                            name="Channel 1"
                            isAnimationActive={false}
                            hide={!lineVisibility.force1}
                          />
                          <Line
                            type="monotone"
                            dataKey="force3"
                            stroke="var(--color-force3)"
                            strokeWidth={2}
                            dot={false}
                            name="Channel 3"
                            isAnimationActive={false}
                            hide={!lineVisibility.force3}
                          />
                          <Line
                            type="monotone"
                            dataKey="force5"
                            stroke="var(--color-force5)"
                            strokeWidth={2}
                            dot={false}
                            name="Channel 5"
                            isAnimationActive={false}
                            hide={!lineVisibility.force5}
                          />
                          <Brush
                            dataKey="time"
                            height={30}
                            stroke="var(--color-force1)"
                            startIndex={shearZoom.startIndex}
                            endIndex={shearZoom.endIndex}
                            onChange={(brushData) => {
                              if (brushData) {
                                setShearZoom({
                                  startIndex: brushData.startIndex,
                                  endIndex: brushData.endIndex,
                                })
                              }
                            }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </ChartContainer>
                  </CardContent>
                </Card>

                {/* Acceleration Chart */}
                <Card className="bg-white border-gray-200">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle>Acceleration Data (g)</CardTitle>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={resetAccelZoom}
                      disabled={!accelZoom.startIndex && !accelZoom.endIndex}
                    >
                      Reset Zoom
                    </Button>
                  </CardHeader>
                  <CardContent className="p-2">
                    {renderLineToggles(["accelX", "accelY", "accelZ"])}
                    <ChartContainer config={chartConfig} className="h-[400px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 50 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                          <XAxis
                            dataKey="time"
                            tick={false}
                            axisLine={false}
                            domain={["dataMin", "dataMax"]}
                            type="category"
                          />
                          <YAxis
                            tick={{ fontSize: 10 }}
                            width={60}
                            domain={getYDomain(["accelX", "accelY", "accelZ"], accelZoom)}
                            allowDataOverflow
                          />
                          <ChartTooltip content={<ChartTooltipContent />} />
                          <Line
                            type="monotone"
                            dataKey="accelX"
                            stroke="var(--color-accelX)"
                            strokeWidth={2}
                            dot={false}
                            name="Accel X"
                            isAnimationActive={false}
                            hide={!lineVisibility.accelX}
                          />
                          <Line
                            type="monotone"
                            dataKey="accelY"
                            stroke="var(--color-accelY)"
                            strokeWidth={2}
                            dot={false}
                            name="Accel Y"
                            isAnimationActive={false}
                            hide={!lineVisibility.accelY}
                          />
                          <Line
                            type="monotone"
                            dataKey="accelZ"
                            stroke="var(--color-accelZ)"
                            strokeWidth={2}
                            dot={false}
                            name="Accel Z"
                            isAnimationActive={false}
                            hide={!lineVisibility.accelZ}
                          />
                          <Brush
                            dataKey="time"
                            height={30}
                            stroke="var(--color-accelX)"
                            startIndex={accelZoom.startIndex}
                            endIndex={accelZoom.endIndex}
                            onChange={(brushData) => {
                              if (brushData) {
                                setAccelZoom({
                                  startIndex: brushData.startIndex,
                                  endIndex: brushData.endIndex,
                                })
                              }
                            }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </ChartContainer>
                  </CardContent>
                </Card>

                {/* Gyroscope Chart */}
                <Card className="bg-white border-gray-200">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle>Gyroscope Data (rad/s)</CardTitle>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={resetGyroZoom}
                      disabled={!gyroZoom.startIndex && !gyroZoom.endIndex}
                    >
                      Reset Zoom
                    </Button>
                  </CardHeader>
                  <CardContent className="p-2">
                    {renderLineToggles(["gyroX", "gyroY", "gyroZ"])}
                    <ChartContainer config={chartConfig} className="h-[400px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 50 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                          <XAxis
                            dataKey="time"
                            tick={false}
                            axisLine={false}
                            domain={["dataMin", "dataMax"]}
                            type="category"
                          />
                          <YAxis
                            tick={{ fontSize: 10 }}
                            width={60}
                            domain={getYDomain(["gyroX", "gyroY", "gyroZ"], gyroZoom)}
                            allowDataOverflow
                          />
                          <ChartTooltip content={<ChartTooltipContent />} />
                          <Line
                            type="monotone"
                            dataKey="gyroX"
                            stroke="var(--color-gyroX)"
                            strokeWidth={2}
                            dot={false}
                            name="Gyro X"
                            isAnimationActive={false}
                            hide={!lineVisibility.gyroX}
                          />
                          <Line
                            type="monotone"
                            dataKey="gyroY"
                            stroke="var(--color-gyroY)"
                            strokeWidth={2}
                            dot={false}
                            name="Gyro Y"
                            isAnimationActive={false}
                            hide={!lineVisibility.gyroY}
                          />
                          <Line
                            type="monotone"
                            dataKey="gyroZ"
                            stroke="var(--color-gyroZ)"
                            strokeWidth={2}
                            dot={false}
                            name="Gyro Z"
                            isAnimationActive={false}
                            hide={!lineVisibility.gyroZ}
                          />
                          <Brush
                            dataKey="time"
                            height={30}
                            stroke="var(--color-gyroX)"
                            startIndex={gyroZoom.startIndex}
                            endIndex={gyroZoom.endIndex}
                            onChange={(brushData) => {
                              if (brushData) {
                                setGyroZoom({
                                  startIndex: brushData.startIndex,
                                  endIndex: brushData.endIndex,
                                })
                              }
                            }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </ChartContainer>
                  </CardContent>
                </Card>

                {/* Power Chart */}
                <Card className="bg-white border-gray-200">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle>Power Data (W) — Reference meter (board power unused)</CardTitle>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={resetPowerZoom}
                      disabled={!powerZoom.startIndex && !powerZoom.endIndex}
                    >
                      Reset Zoom
                    </Button>
                  </CardHeader>
                  <CardContent className="p-2">
                    {renderLineToggles(["power", "referencePower"])}
                    <ChartContainer config={chartConfig} className="h-[400px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 50 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                          <XAxis
                            dataKey="time"
                            tick={false}
                            axisLine={false}
                            domain={["dataMin", "dataMax"]}
                            type="category"
                          />
                          <YAxis
                            tick={{ fontSize: 10 }}
                            width={60}
                            domain={getYDomain(["power", "referencePower"], powerZoom)}
                            allowDataOverflow
                          />
                          <ChartTooltip content={<ChartTooltipContent />} />
                          <Line
                            type="monotone"
                            dataKey="power"
                            stroke="var(--color-power)"
                            strokeWidth={2}
                            dot={false}
                            name="CycloWatt Power"
                            isAnimationActive={false}
                            hide={!lineVisibility.power}
                          />
                          <Line
                            type="monotone"
                            dataKey="referencePower"
                            stroke="var(--color-referencePower)"
                            strokeWidth={2}
                            dot={false}
                            name="Reference Power"
                            isAnimationActive={false}
                            hide={!lineVisibility.referencePower}
                          />
                          <Brush
                            dataKey="time"
                            height={30}
                            stroke="var(--color-power)"
                            startIndex={powerZoom.startIndex}
                            endIndex={powerZoom.endIndex}
                            onChange={(brushData) => {
                              if (brushData) {
                                setPowerZoom({
                                  startIndex: brushData.startIndex,
                                  endIndex: brushData.endIndex,
                                })
                              }
                            }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </ChartContainer>
                  </CardContent>
                </Card>
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
                    disabled={
                      !compressionZoom.startIndex &&
                      !shearZoom.startIndex &&
                      !accelZoom.startIndex &&
                      !gyroZoom.startIndex &&
                      !powerZoom.startIndex
                    }
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
                      Connected to: {device?.name || "Unknown Device"}{" "}
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
            <DfuCard device={device} isStreaming={isStreaming} stopStreaming={stopDataStreaming} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
