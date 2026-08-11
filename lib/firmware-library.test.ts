import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it } from "vitest"
import { deleteImage, getImageBytes, listImages, saveImage } from "./firmware-library"

const BYTES_A = Uint8Array.from([1, 2, 3, 4])
const BYTES_B = Uint8Array.from([9, 9, 9])

beforeEach(async () => {
  for (const img of await listImages()) await deleteImage(img.id)
})

describe("firmware library", () => {
  it("round-trips an image with metadata", async () => {
    const saved = await saveImage("v1.bin", "0.2.2", BYTES_A, "good build")
    expect(saved).toMatchObject({ fileName: "v1.bin", version: "0.2.2", sizeBytes: 4, note: "good build" })
    expect(saved.id).toMatch(/^[0-9a-f]{64}$/)
    expect(await getImageBytes(saved.id)).toEqual(BYTES_A)
    expect(await listImages()).toHaveLength(1)
  })
  it("deduplicates identical bytes (upsert by content hash)", async () => {
    const first = await saveImage("a.bin", "0.2.2", BYTES_A)
    const second = await saveImage("b.bin", "0.2.2", BYTES_A)
    expect(second.id).toBe(first.id)
    expect(await listImages()).toHaveLength(1)
  })
  it("lists newest first and deletes", async () => {
    const a = await saveImage("a.bin", "1", BYTES_A)
    const b = await saveImage("b.bin", "2", BYTES_B)
    const list = await listImages()
    expect(list.map((i) => i.id)).toEqual([b.id, a.id])
    await deleteImage(a.id)
    expect(await listImages()).toHaveLength(1)
    expect(await getImageBytes(a.id)).toBeNull()
  })

  it("keeps a stored note when the same bytes are re-saved without one", async () => {
    await saveImage("golden.bin", "0.2.2", BYTES_A, "verified, 20 W offset")
    const resaved = await saveImage("golden-renamed.bin", "0.2.3", BYTES_A)
    expect(resaved.note).toBe("verified, 20 W offset")
    // fileName/version deliberately follow the newest upload; the note does not.
    expect(resaved).toMatchObject({ fileName: "golden-renamed.bin", version: "0.2.3" })
    const list = await listImages()
    expect(list).toHaveLength(1)
    expect(list[0].note).toBe("verified, 20 W offset")
  })

  it("clears the note when one is passed explicitly empty", async () => {
    await saveImage("golden.bin", "0.2.2", BYTES_A, "verified, 20 W offset")
    const cleared = await saveImage("golden.bin", "0.2.2", BYTES_A, "")
    expect(cleared.note).toBe("")
    expect((await listImages())[0].note).toBe("")
  })

  it("rejects a save whose transaction rolls back instead of reporting success", async () => {
    // Stand-in for the realistic bench failure: the write REQUEST succeeds and
    // only then is the transaction rolled back (storage quota hit at commit).
    // The abort must be triggered from the request's own success event — aborting
    // before it would make the request itself fail, which is a different and much
    // more obvious bug than the one under test.
    const realPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const req = realPut.call(this, value, key)
      const tx = this.transaction
      req.addEventListener("success", () => tx.abort())
      return req
    }
    try {
      await expect(saveImage("big.bin", "0.2.2", BYTES_A)).rejects.toThrow()
    } finally {
      IDBObjectStore.prototype.put = realPut
    }
    // The point of the rejection above: a caller told "saved" must never then
    // find the image missing here.
    expect(await listImages()).toEqual([])
  })
})
