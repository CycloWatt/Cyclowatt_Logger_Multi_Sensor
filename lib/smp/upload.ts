import { cborEncode, type CborValue } from "./cbor"
import { SMP_HEADER_SIZE } from "./packet"
import { SmpError } from "./client"

/** The slice of SmpClient the uploader needs (kept narrow so tests can fake it). */
export interface UploadClient {
  readonly maxFrameSize: number
  imageUploadWrite(fields: { [key: string]: CborValue }, timeoutMs?: number): Promise<number>
}

export type UploadPhase =
  | "idle"
  | "hashing"
  | "uploading"
  | "disconnected" // link dropped — resumable (decision D3)
  | "done"
  | "error" // device rejected something — NOT resumable
  | "aborted"

export interface UploadProgress {
  sentBytes: number
  totalBytes: number
  bytesPerSecond: number
}

/**
 * Chunked SMP image upload with resume-after-disconnect (decision D3).
 *
 * The DEVICE drives the offsets: every response carries the next offset it
 * expects, and the first request (off=0 with len + sha) doubles as the resume
 * handshake — a server still holding a partial upload with the same SHA-256
 * replies with the offset to continue from instead of restarting. Resume is
 * therefore just re-running the same loop on a fresh connection; it survives a
 * BLE disconnect within the page session, NOT a page reload (file not persisted).
 */
export class ImageUploader {
  phase: UploadPhase = "idle"
  onProgress?: (progress: UploadProgress) => void
  onPhaseChange?: (phase: UploadPhase) => void

  private fileBytes: Uint8Array | null = null
  private sha: Uint8Array | null = null
  private abortRequested = false

  get canResume(): boolean {
    return this.phase === "disconnected" && this.fileBytes !== null
  }

  async start(fileBytes: Uint8Array, client: UploadClient): Promise<void> {
    this.fileBytes = fileBytes
    this.setPhase("hashing")
    // SHA-256 of the whole file = the upload-session identifier the device matches on.
    // The BufferSource cast is a pure type fix: TS 5.9 types Uint8Array generically over
    // ArrayBufferLike, while WebCrypto's BufferSource insists on an ArrayBuffer-backed
    // view. Runtime behaviour is unchanged (no SharedArrayBuffer ever reaches here).
    this.sha = new Uint8Array(await crypto.subtle.digest("SHA-256", fileBytes as BufferSource))
    await this.run(client)
  }

  /** Re-entry after a BLE disconnect: same bytes + sha, a fresh client. */
  async resume(client: UploadClient): Promise<void> {
    if (!this.fileBytes || !this.sha) throw new Error("no interrupted upload to resume")
    await this.run(client)
  }

  /** Stop before the next chunk goes out (takes effect between requests). */
  abort(): void {
    this.abortRequested = true
  }

  private async run(client: UploadClient): Promise<void> {
    const bytes = this.fileBytes as Uint8Array
    const sha = this.sha as Uint8Array
    this.abortRequested = false
    this.setPhase("uploading")
    // Throughput is measured from the first response of THIS run so a resume's
    // server-side skip-ahead doesn't count as transferred bytes.
    let baseOff: number | null = null
    let baseTime = 0
    let stalls = 0
    try {
      let off = 0
      while (off < bytes.length) {
        if (this.abortRequested) {
          this.setPhase("aborted")
          return
        }
        const fields: { [key: string]: CborValue } =
          off === 0
            ? { image: 0, len: bytes.length, off: 0, sha, data: new Uint8Array(0) }
            : { off, data: new Uint8Array(0) }
        // Size the data chunk so the whole frame stays inside the budget: measure
        // the CBOR overhead with empty data, keeping 3 spare bytes for the data
        // byte-string's length field growing with the real chunk.
        const overhead = SMP_HEADER_SIZE + cborEncode(fields).length + 3
        const dataLen = Math.min(bytes.length - off, Math.max(1, client.maxFrameSize - overhead))
        fields.data = bytes.subarray(off, off + dataLen)
        const nextOff = await client.imageUploadWrite(fields)
        // A device that stops advancing would loop forever — bail out loudly instead.
        if (nextOff === off) {
          if (++stalls >= 3) throw new Error(`upload stalled at offset ${off}`)
        } else {
          stalls = 0
        }
        off = nextOff
        const now = Date.now()
        if (baseOff === null) {
          baseOff = off
          baseTime = now
        }
        const elapsedSeconds = (now - baseTime) / 1000
        this.onProgress?.({
          sentBytes: off,
          totalBytes: bytes.length,
          bytesPerSecond: elapsedSeconds > 0 ? (off - baseOff) / elapsedSeconds : 0,
        })
      }
      this.setPhase("done")
    } catch (error) {
      // A device-reported SMP error is fatal; anything else (rejected write,
      // timeout) is treated as a link drop and stays resumable.
      this.setPhase(error instanceof SmpError ? "error" : "disconnected")
      throw error
    }
  }

  private setPhase(phase: UploadPhase): void {
    this.phase = phase
    this.onPhaseChange?.(phase)
  }
}
