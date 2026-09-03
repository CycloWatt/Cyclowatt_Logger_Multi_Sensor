/**
 * The raw-stream notification packet: its size, the sample it decodes to, and
 * the chart label stamped onto every sample.
 *
 * Moved out of app/page.tsx unchanged. It sits in lib/ because it is the one
 * part of the streaming path that is pure arithmetic over a DataView, and
 * therefore the one part that can be pinned by test vectors - which matters more
 * than usual here, since the only other way to check a division constant or the
 * tick recomposition is to put a board on the bench.
 *
 * The caller keeps the side effects: the page still owns the packet counter, the
 * debug console block, and the buffers. What it hands in via `ctx` is everything
 * the sample carries that is NOT on the wire - the observation time, the
 * reference trainer's power, and the serial synchronization value.
 *
 * The two `console` calls below are the page's originals, kept verbatim (emoji
 * included) so this move is byte-identical to what a bench operator already
 * reads in the devtools console.
 */

/** Expected packet: 16 x int32 = 64 bytes */
export const EXPECTED_PACKET_SIZE = 64

export interface DataPoint {
  timestamp: number
  // Pre-formatted chart label for `timestamp`. Formatted ONCE here at parse
  // time: formatting on every chart tick meant 500 Intl calls per 100 ms.
  timeLabel: string
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

/** Everything a sample carries that the wire does not. */
export interface PacketContext {
  /** When this page observed the packet; both `timestamp` and `timeLabel` come from it. */
  timestamp: Date
  referencePower: number
  synchronization: number
}

/**
 * The "MM:SS.tenth" label the chart axis shows, hand-rolled: the
 * toLocaleTimeString call it replaces goes through Intl, far too heavy for a
 * per-packet path (and worse, it used to run per chart REDRAW).
 */
export function packetTimeLabel(date: Date): string {
  return `${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}.${Math.floor(
    date.getMilliseconds() / 100,
  )}`
}

export function parseDataPacket(dataView: DataView, ctx: PacketContext): DataPoint | null {
  if (dataView.byteLength !== EXPECTED_PACKET_SIZE) {
    console.warn(`❌ Invalid packet size: ${dataView.byteLength} bytes, expected ${EXPECTED_PACKET_SIZE}`)
    return null
  }

  try {
    // 6 force channels (load cell values) — raw integers, not scaled.
    //
    // The wire slot IS the board's amp channel: the firmware reads Vout_meas_1..6
    // into force_mv[0..5] straight (power-meter-fw src/drivers/force_sensor.c)
    // and raw_stream_wire.c packs slot i to slot i, so no permutation happens
    // anywhere between the ADC and here. Positions per slot live in
    // lib/raw-stream/force-channels.ts — the one place that mapping is written.
    const force0 = dataView.getInt32(0, true) // index 0
    const force1 = dataView.getInt32(4, true) // index 1
    const force2 = dataView.getInt32(8, true) // index 2
    const force3 = dataView.getInt32(12, true) // index 3
    const force4 = dataView.getInt32(16, true) // index 4
    const force5 = dataView.getInt32(20, true) // index 5

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
      timestamp: ctx.timestamp.getTime(),
      timeLabel: packetTimeLabel(ctx.timestamp),
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
      referencePower: ctx.referencePower,
      synchronization: ctx.synchronization,
    }

    return dataPoint
  } catch (error) {
    console.error("❌ Error parsing data packet:", error)
    return null
  }
}
