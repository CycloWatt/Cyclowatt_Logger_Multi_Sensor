import { cborDecode, cborEncode, type CborValue } from "./cbor"
import {
  IMAGE_CMD,
  OS_CMD,
  SMP_GROUP,
  SMP_OP,
  SmpFrameAssembler,
  encodeFrame,
  type SmpOp,
} from "./packet"

/** MCUmgr SMP GATT UUIDs — fixed by Zephyr's smp_bt transport, same in every image variant. */
export const SMP_SERVICE_UUID = "8d53dc1d-1db7-4cd3-868b-8a527460aa84"
export const SMP_CHARACTERISTIC_UUID = "da2e7828-fbce-4e01-ae9e-261174997c48"

/**
 * Structural subset of BluetoothRemoteGATTCharacteristic that the client needs —
 * a real characteristic satisfies it, and tests can substitute a plain mock.
 */
export interface SmpCharacteristicLike {
  // Uint8Array is listed alongside BufferSource because TS 5.7+ types subarray()
  // views as Uint8Array<ArrayBufferLike>, which no longer satisfies BufferSource
  // (its SharedArrayBuffer arm fails the check). A real characteristic still
  // matches: method parameters are compared bivariantly.
  writeValueWithoutResponse(data: BufferSource | Uint8Array): Promise<void>
  startNotifications(): Promise<unknown>
  addEventListener(type: "characteristicvaluechanged", listener: (event: Event) => void): void
  removeEventListener(type: "characteristicvaluechanged", listener: (event: Event) => void): void
}

const MGMT_ERR_NAMES: Record<number, string> = {
  1: "unknown error",
  2: "out of memory",
  3: "invalid value",
  4: "timeout",
  5: "not found",
  6: "bad state",
  7: "response too large",
  8: "not supported",
  9: "corrupt payload",
  10: "device busy",
}

/** Failure reported by the device itself (nonzero `rc` in an SMP response). */
export class SmpError extends Error {
  constructor(readonly rc: number) {
    super(`device reported SMP error ${rc} (${MGMT_ERR_NAMES[rc] ?? "unknown code"})`)
    this.name = "SmpError"
  }
}

export interface ImageSlotState {
  slot: number
  version: string
  hash: Uint8Array
  bootable: boolean
  pending: boolean
  confirmed: boolean
  active: boolean
  permanent: boolean
}

interface PendingRequest {
  expectOp: SmpOp
  resolve: (payload: { [key: string]: CborValue }) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class SmpClient {
  /**
   * Largest single GATT write the link accepts (ATT_MTU - 3). Web Bluetooth has no
   * API for the negotiated MTU and oversized write-without-response calls are
   * rejected by the browser/OS, so we start at the 20-byte floor every BLE link
   * supports (minimum ATT_MTU 23) and raise it in initialize() by measuring how the
   * device fragments its own notifications.
   */
  attChunkSize = 20
  /** Outgoing SMP frames stay well under the firmware's 2475-byte SMP receive buffer. */
  readonly maxFrameSize = 2048

  private seq = 0
  private maxSeenNotification = 0
  private disposed = false
  private readonly assembler = new SmpFrameAssembler()
  private readonly pending = new Map<number, PendingRequest>()

  // Arrow function so add/removeEventListener see the same reference.
  private readonly onNotification = (event: Event): void => {
    const view = (event.target as unknown as { value?: DataView }).value
    if (!view) return
    this.maxSeenNotification = Math.max(this.maxSeenNotification, view.byteLength)
    const chunk = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    for (const frame of this.assembler.push(chunk)) {
      const waiter = this.pending.get(frame.header.seq)
      if (!waiter || frame.header.op !== waiter.expectOp) continue
      this.pending.delete(frame.header.seq)
      clearTimeout(waiter.timer)
      let payload: CborValue
      try {
        payload = cborDecode(frame.payload)
      } catch (error) {
        waiter.reject(error instanceof Error ? error : new Error(String(error)))
        continue
      }
      const map = (payload ?? {}) as { [key: string]: CborValue }
      if (typeof map.rc === "number" && map.rc !== 0) waiter.reject(new SmpError(map.rc))
      else waiter.resolve(map)
    }
  }

  constructor(private readonly characteristic: SmpCharacteristicLike) {}

  /** Subscribe to SMP notifications, then measure the link's usable write size. */
  async initialize(): Promise<void> {
    this.characteristic.addEventListener("characteristicvaluechanged", this.onNotification)
    await this.characteristic.startNotifications()
    await this.measureChunkSize()
  }

  /** Detach from the characteristic and fail any in-flight requests. */
  dispose(): void {
    this.disposed = true
    this.characteristic.removeEventListener("characteristicvaluechanged", this.onNotification)
    for (const [seq, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error("SMP client disposed"))
      this.pending.delete(seq)
    }
  }

  /** Send one SMP request and await the response with the same sequence number. */
  async request(
    op: SmpOp,
    group: number,
    id: number,
    payload: CborValue,
    timeoutMs = 10000,
  ): Promise<{ [key: string]: CborValue }> {
    if (this.disposed) throw new Error("SMP client disposed")
    this.seq = (this.seq + 1) & 0xff
    const seq = this.seq
    const frame = encodeFrame({ op, flags: 0, group, seq, id }, cborEncode(payload))
    const response = new Promise<{ [key: string]: CborValue }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new Error(`SMP request timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(seq, { expectOp: (op + 1) as SmpOp, resolve, reject, timer })
    })
    // Frames larger than one ATT packet go out as sequential writes; the firmware
    // reassembles them (CONFIG_MCUMGR_TRANSPORT_BT_REASSEMBLY). Awaiting each write
    // is the flow control — Chrome resolves once the OS has accepted the packet.
    try {
      for (let off = 0; off < frame.length; off += this.attChunkSize) {
        await this.characteristic.writeValueWithoutResponse(
          frame.subarray(off, Math.min(off + this.attChunkSize, frame.length)),
        )
      }
    } catch (error) {
      const waiter = this.pending.get(seq)
      if (waiter) {
        this.pending.delete(seq)
        clearTimeout(waiter.timer)
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
    return response
  }

  /** OS echo — also the probe used to measure the link's packet size. */
  async echo(text: string): Promise<string> {
    const rsp = await this.request(SMP_OP.WRITE, SMP_GROUP.OS, OS_CMD.ECHO, { d: text })
    return typeof rsp.r === "string" ? rsp.r : ""
  }

  /** OS reset — reboots into MCUboot so a pending image gets installed. */
  async reset(): Promise<void> {
    try {
      await this.request(SMP_OP.WRITE, SMP_GROUP.OS, OS_CMD.RESET, {}, 3000)
    } catch {
      // The device may drop the link before its response gets out — that IS the reset.
    }
  }

  async imageStateRead(): Promise<ImageSlotState[]> {
    const rsp = await this.request(SMP_OP.READ, SMP_GROUP.IMAGE, IMAGE_CMD.STATE, {})
    return parseImageStates(rsp)
  }

  /** Mark the uploaded image pending for the next boot (mcumgr "test", confirm: false). */
  async imageTest(hash: Uint8Array): Promise<ImageSlotState[]> {
    const rsp = await this.request(SMP_OP.WRITE, SMP_GROUP.IMAGE, IMAGE_CMD.STATE, {
      hash,
      confirm: false,
    })
    return parseImageStates(rsp)
  }

  /** One image-upload request; resolves to the next offset the device expects. */
  async imageUploadWrite(
    fields: { [key: string]: CborValue },
    timeoutMs = 20000,
  ): Promise<number> {
    const rsp = await this.request(SMP_OP.WRITE, SMP_GROUP.IMAGE, IMAGE_CMD.UPLOAD, fields, timeoutMs)
    if (typeof rsp.off !== "number") throw new Error("image upload response carried no offset")
    return rsp.off
  }

  private async measureChunkSize(): Promise<void> {
    // The device fragments notifications to ATT_MTU-3, so echoing a payload larger
    // than any single packet reveals the negotiated MTU through the largest
    // response fragment. Zephyr's os_mgmt echo has no length cap (bounded only by
    // the 2475-byte netbuf), and the 240-byte request goes out in safe 20-byte
    // writes. On any failure we simply stay at the universally-safe floor.
    try {
      await this.echo("x".repeat(240))
      if (this.maxSeenNotification >= 20) {
        this.attChunkSize = Math.min(244, this.maxSeenNotification)
      }
    } catch {
      this.attChunkSize = 20
    }
  }
}

function parseImageStates(rsp: { [key: string]: CborValue }): ImageSlotState[] {
  const images = Array.isArray(rsp.images) ? rsp.images : []
  return images.map((entry) => {
    const map = (entry ?? {}) as { [key: string]: CborValue }
    return {
      slot: typeof map.slot === "number" ? map.slot : 0,
      version: typeof map.version === "string" ? map.version : "",
      hash: map.hash instanceof Uint8Array ? map.hash : new Uint8Array(0),
      bootable: map.bootable === true,
      pending: map.pending === true,
      confirmed: map.confirmed === true,
      active: map.active === true,
      permanent: map.permanent === true,
    }
  })
}
