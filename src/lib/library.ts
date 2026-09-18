import type { FormValue } from './forms'
import type { PageState } from '../types'
import { collectAssets, restoreAssets } from './assets'
import { applyFormValues } from './forms'
import { buildPdf, type ExportPageInput } from './export'
import { hydrateAnnotations } from './serialize'
import { openPdfDocumentFromBytes } from './pdfjs'
import { uid } from './uid'

const DB_NAME = 'realpdf'
const DB_VERSION = 1
const STORE = 'projects'

export interface LibraryEntry {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  savedAt: number
  saveCount: number
  pageCount: number
  size: number
  sourceName: string
  sourceBytes: ArrayBuffer
  pages: PageState[]
  assets: Record<string, string>
  formValues: Record<string, FormValue>
  formFlatten: boolean
  hasForms: boolean
  thumbnail?: string
}

export type LibraryMeta = Omit<LibraryEntry, 'sourceBytes' | 'pages' | 'assets' | 'formValues'>

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('This browser does not support local storage (IndexedDB)'))
        return
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Could not open local storage'))
    })
  }
  return dbPromise
}

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode)
        const request = run(transaction.objectStore(STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Local storage error'))
      }),
  )
}

export async function putProject(entry: LibraryEntry): Promise<void> {
  await withStore('readwrite', (store) => store.put(entry))
}

export async function getProject(id: string): Promise<LibraryEntry | undefined> {
  const entry = await withStore<LibraryEntry | undefined>('readonly', (store) => store.get(id))
  return entry
}

export async function deleteProject(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id))
}

export async function clearProjects(): Promise<void> {
  await withStore('readwrite', (store) => store.clear())
}

export async function listProjects(): Promise<LibraryMeta[]> {
  const all = await withStore<LibraryEntry[]>('readonly', (store) => store.getAll())
  return all
    .map(({ sourceBytes: _bytes, pages: _pages, assets: _assets, formValues: _values, ...meta }) => meta)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (!navigator.storage?.estimate) return null
    const estimate = await navigator.storage.estimate()
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
  } catch {
    return null
  }
}

function collectAssetIds(pages: PageState[]): Set<string> {
  const ids = new Set<string>()
  const walk = (objects: unknown[]) => {
    for (const item of objects) {
      if (!item || typeof item !== 'object') continue
      const obj = item as Record<string, any>
      const assetId = obj.data?.assetId
      if (typeof assetId === 'string') ids.add(assetId)
      if (Array.isArray(obj.objects)) walk(obj.objects)
    }
  }
  for (const page of pages) walk(page.annotations.objects)
  return ids
}

/** Small preview image of the first page, taken from the exported PDF. */
export async function makeThumbnail(bytes: Uint8Array): Promise<string | undefined> {
  try {
    const doc = await openPdfDocumentFromBytes(bytes)
    try {
      const page = await doc.getPage(1)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: Math.min(1, 170 / base.width) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      await page.render({ canvas, viewport, background: 'white' }).promise
      return canvas.toDataURL('image/jpeg', 0.72)
    } finally {
      void doc.loadingTask.destroy()
    }
  } catch (error) {
    console.error(error)
    return undefined
  }
}

export interface SaveProjectInput {
  id?: string
  title: string
  sourceName: string
  bytes: Uint8Array
  pages: PageState[]
  formValues: Record<string, FormValue>
  formFlatten: boolean
  hasForms: boolean
  exportedBytes: Uint8Array
  previous?: LibraryEntry
  thumbnail?: string
}

export function buildLibraryEntry(input: SaveProjectInput): LibraryEntry {
  const now = Date.now()
  return {
    id: input.previous?.id ?? input.id ?? uid(),
    title: input.previous?.title ?? input.title,
    createdAt: input.previous?.createdAt ?? now,
    updatedAt: now,
    savedAt: now,
    saveCount: (input.previous?.saveCount ?? 0) + 1,
    pageCount: input.pages.length,
    size: input.exportedBytes.length,
    sourceName: input.previous?.sourceName ?? input.sourceName,
    sourceBytes: new Uint8Array(input.bytes).buffer,
    pages: input.pages,
    assets: collectAssets(collectAssetIds(input.pages)),
    formValues: input.formValues,
    formFlatten: input.formFlatten,
    hasForms: input.hasForms,
    thumbnail: input.thumbnail ?? input.previous?.thumbnail,
  }
}

/** Rebuilds a PDF from a stored project (used by the library's download). */
export async function projectToPdf(entry: LibraryEntry): Promise<Uint8Array> {
  restoreAssets(entry.assets)
  let source = new Uint8Array(entry.sourceBytes)
  if (entry.hasForms && Object.keys(entry.formValues ?? {}).length > 0) {
    const filled = await applyFormValues(source, entry.formValues, { flatten: entry.formFlatten ?? true })
    source = new Uint8Array(filled.bytes)
  }
  const pages: ExportPageInput[] = entry.pages.map((page) => ({
    sourceIndex: page.sourceIndex,
    width: page.width,
    height: page.height,
    transform: page.transform,
    objects: hydrateAnnotations(page.annotations).objects,
  }))
  return await buildPdf(source, pages)
}
