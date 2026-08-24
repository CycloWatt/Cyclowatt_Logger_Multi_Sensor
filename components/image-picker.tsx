"use client"

/**
 * Chooses the image to flash, from two sources - the browser library (previous
 * uploads) or a local file. Every source funnels through parseMcubootImage
 * before onImage fires; local files are also saved to the library so they can be
 * re-flashed later.
 *
 * There is deliberately NO server-backed "version shelf" here. This app is
 * built as a static export and hosted on GitHub Pages, which cannot run route
 * handlers, so the old /api/firmware pair (a disk read of a local firmware
 * checkout) could not survive. Released images live in the power-meter-fw repo
 * under firmware_versions/; you download one and upload it here. The note in
 * the upload section is the only remaining trace, and it is load-bearing: it is
 * how someone finds the images at all.
 */

import { useEffect, useRef, useState, type ChangeEvent } from "react"
import { Button } from "@/components/ui/button"
import { FileUp } from "lucide-react"
import { parseMcubootImage, type McubootImageInfo } from "@/lib/smp/mcuboot"
import { deleteImage, getImageBytes, listImages, saveImage, type StoredImage } from "@/lib/firmware-library"

interface ImagePickerProps {
  disabled: boolean
  onImage: (bytes: Uint8Array, info: McubootImageInfo, label: string) => void
}

export function ImagePicker({ disabled, onImage }: ImagePickerProps) {
  const [library, setLibrary] = useState<StoredImage[]>([])
  const [sourceError, setSourceError] = useState("")
  // Mirror of what the card currently holds, kept only to make a stale selection
  // explicit in the error line (see failPick). The card stays the sole owner of
  // the real selection; this never drives what gets flashed.
  const [selectedLabel, setSelectedLabel] = useState("")
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    void refreshLibrary()
  }, [])

  async function refreshLibrary() {
    try {
      setLibrary(await listImages())
    } catch (err) {
      // IndexedDB can be unavailable outright (private mode, blocked storage);
      // an empty list plus a visible reason beats an unhandled rejection.
      setLibrary([])
      setSourceError(err instanceof Error ? err.message : "could not read the firmware library")
    }
  }

  /**
   * A pick did NOT take effect. Whatever was accepted before is still armed in
   * the card — and will still flash — so the message has to say so: a bare
   * reason sitting under a card that shows the old image reads like "nothing is
   * selected", which is exactly how the wrong image gets flashed.
   */
  function failPick(reason: string) {
    setSourceError(selectedLabel ? `rejected: ${reason} — still selected: ${selectedLabel}` : `rejected: ${reason}`)
  }

  /** The single validation gate — no source reaches onImage without passing it. */
  function accept(bytes: Uint8Array, label: string) {
    try {
      const info = parseMcubootImage(bytes)
      setSourceError("")
      setSelectedLabel(label)
      onImage(bytes, info, label)
      return info
    } catch (err) {
      failPick(err instanceof Error ? err.message : "invalid image")
      return null
    }
  }

  async function pickLibrary(image: StoredImage) {
    try {
      const bytes = await getImageBytes(image.id)
      if (!bytes) {
        failPick("image no longer in the library")
        await refreshLibrary()
        return
      }
      accept(bytes, image.fileName)
    } catch (err) {
      failPick(err instanceof Error ? err.message : "could not read the image from the library")
    }
  }

  async function pickFile(event: ChangeEvent<HTMLInputElement>) {
    // Captured at handler ENTRY: React nulls currentTarget once the synchronous
    // part of the dispatch returns, so it is unusable after the first await.
    const input = event.currentTarget
    const file = event.target.files?.[0]
    if (!file) return
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await file.arrayBuffer())
    } catch (err) {
      // Nothing was picked up, so this is a failed pick like any other.
      failPick(err instanceof Error ? err.message : "could not read the file")
      return
    } finally {
      // MUST clear the input, on BOTH the success and the failure path. Chrome
      // fires `change` only when the input's value CHANGES, so re-picking the
      // SAME path — the bench's core loop: rebuild the firmware to the same
      // .bin, pick it again — would be a silent no-op, and "Upload & Activate"
      // would flash the PREVIOUS build's bytes while the card still showed the
      // right file name. Clearing here (the bytes are already read into memory,
      // so the File object is no longer needed) makes every re-pick a real
      // change event. Do not "simplify" this away.
      input.value = ""
    }
    const info = accept(bytes, file.name)
    if (!info) return
    try {
      // The image is already selected at this point, so a failed save (a quota
      // rollback rejects) is NOT a rejected pick — report it without the
      // "rejected" framing, which would contradict the card.
      await saveImage(file.name, info.version, bytes)
      await refreshLibrary()
    } catch (err) {
      setSourceError(
        `image selected, but the library save failed: ${err instanceof Error ? err.message : "unknown error"}`,
      )
    }
  }

  async function removeLibrary(image: StoredImage) {
    try {
      await deleteImage(image.id)
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : "could not delete the image")
    }
    await refreshLibrary()
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium">Previously uploaded</div>
        {library.length === 0 && <div className="text-sm text-muted-foreground">nothing stored yet</div>}
        {library.map((image) => (
          <div key={image.id} className="flex items-center justify-between gap-2 py-1 text-sm">
            <span>
              v{image.version} — {image.fileName}
            </span>
            <span className="flex gap-1">
              <Button size="sm" variant="outline" disabled={disabled} onClick={() => void pickLibrary(image)}>
                Select
              </Button>
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void removeLibrary(image)}>
                Delete
              </Button>
            </span>
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <div className="text-sm font-medium">Upload a .bin</div>
        <div className="text-sm text-muted-foreground">
          Released images live in the <span className="font-mono">power-meter-fw</span> repository under{" "}
          <span className="font-mono">firmware_versions/</span>. Download the .bin for the version you want, then upload
          it here.
        </div>
        {/* Hidden native input; the visible control is a real Button so it matches
            the rest of the UI instead of the browser's locale-styled file widget. */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".bin"
          className="hidden"
          onChange={(e) => void pickFile(e)}
        />
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => fileInputRef.current?.click()}>
          <FileUp className="mr-1 h-4 w-4" />
          Choose a .bin file…
        </Button>
      </div>
      {sourceError && <div className="text-sm text-destructive">{sourceError}</div>}
    </div>
  )
}
