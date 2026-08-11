import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { isSafeBinName, readShelf } from "./firmware-shelf"

let dir: string
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

async function makeShelf(manifest: unknown, bins: string[]): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "shelf-"))
  if (manifest !== undefined) await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest))
  for (const b of bins) await writeFile(join(dir, b), Uint8Array.from([1, 2, 3]))
  return dir
}

const ENTRY = { version: "0.2.2", file: "cyclowatt_dfu_v0.2.2.bin", description: "baseline", date: "2026-08-10", commit: "19c2e14", profile: "prod" }

describe("readShelf", () => {
  it("returns ok entries with file sizes", async () => {
    const d = await makeShelf({ entries: [ENTRY] }, ["cyclowatt_dfu_v0.2.2.bin"])
    const shelf = await readShelf(d)
    expect(shelf).toEqual([{ ...ENTRY, status: "ok", sizeBytes: 3 }])
  })
  it("flags a manifest entry whose bin is missing", async () => {
    const d = await makeShelf({ entries: [ENTRY] }, [])
    expect((await readShelf(d))[0]).toMatchObject({ status: "missing-file", sizeBytes: null })
  })
  it("surfaces unlisted bins instead of hiding them", async () => {
    const d = await makeShelf({ entries: [] }, ["stray_v9.9.9.bin"])
    expect((await readShelf(d))[0]).toMatchObject({ file: "stray_v9.9.9.bin", status: "unlisted", version: "?", sizeBytes: 3 })
  })
  it("throws a configuration-hint error when the folder or manifest is absent", async () => {
    await expect(readShelf(join(tmpdir(), "does-not-exist-shelf"))).rejects.toThrow(/firmware_versions/)
    const d = await makeShelf(undefined, ["a.bin"])
    await expect(readShelf(d)).rejects.toThrow(/manifest\.json/)
  })
  it("rejects malformed manifest entries loudly", async () => {
    const d = await makeShelf({ entries: [{ version: "1" }] }, [])
    await expect(readShelf(d)).rejects.toThrow(/manifest/)
  })
  // A real file is planted one level ABOVE the shelf, so an unvalidated join() would
  // happily stat it and label the entry servable.
  it("never reports a shelf-escaping manifest file as servable", async () => {
    dir = await mkdtemp(join(tmpdir(), "shelf-"))
    await writeFile(join(dir, "outside.bin"), Uint8Array.from([1, 2, 3, 4, 5]))
    const shelf = join(dir, "inner")
    await mkdir(shelf)
    await writeFile(join(shelf, "manifest.json"), JSON.stringify({ entries: [{ ...ENTRY, file: "../outside.bin" }] }))
    expect((await readShelf(shelf))[0]).toMatchObject({ file: "../outside.bin", status: "missing-file", sizeBytes: null })
  })
  it("names manifest.json for corrupt, empty and null-root JSON", async () => {
    const d = await makeShelf({ entries: [] }, [])
    for (const bad of ['{ "entries": [', "", "null"]) {
      await writeFile(join(d, "manifest.json"), bad)
      await expect(readShelf(d)).rejects.toThrow(/manifest\.json/)
    }
  })
  it("names manifest.json when an entry is null", async () => {
    const d = await makeShelf({ entries: [null] }, [])
    await expect(readShelf(d)).rejects.toThrow(/manifest\.json/)
  })
  it("rejects a profile that is neither prod nor daq", async () => {
    const d = await makeShelf({ entries: [{ ...ENTRY, profile: "hacker" }] }, ["cyclowatt_dfu_v0.2.2.bin"])
    await expect(readShelf(d)).rejects.toThrow(/manifest\.json.*profile/)
  })
})

describe("isSafeBinName", () => {
  it.each(["cyclowatt_dfu_v0.2.2.bin", "a-b_c.9.bin"])("accepts %s", (n) => expect(isSafeBinName(n)).toBe(true))
  it.each(["../secret.bin", "a/b.bin", "a\\b.bin", "x.zip", ".bin", "a..bin.bin/"])("rejects %s", (n) => expect(isSafeBinName(n)).toBe(false))
})
