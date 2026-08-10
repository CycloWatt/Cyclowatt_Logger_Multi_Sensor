import { describe, expect, it } from "vitest"
import { cborEncode, type CborValue } from "./cbor"
import { SmpError } from "./client"
import { ImageUploader, type UploadClient } from "./upload"

/** Fake image-management server: tracks the received byte count like Zephyr does. */
class FakeUploadClient implements UploadClient {
  readonly maxFrameSize = 2048
  requests: Array<{ [key: string]: CborValue }> = []
  received = 0
  failAfterRequests: number | null = null
  failWith: Error = new Error("simulated disconnect")

  async imageUploadWrite(fields: { [key: string]: CborValue }): Promise<number> {
    if (this.failAfterRequests !== null && this.requests.length >= this.failAfterRequests) {
      throw this.failWith
    }
    this.requests.push({ ...fields })
    const off = fields.off as number
    const data = fields.data as Uint8Array
    if (off === 0 && this.received > 0) {
      // Matching-sha resume handshake: report the existing offset, consume nothing.
      return this.received
    }
    if (off !== this.received) throw new Error(`unexpected offset ${off}, wanted ${this.received}`)
    this.received += data.length
    return this.received
  }
}

const FILE = Uint8Array.from({ length: 5000 }, (_, i) => i % 251)

describe("ImageUploader.start", () => {
  it("uploads everything, in frame-budget-sized requests", async () => {
    const client = new FakeUploadClient()
    const uploader = new ImageUploader()
    const progress: number[] = []
    uploader.onProgress = (p) => progress.push(p.sentBytes)
    await uploader.start(FILE, client)

    expect(uploader.phase).toBe("done")
    expect(client.received).toBe(FILE.length)
    // First request carries the session identity (D3): len + sha + image slot.
    expect(client.requests[0].off).toBe(0)
    expect(client.requests[0].len).toBe(FILE.length)
    expect(client.requests[0].image).toBe(0)
    expect((client.requests[0].sha as Uint8Array).length).toBe(32)
    // Later requests are lean: no len/sha resent.
    expect(client.requests[1].len).toBeUndefined()
    expect(client.requests[1].sha).toBeUndefined()
    // Every frame respects the budget (8-byte SMP header + CBOR payload).
    for (const request of client.requests) {
      expect(8 + cborEncode(request).length).toBeLessThanOrEqual(client.maxFrameSize)
    }
    expect(progress[progress.length - 1]).toBe(FILE.length)
  })
})

describe("ImageUploader resume (decision D3)", () => {
  it("marks a link failure resumable and continues on a fresh client", async () => {
    const first = new FakeUploadClient()
    first.failAfterRequests = 2
    const uploader = new ImageUploader()
    await expect(uploader.start(FILE, first)).rejects.toThrow(/disconnect/)
    expect(uploader.phase).toBe("disconnected")
    expect(uploader.canResume).toBe(true)

    // New connection, same server-side partial upload.
    const second = new FakeUploadClient()
    second.received = first.received
    await uploader.resume(second)

    expect(uploader.phase).toBe("done")
    expect(second.received).toBe(FILE.length)
    // Resume re-enters with the off=0 + sha handshake and trusts the returned offset.
    expect(second.requests[0].off).toBe(0)
    expect((second.requests[0].sha as Uint8Array).length).toBe(32)
  })

  it("marks a device-reported error fatal (not resumable)", async () => {
    const client = new FakeUploadClient()
    client.failAfterRequests = 1
    client.failWith = new SmpError(9)
    const uploader = new ImageUploader()
    await expect(uploader.start(FILE, client)).rejects.toBeInstanceOf(SmpError)
    expect(uploader.phase).toBe("error")
    expect(uploader.canResume).toBe(false)
  })
})

describe("ImageUploader.abort", () => {
  it("stops between chunks", async () => {
    const client = new FakeUploadClient()
    const uploader = new ImageUploader()
    uploader.onProgress = () => uploader.abort()
    await uploader.start(FILE, client)
    expect(uploader.phase).toBe("aborted")
    expect(client.received).toBeLessThan(FILE.length)
  })
})
