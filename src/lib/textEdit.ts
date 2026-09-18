import { Rect, Textbox, type Canvas, type FabricObject } from 'fabric'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import fontkit from '@pdf-lib/fontkit'
import { pdfjs } from './pdfjs'
import { addAsset, dataUrlBytes, getAsset } from './assets'
import { normalizeFamily } from './export'
import type { FontFamily } from '../types'

/**
 * Editing text that already lives in the PDF.
 *
 * pdf.js gives us every text run with its exact position, the font it uses and
 * the raw font program (with `fontExtraProperties`). We turn a clicked run into
 * a regular fabric text box that:
 *
 *  - uses the original font, size, colour and position,
 *  - paints a background sampled from the page behind the run (so the original
 *    glyphs are covered),
 *  - knows the original font file so the exporter can embed the same font.
 */

/** fabric renders a line's baseline at 1 - 0.222 of its line box, whose height
 *  is 1.13 * fontSize (see fabric's Text._fontSizeFraction/_fontSizeMult). */
const FONT_SIZE_MULT = 1.13
const FONT_SIZE_FRACTION = 0.222

const FONT_FACE_PREFIX = 'realpdf-pdftext-'

/** A single run of text found on a page, in scene coordinates (viewport scale 1, y down). */
export interface TextRun {
  str: string
  fontSize: number
  /** Baseline origin. */
  x: number
  y: number
  /** Advance width in points. */
  width: number
  /** Rotation in degrees (clockwise in scene space). */
  angle: number
  /** [a, b, c, d, e, f] mapping run-local (u along the baseline, v up) to scene. */
  matrix: number[]
  ascent: number
  descent: number
  /** CSS family that renders the original font for on-screen editing. */
  family: string
  /** Standard-14 family used when the original font cannot be embedded. */
  fallback: FontFamily
  /** Asset id of the original font program, when it can be embedded. */
  assetId?: string
  /**
   * Space advance in em fractions. pdf.js strips empty glyphs from the font it
   * rebuilds, so spaces are drawn as positioning offsets at export time.
   */
  spaceEm?: number
  bold: boolean
  italic: boolean
  /** Scene-space axis-aligned bounds, used for the hover highlight. */
  bounds: { left: number; top: number; width: number; height: number }
}

export interface RunColors {
  color: string
  background: string
}

interface FontInfo {
  family: string
  fallback: FontFamily
  assetId?: string
  spaceEm?: number
  bold: boolean
  italic: boolean
}

interface FontFaceLike {
  data?: Uint8Array
  name?: string
  fallbackName?: string
  loadedName?: string
  bold?: boolean
  italic?: boolean
  missingFile?: boolean
  isType3Font?: boolean
  mimetype?: string
}

const STACK = 'sans-serif'

/** Exact Standard-14 base names (lowercased, spaces removed) → export family. */
const STANDARD_14: Record<string, FontFamily> = {
  helvetica: 'Helvetica',
  'helvetica-bold': 'Helvetica',
  'helvetica-oblique': 'Helvetica',
  'helvetica-boldoblique': 'Helvetica',
  'times-roman': 'Times New Roman',
  'times-bold': 'Times New Roman',
  'times-italic': 'Times New Roman',
  'times-bolditalic': 'Times New Roman',
  courier: 'Courier New',
  'courier-bold': 'Courier New',
  'courier-oblique': 'Courier New',
  'courier-boldoblique': 'Courier New',
}

function stripSubset(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, '')
}

function standardFamily(name: string | undefined): FontFamily | null {
  if (!name) return null
  return STANDARD_14[stripSubset(name).toLowerCase().replace(/\s+/g, '')] ?? null
}

function fontFamilyName(assetId: string): string {
  return `${FONT_FACE_PREFIX}${assetId}`
}

/** Quoted CSS family for a registered font asset. */
export function familyForAsset(assetId: string): string {
  return `"${fontFamilyName(assetId)}"`
}

const fontFaceTasks = new Map<string, Promise<boolean>>()

/** Loads a stored font asset as a FontFace so canvas can render with it. */
export function registerFontAsset(assetId: string): Promise<boolean> {
  const existing = fontFaceTasks.get(assetId)
  if (existing) return existing
  const task = (async () => {
    if (typeof FontFace === 'undefined' || typeof document === 'undefined') return false
    const src = getAsset(assetId)
    if (!src) return false
    try {
      const face = new FontFace(fontFamilyName(assetId), dataUrlBytes(src).buffer as ArrayBuffer)
      await face.load()
      document.fonts.add(face)
      return true
    } catch (error) {
      console.warn('Could not load the original font for text editing', error)
      return false
    }
  })()
  fontFaceTasks.set(assetId, task)
  return task
}

/** Registers the fonts referenced by `pdftext` annotations and re-measures them. */
export async function registerCanvasFonts(canvas: Canvas): Promise<void> {
  const objects = canvas.getObjects().filter((object) => (object as AnyObject).data?.kind === 'pdftext') as AnyObject[]
  const ids = new Set<string>()
  for (const object of objects) {
    const assetId = object.data?.font?.assetId
    if (typeof assetId === 'string') ids.add(assetId)
  }
  if (!ids.size) return
  const loaded = await Promise.all(Array.from(ids).map((id) => registerFontAsset(id)))
  if (!loaded.some(Boolean)) return
  for (const object of objects) {
    if (object.canvas !== canvas) continue
    ;(object as unknown as { initDimensions?: () => void }).initDimensions?.()
    object.dirty = true
  }
  canvas.requestRenderAll()
}

type AnyObject = FabricObject & Record<string, any>

function toHex(r: number, g: number, b: number): string {
  const part = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

const docRuns = new WeakMap<PDFDocumentProxy, Map<number, Promise<TextRun[]>>>()

/** Extracts (and caches) the editable text runs of a source page. */
export function loadPageTextRuns(
  pdf: PDFDocumentProxy,
  sourceIndex: number,
  pageTransform: number[],
): Promise<TextRun[]> {
  let byPage = docRuns.get(pdf)
  if (!byPage) {
    byPage = new Map()
    docRuns.set(pdf, byPage)
  }
  const hit = byPage.get(sourceIndex)
  if (hit) return hit
  const task = extractPageRuns(pdf, sourceIndex, pageTransform).catch((error) => {
    console.error('Could not read the text of this page', error)
    return []
  })
  byPage.set(sourceIndex, task)
  return task
}

async function extractPageRuns(
  pdf: PDFDocumentProxy,
  sourceIndex: number,
  pageTransform: number[],
): Promise<TextRun[]> {
  const page = await pdf.getPage(sourceIndex + 1)
  // getOperatorList makes pdf.js export the font programs onto `commonObjs`;
  // getTextContent alone never sends them.
  const [content] = await Promise.all([page.getTextContent(), page.getOperatorList().catch(() => null)])
  const runs: TextRun[] = []
  const fonts = new Map<string, FontInfo | null>()
  for (const item of content.items) {
    if (!('str' in item) || !item.str || !item.str.trim()) continue
    let info = fonts.get(item.fontName)
    if (info === undefined) {
      info = await resolveFont(page, item.fontName)
      fonts.set(item.fontName, info)
    }
    const style = content.styles[item.fontName]
    const matrix = pdfjs.Util.transform(pageTransform, item.transform)
    const fontSize = item.height || Math.hypot(matrix[2], matrix[3]) || item.width || 12
    const width = item.width
    const spaceEm = (info?.assetId && derivedSpaceEm(info.assetId, item.str, width, fontSize)) || info?.spaceEm
    const ascent = style?.ascent ?? 0.8
    const descent = style?.descent ?? -0.2
    const [a, b, c, d, e, f] = matrix
    // The matrix linear part already scales by the font size, so corners are
    // expressed in em units (u: advances, v: ascent/descent fractions).
    const corners: [number, number][] = []
    for (const u of [0, width / fontSize]) {
      for (const v of [descent, ascent]) {
        corners.push([a * u + c * v + e, b * u + d * v + f])
      }
    }
    const xs = corners.map(([x]) => x)
    const ys = corners.map(([, y]) => y)
    const left = Math.min(...xs)
    const top = Math.min(...ys)
    runs.push({
      str: item.str,
      fontSize,
      x: e,
      y: f,
      width,
      angle: (Math.atan2(b, a) * 180) / Math.PI,
      matrix,
      ascent,
      descent,
      family: info?.family ?? `"Helvetica", ${STACK}`,
      fallback: info?.fallback ?? normalizeFamily(style?.fontFamily),
      assetId: info?.assetId,
      spaceEm,
      bold: info?.bold ?? false,
      italic: info?.italic ?? false,
      bounds: {
        left,
        top,
        width: Math.max(1, Math.max(...xs) - left),
        height: Math.max(1, Math.max(...ys) - top),
      },
    })
  }
  return runs
}

async function resolveFont(page: PDFPageProxy, fontKey: string): Promise<FontInfo | null> {
  const common = page.commonObjs as unknown as {
    has: (id: string) => boolean
    get: (id: string) => FontFaceLike
  }
  const deadline = performance.now() + 2500
  while (!common.has(fontKey) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (!common.has(fontKey)) return null
  let face: FontFaceLike
  try {
    face = common.get(fontKey)
  } catch {
    return null
  }
  const name = stripSubset(face.name ?? '')
  const bold = Boolean(face.bold) || /bold|black|heavy|semibold/i.test(name)
  const italic = Boolean(face.italic) || /italic|oblique/i.test(name)
  const standard = standardFamily(face.name)
  if (face.data && !face.missingFile && !face.isType3Font && !standard) {
    try {
      const bytes = face.data instanceof Uint8Array ? face.data : new Uint8Array(face.data)
      const assetId = addFontAsset(bytes, face.mimetype)
      await registerFontAsset(assetId)
      return {
        family: familyForAsset(assetId),
        fallback: normalizeFamily(name || face.fallbackName),
        assetId,
        spaceEm: fontSpaceEm(assetId),
        bold,
        italic,
      }
    } catch (error) {
      console.warn('Could not reuse the original font', error)
    }
  }
  const fallback = standard ?? normalizeFamily(name || face.fallbackName)
  return { family: cssFamily(name, fallback), fallback, bold, italic }
}

const spaceEmCache = new Map<string, number>()
const parsedFontCache = new Map<string, ParsedFont | null>()

type ParsedFont = ReturnType<typeof fontkit.create>

function parsedFont(assetId: string): ParsedFont | null {
  const hit = parsedFontCache.get(assetId)
  if (hit !== undefined) return hit
  let font: ParsedFont | null = null
  const src = getAsset(assetId)
  if (src) {
    try {
      font = fontkit.create(dataUrlBytes(src))
    } catch (error) {
      console.warn('Could not inspect the original font metrics', error)
    }
  }
  parsedFontCache.set(assetId, font)
  return font
}

/**
 * Width of a space in em fractions. pdf.js removes empty glyphs while
 * rebuilding embedded fonts, so most rebuilt fonts have no cmap entry for
 * U+0020; fall back to the most common advance among empty glyphs.
 */
function fontSpaceEm(assetId: string): number {
  const hit = spaceEmCache.get(assetId)
  if (hit !== undefined) return hit
  let value = 0
  const font = parsedFont(assetId)
  if (font) {
    if (font.hasGlyphForCodePoint(0x20)) {
      value = font.glyphForCodePoint(0x20).advanceWidth / font.unitsPerEm
    } else {
      value = modalEmptyAdvanceEm(font)
    }
  }
  value = value > 0.05 && value < 2 ? value : 0.25
  spaceEmCache.set(assetId, value)
  return value
}

/**
 * Exact space advance derived from a run whose width the PDF states. The
 * rebuilt font has no space glyph, so this recovers the real advance.
 */
function derivedSpaceEm(assetId: string, str: string, width: number, fontSize: number): number | null {
  const gaps = (str.match(/\s/g) ?? []).length
  if (!gaps || width <= 0 || fontSize <= 0) return null
  const font = parsedFont(assetId)
  if (!font || font.hasGlyphForCodePoint(0x20)) return null
  const units = font.unitsPerEm || 1000
  let wordUnits = 0
  for (const word of str.split(/\s+/).filter(Boolean)) {
    for (const ch of word) {
      const code = ch.codePointAt(0) ?? 0
      try {
        wordUnits += font.glyphForCodePoint(code).advanceWidth
      } catch {
        return null
      }
    }
  }
  const wordsWidth = (wordUnits / units) * fontSize
  const spaceEm = (width - wordsWidth) / gaps / fontSize
  return spaceEm > 0.05 && spaceEm < 2 ? spaceEm : null
}

function modalEmptyAdvanceEm(font: ParsedFont): number {
  const units = font.unitsPerEm || 1000
  const counts = new Map<number, number>()
  for (let id = 1; id < (font.numGlyphs ?? 0); id += 1) {
    let glyph
    try {
      glyph = font.getGlyph(id)
    } catch {
      continue
    }
    if (!glyph || glyph.advanceWidth <= 0) continue
    const { numberOfContours } = glyph as unknown as { numberOfContours?: number | null }
    if (numberOfContours !== 0 && numberOfContours != null) continue
    const key = Math.round((glyph.advanceWidth / units) * 1000)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best = 0
  let bestCount = 0
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key
      bestCount = count
    }
  }
  return best / 1000
}

function cssFamily(name: string, fallback: FontFamily): string {
  const cleaned = name.replace(/[-_](bold|italic|oblique|bolditalic|boldoblique)$/i, '')
  const usable = cleaned && !/^(sans-serif|serif|monospace|symbol)$/i.test(cleaned) ? `"${cleaned}", ` : ''
  return `${usable}"${fallback}", ${STACK}`
}

const assetByHash = new Map<string, string>()

function addFontAsset(bytes: Uint8Array, mimetype: string | undefined): string {
  const key = hashFont(bytes)
  const hit = assetByHash.get(key)
  if (hit && getAsset(hit)) return hit
  const mime = mimetype && mimetype !== 'null' ? mimetype : 'font/ttf'
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  const assetId = addAsset(`data:${mime};base64,${btoa(binary)}`)
  assetByHash.set(key, assetId)
  return assetId
}

/** Cheap content hash so the same font is only stored once per session. */
function hashFont(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  const step = Math.max(1, Math.floor(bytes.length / 4096))
  for (let i = 0; i < bytes.length; i += step) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 0x01000193)
  }
  return `${bytes.length}:${(hash >>> 0).toString(36)}`
}

/** True when a scene point falls inside a run's baseline box. */
export function runAtPoint(run: TextRun, x: number, y: number): boolean {
  const [a, b, c, d, e, f] = run.matrix
  const det = a * d - b * c || 1
  const dx = x - e
  const dy = y - f
  const size = run.fontSize || 1
  // u/v are in em units; convert to points to compare with the advance box.
  const u = ((d * dx - c * dy) / det) * size
  const v = ((-b * dx + a * dy) / det) * size
  return (
    u >= -1 &&
    u <= run.width + 1 &&
    v >= run.descent * size - 1 &&
    v <= run.ascent * size + 1
  )
}

const SAMPLE_SCALE = 4

/** Renders a small patch of the page and reads the run's text/background colours. */
export async function sampleRunColors(pdfPage: PDFPageProxy, run: TextRun): Promise<RunColors> {
  const defaults: RunColors = { color: '#111827', background: '#ffffff' }
  const pad = 2
  const left = run.bounds.left - pad
  const top = run.bounds.top - pad
  const width = Math.min(2000, Math.max(2, Math.ceil((run.bounds.width + pad * 2) * SAMPLE_SCALE)))
  const height = Math.min(1000, Math.max(2, Math.ceil((run.bounds.height + pad * 2) * SAMPLE_SCALE)))
  try {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const viewport = pdfPage.getViewport({ scale: SAMPLE_SCALE })
    await pdfPage.render({
      canvas,
      viewport,
      // The extra transform is composed after the viewport transform, so the
      // patch offset is in device pixels.
      transform: [1, 0, 0, 1, -left * SAMPLE_SCALE, -top * SAMPLE_SCALE],
    }).promise
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return defaults
    const pixels = context.getImageData(0, 0, width, height).data
    const bins = new Map<number, { n: number; r: number; g: number; b: number }>()
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3] / 255
      if (alpha < 0.1) continue
      // Composite over white so semi-transparent pages read like the viewer.
      const r = pixels[i] * alpha + 255 * (1 - alpha)
      const g = pixels[i + 1] * alpha + 255 * (1 - alpha)
      const b = pixels[i + 2] * alpha + 255 * (1 - alpha)
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
      const bin = bins.get(key)
      if (bin) {
        bin.n += 1
        bin.r += r
        bin.g += g
        bin.b += b
      } else {
        bins.set(key, { n: 1, r, g, b })
      }
    }
    if (!bins.size) return defaults
    let background = { n: 0, r: 255, g: 255, b: 255 }
    for (const bin of bins.values()) {
      if (bin.n > background.n) background = bin
    }
    const bg = { r: background.r / background.n, g: background.g / background.n, b: background.b / background.n }
    let weight = 0
    let fr = 0
    let fg = 0
    let fb = 0
    for (const bin of bins.values()) {
      const r = bin.r / bin.n
      const g = bin.g / bin.n
      const b = bin.b / bin.n
      const distance = Math.hypot(r - bg.r, g - bg.g, b - bg.b)
      if (distance < 60) continue
      weight += distance * bin.n
      fr += r * distance * bin.n
      fg += g * distance * bin.n
      fb += b * distance * bin.n
    }
    const luminance = (bg.r * 299 + bg.g * 587 + bg.b * 114) / 1000
    const color =
      weight > 0
        ? toHex(fr / weight, fg / weight, fb / weight)
        : luminance < 128
          ? '#ffffff'
          : '#111827'
    return { color, background: toHex(bg.r, bg.g, bg.b) }
  } catch (error) {
    console.error('Could not sample the text colours', error)
    return defaults
  }
}

export interface PdfTextData {
  kind: 'pdftext'
  originalText: string
  spawn: { left: number; top: number; width: number; angle: number }
  /** Advance width of the original run, used to find it in the content stream. */
  originalWidth: number
  font: { assetId?: string; family: FontFamily; bold: boolean; italic: boolean; spaceEm?: number }
}

/** Builds the editable replacement for a run (same font, size, colour and place). */
export function createPdfTextEditObject(run: TextRun, colors: RunColors): Textbox {
  const fontSize = Math.max(1, Math.min(400, run.fontSize))
  const heightImpl = fontSize * FONT_SIZE_MULT
  const baselineFromTop = heightImpl * (1 - FONT_SIZE_FRACTION)
  const radians = (run.angle * Math.PI) / 180
  const left = run.x + Math.sin(radians) * baselineFromTop
  const top = run.y - Math.cos(radians) * baselineFromTop
  const width = Math.max(fontSize, run.width + Math.max(2, run.width * 0.02))
  const data: PdfTextData = {
    kind: 'pdftext',
    originalText: run.str,
    spawn: { left, top, width, angle: run.angle },
    originalWidth: run.width,
    font: { assetId: run.assetId, family: run.fallback, bold: run.bold, italic: run.italic, spaceEm: run.spaceEm },
  }
  return new Textbox(run.str, {
    left,
    top,
    width,
    angle: run.angle,
    originX: 'left',
    originY: 'top',
    fontSize,
    fontFamily: run.family,
    fontWeight: run.bold ? 'bold' : 'normal',
    fontStyle: run.italic ? 'italic' : 'normal',
    fill: colors.color,
    backgroundColor: colors.background,
    editable: true,
    selectable: false,
    evented: true,
    hoverCursor: 'text',
    data,
  })
}

const HIGHLIGHT_FILL = 'rgba(59, 130, 246, 0.16)'
const HIGHLIGHT_STROKE = 'rgba(37, 99, 235, 0.9)'

/** Creates/updates/removes the hover highlight that shows what a click will edit. */
export function updateTextHighlight(
  canvas: Canvas,
  current: FabricObject | null,
  bounds: { left: number; top: number; width: number; height: number } | null,
): FabricObject | null {
  // A canvas reload (undo, page op) drops the highlight object.
  if (current && current.canvas !== canvas) current = null
  if (!bounds) {
    if (current) {
      canvas.remove(current)
      canvas.requestRenderAll()
    }
    return null
  }
  if (!current) {
    current = new Rect({
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
      originX: 'left',
      originY: 'top',
      fill: HIGHLIGHT_FILL,
      stroke: HIGHLIGHT_STROKE,
      strokeWidth: 1,
      strokeUniform: true,
      selectable: false,
      evented: false,
      excludeFromExport: true,
    })
    canvas.add(current)
  } else {
    current.set({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height })
    current.setCoords()
  }
  canvas.requestRenderAll()
  return current
}
