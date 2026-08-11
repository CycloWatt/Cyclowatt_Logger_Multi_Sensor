/**
 * Browser-side firmware image library (IndexedDB): every manually uploaded bin
 * is kept so any previously flashed image can be re-flashed (rollback). Keyed
 * by content hash, so re-uploading the same file never duplicates.
 */

export interface StoredImage { id: string; fileName: string; version: string; sizeBytes: number; addedAt: number; note: string }

interface StoredRecord extends StoredImage { bytes: ArrayBuffer }

const DB_NAME = "cyclowatt-firmware-library"
const STORE = "images"

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"))
  })
}

/**
 * Runs `run` against the store inside ONE transaction and resolves only once
 * that transaction has COMMITTED. `run` issues its requests and returns a thunk
 * that is read at commit time to produce the resolved value.
 *
 * Waiting for the commit is the whole point. A request's `onsuccess` fires while
 * the transaction is still open, so resolving there would report success for a
 * write the browser can still roll back — quota exhaustion at commit time being
 * the realistic case on a bench machine after many ~500 KB bins. That failure
 * mode is nasty precisely because it looks like success: the caller gets its
 * metadata back, then the image is missing from the next `listImages()`.
 * Resolving on `oncomplete` and rejecting on `onabort` makes a rolled-back write
 * surface as a rejected promise. Readonly transactions have nothing to roll back
 * but cost nothing extra here, so both modes take the same path.
 *
 * Per-request `onerror` handlers are deliberately absent: an unhandled request
 * error aborts its transaction, which lands on `onabort` below. One error path.
 */
async function withTx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => () => T): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      let readResult: () => T
      try {
        readResult = run(tx.objectStore(STORE))
      } catch (err) {
        reject(err)
        return
      }
      tx.oncomplete = () => resolve(readResult())
      // `tx.error` is null for an explicit abort() and for a quota rollback in
      // some engines, hence the fallback. First rejection wins; a request error
      // firing `onerror` then `onabort` is harmless.
      tx.onabort = () => reject(tx.error ?? new Error(`IndexedDB transaction aborted (${mode})`))
      tx.onerror = () => reject(tx.error ?? new Error(`IndexedDB transaction failed (${mode})`))
    })
  } finally {
    db.close()
  }
}

/**
 * Wall clock, forced strictly increasing. Two saves inside the same millisecond
 * would otherwise share an `addedAt`, and `listImages` (a stable sort on that
 * field) would fall back to IndexedDB key order — the content hash, i.e.
 * arbitrary — silently breaking "newest first". Nudging by 1 ms per collision
 * keeps insertion order recoverable at negligible cost to timestamp accuracy.
 */
let lastAddedAt = 0
function nextAddedAt(): number {
  lastAddedAt = Math.max(Date.now(), lastAddedAt + 1)
  return lastAddedAt
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Stores `bytes` under their SHA-256, so re-adding the same file upserts one
 * record rather than creating a twin.
 *
 * Re-save semantics, chosen deliberately because `put` replaces the whole record:
 * - `note` — OMIT the argument and any stored note survives. A note is typed by
 *   hand ("verified, 20 W offset") and cannot be recovered from the file, so a
 *   re-add that says nothing about notes must not erase one. Passing a note
 *   explicitly overwrites, INCLUDING the empty string, which is how a caller
 *   clears an annotation.
 * - `fileName` / `version` — always overwritten by this call's values. Both are
 *   derived from the file the user just picked, so the newest pick is the better
 *   truth: it reflects a rename on disk or a corrected version reading.
 * - `addedAt` — refreshed, so a re-added image rises to the top of the
 *   newest-first list where the user expects to find what they just added.
 */
export async function saveImage(fileName: string, version: string, bytes: Uint8Array, note?: string): Promise<StoredImage> {
  const id = await sha256Hex(bytes)
  // Read and write in one transaction so the note carried over cannot be a
  // stale read from a separately-committed get.
  return withTx<StoredImage>("readwrite", (store) => {
    const existing = store.get(id) as IDBRequest<StoredRecord | undefined>
    let meta: StoredImage | undefined
    existing.onsuccess = () => {
      const record: StoredRecord = {
        id, fileName, version,
        sizeBytes: bytes.length,
        addedAt: nextAddedAt(),
        note: note ?? existing.result?.note ?? "",
        bytes: bytes.slice().buffer,
      }
      const { bytes: _omit, ...rest } = record
      meta = rest
      store.put(record)
    }
    return () => {
      if (!meta) throw new Error("IndexedDB save committed without writing a record")
      return meta
    }
  })
}

export async function listImages(): Promise<StoredImage[]> {
  const records = await withTx<StoredRecord[]>("readonly", (store) => {
    const req = store.getAll() as IDBRequest<StoredRecord[]>
    return () => req.result
  })
  return records
    .map(({ bytes: _omit, ...meta }) => meta)
    .sort((a, b) => b.addedAt - a.addedAt)
}

export async function getImageBytes(id: string): Promise<Uint8Array | null> {
  const record = await withTx<StoredRecord | undefined>("readonly", (store) => {
    const req = store.get(id) as IDBRequest<StoredRecord | undefined>
    return () => req.result
  })
  return record ? new Uint8Array(record.bytes) : null
}

export async function deleteImage(id: string): Promise<void> {
  await withTx<void>("readwrite", (store) => {
    store.delete(id)
    return () => undefined
  })
}
