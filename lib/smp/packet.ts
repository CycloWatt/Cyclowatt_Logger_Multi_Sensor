/**
 * MCUmgr SMP v1 framing: an 8-byte header followed by a CBOR payload.
 *
 * Over BLE, one SMP frame may be fragmented across many GATT packets in BOTH
 * directions (the firmware enables CONFIG_MCUMGR_TRANSPORT_BT_REASSEMBLY for
 * incoming writes; its response notifications are capped at ATT_MTU-3), so the
 * receive side reassembles notifications until the header's length is satisfied.
 */

export const SMP_HEADER_SIZE = 8

export const SMP_OP = { READ: 0, READ_RSP: 1, WRITE: 2, WRITE_RSP: 3 } as const
export type SmpOp = (typeof SMP_OP)[keyof typeof SMP_OP]

export const SMP_GROUP = { OS: 0, IMAGE: 1 } as const
export const OS_CMD = { ECHO: 0, RESET: 5 } as const
export const IMAGE_CMD = { STATE: 0, UPLOAD: 1 } as const

export interface SmpHeader {
  op: SmpOp
  flags: number
  /** Payload byte count, excluding this header. */
  length: number
  group: number
  seq: number
  id: number
}

export function encodeFrame(header: Omit<SmpHeader, "length">, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(SMP_HEADER_SIZE + payload.length)
  frame[0] = header.op
  frame[1] = header.flags
  frame[2] = payload.length >> 8 // length and group are big-endian on the wire
  frame[3] = payload.length & 0xff
  frame[4] = header.group >> 8
  frame[5] = header.group & 0xff
  frame[6] = header.seq
  frame[7] = header.id
  frame.set(payload, SMP_HEADER_SIZE)
  return frame
}

export function decodeHeader(bytes: Uint8Array): SmpHeader {
  if (bytes.length < SMP_HEADER_SIZE) {
    throw new Error(`SMP: header needs ${SMP_HEADER_SIZE} bytes, got ${bytes.length}`)
  }
  return {
    op: (bytes[0] & 0x07) as SmpOp, // low 3 bits; upper bits carry the SMP version (0 here)
    flags: bytes[1],
    length: (bytes[2] << 8) | bytes[3],
    group: (bytes[4] << 8) | bytes[5],
    seq: bytes[6],
    id: bytes[7],
  }
}

/** Buffers incoming notification chunks and yields complete SMP frames. */
export class SmpFrameAssembler {
  private buffer: number[] = []

  push(chunk: Uint8Array): Array<{ header: SmpHeader; payload: Uint8Array }> {
    for (const b of chunk) this.buffer.push(b)
    const frames: Array<{ header: SmpHeader; payload: Uint8Array }> = []
    while (this.buffer.length >= SMP_HEADER_SIZE) {
      const header = decodeHeader(Uint8Array.from(this.buffer.slice(0, SMP_HEADER_SIZE)))
      const total = SMP_HEADER_SIZE + header.length
      if (this.buffer.length < total) break // frame still incomplete — wait for more chunks
      const frameBytes = this.buffer.splice(0, total)
      frames.push({ header, payload: Uint8Array.from(frameBytes.slice(SMP_HEADER_SIZE)) })
    }
    return frames
  }

  /** Forget any partial frame (used when a connection is torn down). */
  reset(): void {
    this.buffer = []
  }
}
