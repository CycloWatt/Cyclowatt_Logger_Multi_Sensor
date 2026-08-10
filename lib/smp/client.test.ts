import { describe, expect, it } from "vitest"
import { cborDecode, cborEncode, type CborValue } from "./cbor"
import { SmpFrameAssembler, encodeFrame, type SmpHeader } from "./packet"
import { SmpClient, SmpError, type SmpCharacteristicLike } from "./client"

/**
 * Fake SMP GATT server: collects writes, reassembles request frames, answers via a
 * scriptable responder, and fragments its notifications like a real device would.
 */
class MockSmpCharacteristic implements SmpCharacteristicLike {
  notifyChunkSize = 62 // pretend the link negotiated ATT_MTU 65
  writes: Uint8Array[] = []
  respond:
    | ((header: SmpHeader, payload: { [key: string]: CborValue }) => CborValue | null)
    | null = null
  failWrites = false

  private listener: ((event: Event) => void) | null = null
  private readonly assembler = new SmpFrameAssembler()

  async startNotifications(): Promise<unknown> {
    return this
  }

  addEventListener(_type: "characteristicvaluechanged", listener: (event: Event) => void): void {
    this.listener = listener
  }

  removeEventListener(): void {
    this.listener = null
  }

  async writeValueWithoutResponse(data: BufferSource): Promise<void> {
    if (this.failWrites) throw new Error("simulated link drop")
    const bytes =
      data instanceof Uint8Array ? data.slice() : new Uint8Array(data as ArrayBuffer)
    this.writes.push(bytes)
    for (const frame of this.assembler.push(bytes)) {
      const request = cborDecode(frame.payload) as { [key: string]: CborValue }
      const reply = this.respond?.(frame.header, request)
      if (reply === null || reply === undefined) continue // scripted silence → timeout path
      const rspFrame = encodeFrame(
        {
          op: (frame.header.op + 1) as SmpHeader["op"],
          flags: 0,
          group: frame.header.group,
          seq: frame.header.seq,
          id: frame.header.id,
        },
        cborEncode(reply),
      )
      this.notify(rspFrame)
    }
  }

  /** Deliver bytes as characteristicvaluechanged events, fragmented to notifyChunkSize. */
  notify(bytes: Uint8Array): void {
    for (let off = 0; off < bytes.length; off += this.notifyChunkSize) {
      const chunk = bytes.subarray(off, Math.min(off + this.notifyChunkSize, bytes.length))
      const view = new DataView(chunk.slice().buffer)
      this.listener?.({ target: { value: view } } as unknown as Event)
    }
  }
}

/** Answers OS echo like the firmware does; everything else gets "not supported". */
const echoResponder = (
  header: SmpHeader,
  payload: { [key: string]: CborValue },
): CborValue => (header.group === 0 && header.id === 0 ? { r: payload.d ?? "" } : { rc: 8 })

async function makeClient(mock: MockSmpCharacteristic): Promise<SmpClient> {
  const client = new SmpClient(mock)
  await client.initialize()
  return client
}

describe("SmpClient.initialize", () => {
  it("measures the usable write size from response notification fragments", async () => {
    const mock = new MockSmpCharacteristic()
    mock.respond = echoResponder
    const client = await makeClient(mock)
    // Device fragments at 62 bytes → the link's ATT_MTU-3 is 62.
    expect(client.attChunkSize).toBe(62)
  })

  it("falls back to the 20-byte floor when echo fails", async () => {
    const mock = new MockSmpCharacteristic()
    mock.respond = () => ({ rc: 8 }) // echo "not supported"
    const client = await makeClient(mock)
    expect(client.attChunkSize).toBe(20)
  })
})

describe("SmpClient.request", () => {
  it("chunks outgoing frames to attChunkSize", async () => {
    const mock = new MockSmpCharacteristic()
    mock.respond = echoResponder
    const client = await makeClient(mock)
    mock.writes = []
    await client.echo("y".repeat(500))
    expect(mock.writes.length).toBeGreaterThan(1)
    for (const write of mock.writes) expect(write.length).toBeLessThanOrEqual(62)
  })

  it("rejects with SmpError on a nonzero rc", async () => {
    const mock = new MockSmpCharacteristic()
    mock.respond = echoResponder
    const client = await makeClient(mock)
    mock.respond = () => ({ rc: 8 })
    await expect(client.imageStateRead()).rejects.toBeInstanceOf(SmpError)
  })

  it("rejects on timeout when the device stays silent", async () => {
    const mock = new MockSmpCharacteristic()
    mock.respond = echoResponder
    const client = await makeClient(mock)
    mock.respond = () => null
    await expect(
      client.request(2, 0, 0, { d: "hi" }, 50),
    ).rejects.toThrow(/timed out/)
  })
})

describe("image commands", () => {
  it("parses image slot states", async () => {
    const mock = new MockSmpCharacteristic()
    mock.respond = echoResponder
    const client = await makeClient(mock)
    const hash = new Uint8Array(32).fill(9)
    mock.respond = () => ({
      images: [
        {
          slot: 0,
          version: "0.1.1",
          hash,
          bootable: true,
          pending: false,
          confirmed: true,
          active: true,
          permanent: false,
        },
      ],
      splitStatus: 0,
    })
    const states = await client.imageStateRead()
    expect(states).toHaveLength(1)
    expect(states[0].version).toBe("0.1.1")
    expect(states[0].hash).toEqual(hash)
    expect(states[0].active).toBe(true)
  })

  it("returns the next offset from an upload write", async () => {
    const mock = new MockSmpCharacteristic()
    mock.respond = echoResponder
    const client = await makeClient(mock)
    // Explicit CborValue return type keeps TS from widening the two object arms
    // with `?: undefined` members the CborValue index signature rejects.
    mock.respond = (header, payload): CborValue =>
      header.group === 1 && header.id === 1
        ? { off: (payload.off as number) + (payload.data as Uint8Array).length }
        : { rc: 8 }
    const off = await client.imageUploadWrite({ off: 100, data: new Uint8Array(50) })
    expect(off).toBe(150)
  })
})
