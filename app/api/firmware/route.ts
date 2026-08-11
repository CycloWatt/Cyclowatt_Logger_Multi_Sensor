/**
 * Version-shelf listing route — GET /api/firmware.
 * Reads the firmware repo's firmware_versions/ folder (path from FIRMWARE_DIR)
 * and returns { entries: ShelfEntry[] }. 503 when unconfigured, 500 on a bad shelf.
 */
import { NextResponse } from "next/server"
import { join } from "node:path"
import { readShelf } from "@/lib/firmware-shelf"

export const dynamic = "force-dynamic" // always re-read the checkout; freshness = git pull

export async function GET() {
  const root = process.env.FIRMWARE_DIR
  if (!root) {
    return NextResponse.json(
      { error: "FIRMWARE_DIR is not set. Add FIRMWARE_DIR=<path to power-meter-fw checkout> to .env.local and restart the dev server." },
      { status: 503 },
    )
  }
  try {
    return NextResponse.json({ entries: await readShelf(join(root, "firmware_versions")) })
  } catch (err) {
    // readShelf's messages are written to be user-facing config hints, so surfacing
    // err.message verbatim is intentional here.
    return NextResponse.json({ error: err instanceof Error ? err.message : "shelf read failed" }, { status: 500 })
  }
}
