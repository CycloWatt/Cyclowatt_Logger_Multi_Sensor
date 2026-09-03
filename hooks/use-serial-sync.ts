"use client"

/**
 * The Web Serial "synchronization input": one bench cable whose latest numeric
 * line is stamped onto every raw-stream packet.
 *
 * Lifted out of app/page.tsx unchanged. It is a hook rather than a lib module
 * because all three of its jobs are React-shaped: it owns the port, the reader
 * loop's teardown, and the throttled on-screen value.
 *
 * WHY `valueRef` IS PART OF THE PUBLIC SHAPE: the packet path reads the current
 * serial value SYNCHRONOUSLY, inside the notification handler that builds a CSV
 * row (`synchronization: valueRef.current`). A state value would be whatever the
 * handler's creating render saw - the handler is built once at stream start - so
 * the ref is the contract, and `latestValue` exists only for the display.
 *
 * The display is throttled (lib/throttle) because the cable delivers a line
 * hundreds of times a second while the readout is for a human: leading flush so
 * the first value appears at once, trailing flush so the last value of a burst
 * still lands, and `cancel()` on disconnect so a deferred flush cannot resurrect
 * the value the disconnect just zeroed.
 *
 * WHY THERE IS NO `supported` OPTION: the page detects Web Serial itself (in the
 * same mount effect that detects Web Bluetooth, for its compatibility banner),
 * and this hook does not need the result - `connectSerial` re-checks
 * `"serial" in navigator` at call time, which is the only moment it matters.
 */

import { useEffect, useRef, useState } from "react"
import { createThrottle, type Throttle } from "@/lib/throttle"

/** The on-screen value updates at most ~5x/s; the ref stays current. */
const DISPLAY_FLUSH_MS = 200

export interface UseSerialSyncOptions {
  /** The page's single error Alert. */
  onError: (message: string) => void
  /** Mirrors the page's DEBUG_PACKET_LOG: per-line console output when true. */
  debugLog?: boolean
}

export interface SerialSync {
  connected: boolean
  latestValue: number
  valueRef: React.MutableRefObject<number>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
}

export function useSerialSync({ onError, debugLog = false }: UseSerialSyncOptions): SerialSync {
  const [serialPort, setSerialPort] = useState<SerialPort | null>(null)
  const [isSerialConnected, setIsSerialConnected] = useState(false)
  const [latestSerialValue, setLatestSerialValue] = useState<number>(0)

  const serialValueRef = useRef<number>(0)
  // The reader yields decoded STRINGS (it sits behind a TextDecoderStream).
  const serialReaderRef = useRef<ReadableStreamDefaultReader<string> | null>(null)
  // Mirror of the `serialPort` state for the unmount cleanup below: a
  // mount-keyed cleanup closure captures the first render, where the state is
  // still null, so it must read a ref the connect flow keeps current.
  const serialPortRef = useRef<SerialPort | null>(null)

  // One throttle instance for the life of the component: it holds the last-flush
  // timestamp and the pending timer that a re-created one would forget.
  const throttleRef = useRef<Throttle | null>(null)
  if (throttleRef.current === null) {
    throttleRef.current = createThrottle({
      intervalMs: DISPLAY_FLUSH_MS,
      now: Date.now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onFlush: () => setLatestSerialValue(serialValueRef.current),
    })
  }
  const throttle = throttleRef.current

  /*
   * Unmount: without this the `while (true)` reader loop and any deferred
   * display flush both outlive the hook, calling setState on an unmounted
   * component. Best-effort teardown through the REFS (see serialPortRef): the
   * reader must be cancelled before the port can close, and neither failing is
   * news on a link that may already be gone.
   */
  useEffect(
    () => () => {
      const reader = serialReaderRef.current
      serialReaderRef.current = null
      const port = serialPortRef.current
      serialPortRef.current = null
      if (reader || port) {
        void (async () => {
          await reader?.cancel().catch(() => {})
          await port?.close().catch(() => {})
        })()
      }
      throttle.cancel()
    },
    [throttle],
  )

  const connectSerial = async () => {
    try {
      if (!("serial" in navigator)) {
        onError("Web Serial API is not supported in this browser.")
        return
      }

      console.log("\n🔌 CONNECTING TO SERIAL PORT...")
      // Typed since @types/w3c-web-serial - the `as any` escape hatch is gone.
      const port = await navigator.serial.requestPort()
      await port.open({ baudRate: 9600 })

      setSerialPort(port)
      serialPortRef.current = port
      setIsSerialConnected(true)
      console.log("✅ Serial port connected")

      // Start reading serial data
      startSerialReading(port)
    } catch (err) {
      console.error("Serial connection failed:", err)
      onError(`Serial connection failed: ${err instanceof Error ? err.message : "Unknown error"}`)
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
            throttle.queue()
            // Per-line log at serial line rate - debug only, like the packet log.
            if (debugLog) console.log(`Serial data received: ${numValue}`)
          }
        }
      }
    } catch (err) {
      console.error("Serial reading error:", err)
      if (err instanceof Error && err.message.includes("device has been lost")) {
        setIsSerialConnected(false)
        setSerialPort(null)
        serialPortRef.current = null
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
        serialPortRef.current = null
      }

      setIsSerialConnected(false)
      serialValueRef.current = 0
      // Cancel any deferred display flush so it cannot resurrect a stale value
      // after the zeroing below.
      throttle.cancel()
      setLatestSerialValue(0)
      console.log("🔌 Serial port disconnected")
    } catch (err) {
      console.error("Serial disconnect error:", err)
    }
  }

  return {
    connected: isSerialConnected,
    latestValue: latestSerialValue,
    valueRef: serialValueRef,
    connect: connectSerial,
    disconnect: disconnectSerial,
  }
}
