/**
 * Version-shelf reader — lists the firmware repo's tracked firmware_versions/
 * folder (signed MCUboot bins + manifest.json). Server-side only (node:fs);
 * consumed by the /api/firmware route handlers.
 */
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

export interface ShelfEntry {
  version: string; file: string; description: string; date: string
  commit: string; profile: "prod" | "daq"
  status: "ok" | "missing-file" | "unlisted"
  sizeBytes: number | null
}

/** Exactly one path segment ending in .bin — the gate the bin-serving route uses. */
export function isSafeBinName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.bin$/.test(name) && !name.includes("..") && !name.includes("/") && !name.includes("\\")
}

export async function readShelf(shelfDir: string): Promise<ShelfEntry[]> {
  let names: string[]
  try {
    names = await readdir(shelfDir)
  } catch {
    throw new Error(`firmware_versions folder not found at ${shelfDir} — check FIRMWARE_DIR`)
  }
  let raw: string
  try {
    raw = await readFile(join(shelfDir, "manifest.json"), "utf8")
  } catch {
    throw new Error(`manifest.json not found in ${shelfDir}`)
  }
  // Every throw below names manifest.json: a route that surfaces err.message must show a
  // configuration hint, never a raw SyntaxError/TypeError from bad JSON or a null entry.
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`manifest.json in ${shelfDir} is not valid JSON: ${(err as Error).message}`)
  }
  // typeof null === "object", so the null-guard has to be explicit.
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("manifest.json: expected a JSON object with an 'entries' array")
  }
  const entries = (parsed as { entries?: unknown }).entries
  if (!Array.isArray(entries)) throw new Error("manifest.json: top-level 'entries' array missing")

  const shelf: ShelfEntry[] = []
  const listed = new Set<string>()
  for (const e of entries) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      throw new Error("manifest.json: every item in 'entries' must be an object")
    }
    const m = e as Record<string, unknown>
    for (const field of ["version", "file", "description", "date", "commit", "profile"]) {
      if (typeof m[field] !== "string") throw new Error(`manifest.json: entry missing string field '${field}'`)
    }
    const file = m.file as string
    const profile = m.profile as string
    // The profile drives later UI branching, so a typo must fail here rather than flow
    // through the "prod" | "daq" cast as an impossible value.
    if (profile !== "prod" && profile !== "daq") {
      throw new Error(`manifest.json: entry '${file}' has profile '${profile}' — expected "prod" or "daq"`)
    }
    listed.add(file)
    // A manifest may not point outside the shelf. An unsafe name is reported as
    // missing-file (not a new status — the union is a cross-task interface) so the entry
    // never claims to be servable when the bin-serving route would refuse it.
    const size = isSafeBinName(file) ? await sizeOf(join(shelfDir, file)) : null
    shelf.push({
      version: m.version as string, file, description: m.description as string,
      date: m.date as string, commit: m.commit as string, profile,
      status: size === null ? "missing-file" : "ok", sizeBytes: size,
    })
  }
  for (const name of names) {
    if (!name.endsWith(".bin") || listed.has(name)) continue
    shelf.push({
      version: "?", file: name, description: "(not in manifest)", date: "", commit: "", profile: "prod",
      status: "unlisted", sizeBytes: await sizeOf(join(shelfDir, name)),
    })
  }
  return shelf
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}
