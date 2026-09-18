import { PDFDocument } from 'pdf-lib'
import type { Canvas, FabricObject } from 'fabric'
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist'
import { removeTextRuns } from './contentEdit'
import { makeInverse, pdfTextTarget } from './export'
import { createPdfWorker, openPdfDocumentOnWorker } from './pdfjs'

/**
 * Final-result preview for real text edits.
 *
 * Deleting a run from the content stream at export time is invisible on screen
 * while the fabric cover rectangle stands in for it, and the cover can never be
 * exact (artwork, stripes, gradients). Instead the same content-stream rewrite
 * the exporter runs is applied to a scratch copy of the page, the result is
 * re-rendered with pdf.js and swapped in under the annotations. What the user
 * sees is the saved file: the original glyphs are gone, not covered.
 */

type SerializedObject = Record<string, any>
type AnyObject = FabricObject & Record<string, any>

interface PreviewEdit {
  /** Stable key: `editId`, or the pdftext index for edits saved before it existed. */
  key: string
  object: SerializedObject
}

/**
 * The `pdftext` replacements claiming a run. Empty-text edits are included on
 * purpose: a replacement can be momentarily empty while the user retypes it,
 * and flipping the preview back to the original on every keystroke would both
 * flash and restart the build.
 */
function previewEdits(objects: unknown[]): PreviewEdit[] {
  const edits: PreviewEdit[] = []
  let pdfTextIndex = 0
  for (const raw of objects) {
    const object = raw as SerializedObject | null
    if (!object || typeof object !== 'object') continue
    const data = object.data as SerializedObject | undefined
    if (data?.kind !== 'pdftext') continue
    const index = pdfTextIndex
    pdfTextIndex += 1
    edits.push({ key: typeof data.editId === 'string' ? data.editId : `index:${index}`, object })
  }
  return edits
}

/**
 * Everything the removal matching depends on. Typing does not change it (the
 * exporter matches the original run), so keystrokes never rebuild the preview.
 */
export function textEditSignature(objects: unknown[]): string {
  const edits = previewEdits(objects)
  if (!edits.length) return ''
  return JSON.stringify(
    edits.map(({ key, object }) => {
      const data = (object.data ?? {}) as SerializedObject
      const spawn = (data.spawn ?? {}) as SerializedObject
      const number = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
      return [
        key,
        String(data.originalText ?? ''),
        typeof data.originalWidth === 'number' ? data.originalWidth : null,
        number(object.fontSize, 16),
        number(spawn.left),
        number(spawn.top),
        number(spawn.width),
        number(spawn.angle),
      ]
    }),
  )
}

export interface TextEditPreviewState {
  signature: string
  /** Patched page document, or null when falling back to a cover. */
  pdf: PDFDocumentProxy | null
  /** Keys of the edits whose original glyphs were removed. */
  removedIds: Set<string>
}

const sourceCache = new WeakMap<Uint8Array, Promise<PDFDocument>>()
/** One worker for every preview document, so rebuilds do not pay startup. */
let previewWorker: PDFWorker | null = null
let previewWorkerReady = false

function loadSource(bytes: Uint8Array): Promise<PDFDocument> {
  let hit = sourceCache.get(bytes)
  if (!hit) {
    hit = PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
    sourceCache.set(bytes, hit)
  }
  return hit
}

function workerForPreviews(): PDFWorker | null {
  if (!previewWorkerReady) {
    previewWorker = createPdfWorker()
    previewWorkerReady = true
  }
  return previewWorker
}

/** Rewrites the page's content streams and renders the result as a one-page PDF. */
export async function buildTextEditPreview(
  bytes: Uint8Array,
  page: { sourceIndex: number; transform: number[] },
  objects: unknown[],
): Promise<TextEditPreviewState | null> {
  const signature = textEditSignature(objects)
  if (!signature) return null
  const edits = previewEdits(objects)
  try {
    const source = await loadSource(bytes)
    const inv = makeInverse(page.transform)
    const targets = edits.map(({ object }) => pdfTextTarget(object as unknown as AnyObject, inv))
    const out = await PDFDocument.create()
    const [copied] = await out.copyPages(source, [page.sourceIndex])
    out.addPage(copied)
    const removed = removeTextRuns(copied, targets)
    const removedIds = new Set<string>()
    for (const index of removed) removedIds.add(edits[index].key)
    if (!removedIds.size) return { signature, pdf: null, removedIds }
    const saved = await out.save({ useObjectStreams: true })
    const pdf = await openPdfDocumentOnWorker(saved, workerForPreviews())
    return { signature, pdf, removedIds }
  } catch (error) {
    console.warn('Could not build the text-edit preview; keeping the cover fallback', error)
    return { signature, pdf: null, removedIds: new Set() }
  }
}

/**
 * Shows the real edit on the fabric overlay: cleared backgrounds for runs whose
 * glyphs the preview deleted, the sampled cover for the ones that fall back.
 */
export function applyTextEditPreviewBackgrounds(
  canvas: Canvas | null,
  removedIds: Set<string> | null,
): void {
  if (!canvas) return
  let changed = false
  let pdfTextIndex = 0
  for (const object of canvas.getObjects()) {
    const target = object as AnyObject
    if (target.data?.kind !== 'pdftext') continue
    const key = typeof target.data?.editId === 'string' ? target.data.editId : `index:${pdfTextIndex}`
    pdfTextIndex += 1
    const removed = removedIds?.has(key) ?? false
    const cover = typeof target.data?.cover === 'string' ? target.data.cover : ''
    const background = removed ? '' : cover || (typeof target.backgroundColor === 'string' ? target.backgroundColor : '')
    if ((target.backgroundColor ?? '') !== background) {
      target.set({ backgroundColor: background })
      target.dirty = true
      changed = true
    }
  }
  if (changed) canvas.requestRenderAll()
}
