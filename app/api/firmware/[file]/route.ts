/**
 * Bin-serving route — GET /api/firmware/<file>.
 * Streams one signed MCUboot .bin off the shelf as application/octet-stream.
 * isSafeBinName is the traversal gate: only a single `*.bin` path segment gets through.
 */
import { NextResponse } from "next/server"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { isSafeBinName } from "@/lib/firmware-shelf"

export const dynamic = "force-dynamic"

export async function GET(_req: Request, { params }: { params: { file: string } }) {
  const root = process.env.FIRMWARE_DIR
  if (!root) return NextResponse.json({ error: "FIRMWARE_DIR is not set" }, { status: 503 })
  if (!isSafeBinName(params.file)) return NextResponse.json({ error: "bad file name" }, { status: 400 })
  try {
    const data = await readFile(join(root, "firmware_versions", params.file))
    return new NextResponse(new Uint8Array(data), { headers: { "content-type": "application/octet-stream" } })
  } catch {
    return NextResponse.json({ error: `${params.file} not found on the shelf` }, { status: 404 })
  }
}
