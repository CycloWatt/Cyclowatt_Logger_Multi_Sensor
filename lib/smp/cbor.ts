/**
 * Mini-CBOR codec (RFC 8949 subset) for MCUmgr SMP payloads — decision D2.
 *
 * Deliberately covers ONLY what SMP needs: definite-length maps and arrays,
 * unsigned/negative integers up to 2^53-1, UTF-8 text strings, byte strings,
 * booleans and null. Indefinite lengths, floats, tags and bigints are rejected
 * loudly — extending the subset means revisiting D2.
 */

export type CborValue =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | CborValue[]
  | { [key: string]: CborValue }

// CBOR major types (RFC 8949 §3.1) — the top 3 bits of the initial byte.
const MT_UINT = 0
const MT_NEGINT = 1
const MT_BYTES = 2
const MT_TEXT = 3
const MT_ARRAY = 4
const MT_MAP = 5

export function cborEncode(value: CborValue): Uint8Array {
  const out: number[] = []
  encodeValue(value, out)
  return Uint8Array.from(out)
}

export function cborDecode(bytes: Uint8Array): CborValue {
  const reader = new CborReader(bytes)
  const value = reader.readValue()
  if (reader.remaining() > 0) {
    throw new Error(`CBOR: ${reader.remaining()} trailing bytes after value`)
  }
  return value
}

/** Write the initial byte + length/value argument (RFC 8949 §3: 0..23 inline, then 1/2/4-byte). */
function encodeTypeAndArg(major: number, arg: number, out: number[]): void {
  if (!Number.isSafeInteger(arg) || arg < 0) throw new Error(`CBOR: bad argument ${arg}`)
  if (arg < 24) {
    out.push((major << 5) | arg)
  } else if (arg < 0x100) {
    out.push((major << 5) | 24, arg)
  } else if (arg < 0x10000) {
    out.push((major << 5) | 25, arg >> 8, arg & 0xff)
  } else if (arg < 0x100000000) {
    out.push((major << 5) | 26, (arg >>> 24) & 0xff, (arg >>> 16) & 0xff, (arg >>> 8) & 0xff, arg & 0xff)
  } else {
    throw new Error("CBOR: values above 2^32-1 not supported by this subset")
  }
}

function encodeValue(value: CborValue, out: number[]): void {
  if (value === null) {
    out.push(0xf6)
  } else if (typeof value === "boolean") {
    out.push(value ? 0xf5 : 0xf4)
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`CBOR: only integers supported, got ${value}`)
    if (value >= 0) encodeTypeAndArg(MT_UINT, value, out)
    else encodeTypeAndArg(MT_NEGINT, -1 - value, out)
  } else if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value)
    encodeTypeAndArg(MT_TEXT, bytes.length, out)
    for (const b of bytes) out.push(b)
  } else if (value instanceof Uint8Array) {
    encodeTypeAndArg(MT_BYTES, value.length, out)
    for (const b of value) out.push(b)
  } else if (Array.isArray(value)) {
    encodeTypeAndArg(MT_ARRAY, value.length, out)
    for (const item of value) encodeValue(item, out)
  } else {
    // Plain object → definite-length map with text keys, in insertion order
    // (deterministic output is what makes the codec unit-testable byte-for-byte).
    const entries = Object.entries(value)
    encodeTypeAndArg(MT_MAP, entries.length, out)
    for (const [key, item] of entries) {
      encodeValue(key, out)
      encodeValue(item, out)
    }
  }
}

class CborReader {
  private pos = 0

  constructor(private readonly bytes: Uint8Array) {}

  remaining(): number {
    return this.bytes.length - this.pos
  }

  private takeByte(): number {
    if (this.pos >= this.bytes.length) throw new Error("CBOR: unexpected end of input")
    return this.bytes[this.pos++]
  }

  private takeBytes(count: number): Uint8Array {
    if (this.pos + count > this.bytes.length) throw new Error("CBOR: unexpected end of input")
    const slice = this.bytes.subarray(this.pos, this.pos + count)
    this.pos += count
    return slice
  }

  /** Decode the length/value argument following the initial byte. */
  private readArg(info: number): number {
    if (info < 24) return info
    if (info === 24) return this.takeByte()
    if (info === 25) {
      const b = this.takeBytes(2)
      return (b[0] << 8) | b[1]
    }
    if (info === 26) {
      const b = this.takeBytes(4)
      // Avoid the sign bit of 32-bit shifts: multiply the high byte out instead.
      return b[0] * 0x1000000 + ((b[1] << 16) | (b[2] << 8) | b[3])
    }
    if (info === 27) {
      const b = this.takeBytes(8)
      const high = b[0] * 0x1000000 + ((b[1] << 16) | (b[2] << 8) | b[3])
      const low = b[4] * 0x1000000 + ((b[5] << 16) | (b[6] << 8) | b[7])
      const value = high * 0x100000000 + low
      if (!Number.isSafeInteger(value)) throw new Error("CBOR: uint64 exceeds safe integer range")
      return value
    }
    // 28–30 reserved, 31 = indefinite length — none are in the SMP subset.
    throw new Error(`CBOR: unsupported additional info ${info}`)
  }

  readValue(): CborValue {
    const initial = this.takeByte()
    const major = initial >> 5
    const info = initial & 0x1f
    switch (major) {
      case MT_UINT:
        return this.readArg(info)
      case MT_NEGINT:
        return -1 - this.readArg(info)
      case MT_BYTES:
        // Copy out of the shared buffer so callers can hold the value freely.
        return this.takeBytes(this.readArg(info)).slice()
      case MT_TEXT:
        return new TextDecoder().decode(this.takeBytes(this.readArg(info)))
      case MT_ARRAY: {
        const length = this.readArg(info)
        const items: CborValue[] = []
        for (let i = 0; i < length; i++) items.push(this.readValue())
        return items
      }
      case MT_MAP: {
        const length = this.readArg(info)
        const map: { [key: string]: CborValue } = {}
        for (let i = 0; i < length; i++) {
          const key = this.readValue()
          if (typeof key !== "string") throw new Error("CBOR: unsupported non-text map key")
          map[key] = this.readValue()
        }
        return map
      }
      default:
        // major 6 = tags, 7 = floats/simple beyond bool/null (handled below)
        if (major === 7 && info === 20) return false
        if (major === 7 && info === 21) return true
        if (major === 7 && info === 22) return null
        throw new Error(`CBOR: unsupported item (major type ${major}, info ${info})`)
    }
  }
}
