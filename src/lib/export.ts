import {
  BlendMode,
  LineCapStyle,
  PDFDocument,
  StandardFonts,
  beginText,
  closePath,
  degrees,
  endText,
  fill,
  lineTo,
  moveText,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rotateAndSkewTextDegreesAndTranslate,
  setFillingColor,
  setFontAndSize,
  showText,
  type PDFFont,
  type PDFName,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { Point, Textbox, util, type FabricObject } from 'fabric'
import { parseColor, toPdfRgb } from './color'
import { dataUrlBytes, dataUrlMime, flipDataUrl, getAsset } from './assets'
import { removeTextRuns, type TextRemovalTarget } from './contentEdit'
import type { FallbackFonts } from './fonts/fallback'
import { graphemes } from './fonts/graphemes'
import type { FontFamily } from '../types'

/** fabric's line-box and baseline fractions (see lib/textEdit.ts). */
const FONT_SIZE_MULT = 1.13
const FONT_SIZE_FRACTION = 0.222

export interface ExportPageInput {
  sourceIndex: number | null
  width: number
  height: number
  transform: number[]
  objects: unknown[]
}

type AnyObject = FabricObject & Record<string, any>

interface Vec {
  x: number
  y: number
}

export interface Inverted {
  point: (x: number, y: number) => Vec
  dir: (x: number, y: number) => Vec
}

/** Inverts the pdf.js viewport transform (view space -> PDF user space). */
export function makeInverse(t: number[]): Inverted {
  const [a, b, c, d, e, f] = t
  const det = a * d - b * c || 1
  return {
    point: (x, y) => {
      const dx = x - e
      const dy = y - f
      return { x: (d * dx - c * dy) / det, y: (-b * dx + a * dy) / det }
    },
    dir: (x, y) => ({ x: (d * x - c * y) / det, y: (-b * x + a * y) / det }),
  }
}

function localToScene(obj: AnyObject, lx: number, ly: number): Vec {
  const m = obj.calcTransformMatrix()
  const p = util.transformPoint(new Point(lx - obj.width / 2, ly - obj.height / 2), m)
  return { x: p.x, y: p.y }
}

function sceneDir(obj: AnyObject): Vec {
  const m = obj.calcTransformMatrix()
  return { x: m[0], y: m[1] }
}

interface Box {
  anchor: Vec
  center: Vec
  width: number
  height: number
  angle: number
}

function boxOf(obj: AnyObject, inv: Inverted, localHeight?: number): Box {
  const w = obj.width
  const h = localHeight ?? obj.height
  const tl = localToScene(obj, 0, 0)
  const tr = localToScene(obj, w, 0)
  const bl = localToScene(obj, 0, h)
  const centerScene = localToScene(obj, w / 2, h / 2)
  const pTL = inv.point(tl.x, tl.y)
  const pTR = inv.point(tr.x, tr.y)
  const pBL = inv.point(bl.x, bl.y)
  const center = inv.point(centerScene.x, centerScene.y)
  const ux = pTR.x - pTL.x
  const uy = pTR.y - pTL.y
  const vx = pBL.x - pTL.x
  const vy = pBL.y - pTL.y
  const bw = Math.hypot(ux, uy)
  const bh = Math.hypot(vx, vy)
  const rad = Math.atan2(uy, ux)
  const angle = (rad * 180) / Math.PI
  const anchor = {
    x: center.x - Math.cos(rad) * (bw / 2) + Math.sin(rad) * (bh / 2),
    y: center.y - Math.sin(rad) * (bw / 2) - Math.cos(rad) * (bh / 2),
  }
  return { anchor, center, width: bw, height: bh, angle }
}

function dirAngle(obj: AnyObject, inv: Inverted): number {
  const d = sceneDir(obj)
  const p = inv.dir(d.x, d.y)
  return (Math.atan2(p.y, p.x) * 180) / Math.PI
}

function scaleOf(obj: AnyObject): number {
  return (Math.abs(obj.scaleX ?? 1) + Math.abs(obj.scaleY ?? 1)) / 2
}

const FONT_MAP: Record<FontFamily, { normal: StandardFonts; bold: StandardFonts; italic: StandardFonts; boldItalic: StandardFonts }> = {
  Helvetica: {
    normal: StandardFonts.Helvetica,
    bold: StandardFonts.HelveticaBold,
    italic: StandardFonts.HelveticaOblique,
    boldItalic: StandardFonts.HelveticaBoldOblique,
  },
  'Times New Roman': {
    normal: StandardFonts.TimesRoman,
    bold: StandardFonts.TimesRomanBold,
    italic: StandardFonts.TimesRomanItalic,
    boldItalic: StandardFonts.TimesRomanBoldItalic,
  },
  'Courier New': {
    normal: StandardFonts.Courier,
    bold: StandardFonts.CourierBold,
    italic: StandardFonts.CourierOblique,
    boldItalic: StandardFonts.CourierBoldOblique,
  },
}

export function normalizeFamily(family: unknown): FontFamily {
  if (typeof family !== 'string') return 'Helvetica'
  const f = family.toLowerCase()
  if (f.includes('times') || f.includes('serif') || f.includes('georgia')) return 'Times New Roman'
  if (f.includes('courier') || f.includes('mono')) return 'Courier New'
  return 'Helvetica'
}

const encodingCache = new WeakMap<PDFFont, Map<string, boolean>>()

/** Whether a standard (WinAnsi) font can encode every character of `text`. */
function canEncode(text: string, font: PDFFont): boolean {
  let cache = encodingCache.get(font)
  if (!cache) {
    cache = new Map()
    encodingCache.set(font, cache)
  }
  for (const ch of text) {
    let ok = cache.get(ch)
    if (ok === undefined) {
      ok = true
      try {
        font.encodeText(ch)
      } catch {
        ok = false
      }
      cache.set(ch, ok)
    }
    if (!ok) return false
  }
  return true
}

/** Standard fonts use WinAnsi; replace anything they cannot encode. */
function sanitizeText(text: string, font: PDFFont): string {
  let out = ''
  for (const ch of text) {
    if (ch === '\t') {
      out += '    '
      continue
    }
    const code = ch.codePointAt(0) ?? 0
    if (code < 32 && ch !== '\n') continue
    out += ch === '\n' || canEncode(ch, font) ? ch : '?'
  }
  return out
}

/** One stretch of a line drawn with a single font. */
interface TextRun {
  font: PDFFont
  text: string
}

/**
 * Glyphs the standard font cannot encode, mapped to an embedded fallback font
 * (see lib/fonts/fallback.ts). Keys are grapheme clusters of the sanitized text.
 */
interface FallbackPlan {
  primary: PDFFont
  clusters: Map<string, TextRun>
}

/**
 * Resolves every cluster the standard font cannot encode against the bundled
 * fallback fonts. Returns null (the plain standard-font path) when the text
 * needs no fallback, so nothing is downloaded or embedded for WinAnsi text.
 */
async function planFallback(
  text: string,
  primary: PDFFont,
  bold: boolean,
  ctx: DrawContext,
): Promise<{ text: string; plan: FallbackPlan } | null> {
  const needsFallback = Array.from(text).some((ch) => (ch.codePointAt(0) ?? 0) >= 32 && !canEncode(ch, primary))
  if (!needsFallback) return null
  const fonts = await ctx.getFallback()
  if (!fonts) return null
  const clusters = new Map<string, TextRun>()
  let out = ''
  for (const cluster of graphemes(text.normalize('NFC'))) {
    if (cluster === '\t') {
      out += '    '
      continue
    }
    const visible = Array.from(cluster).filter((ch) => (ch.codePointAt(0) ?? 0) >= 32).join('')
    if (!visible) {
      if (cluster.includes('\n')) out += '\n'
      continue
    }
    if (canEncode(visible, primary)) {
      out += visible
      continue
    }
    const resolved = clusters.get(visible) ?? (await fonts.resolve(visible, bold))
    if (resolved) {
      clusters.set(visible, resolved)
      out += visible
      continue
    }
    // No single font draws the whole cluster: keep its base character.
    const base = Array.from(visible)[0]
    if (canEncode(base, primary)) {
      out += base
      continue
    }
    const single = clusters.get(base) ?? (await fonts.resolve(base, bold))
    if (single) {
      clusters.set(base, single)
      out += base
    } else {
      out += '?'
    }
  }
  return { text: out, plan: { primary, clusters } }
}

/** Splits a line into runs that share a font. */
function textRuns(line: string, plan: FallbackPlan): TextRun[] {
  const runs: TextRun[] = []
  for (const cluster of graphemes(line)) {
    const mapped = plan.clusters.get(cluster)
    const run = mapped ?? { font: plan.primary, text: canEncode(cluster, plan.primary) ? cluster : '?' }
    const last = runs[runs.length - 1]
    if (last && last.font === run.font) last.text += run.text
    else runs.push({ ...run })
  }
  return runs
}

function runWidth(run: TextRun, size: number): number {
  try {
    return run.font.widthOfTextAtSize(run.text, size)
  } catch {
    return Array.from(run.text).length * size * 0.5
  }
}

function wrapText(text: string, maxWidth: number, measure: (value: string) => number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    if (!paragraph) {
      lines.push('')
      continue
    }
    if (maxWidth <= 0) {
      lines.push(paragraph)
      continue
    }
    const words = paragraph.split(' ')
    let current = ''
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word
      const candidateWidth = measure(candidate)
      if (candidateWidth <= maxWidth || !current) {
        if (candidateWidth > maxWidth && !current) {
          // Single word too long: hard-break it.
          let chunk = ''
          for (const ch of graphemes(word)) {
            const next = chunk + ch
            if (measure(next) > maxWidth && chunk) {
              lines.push(chunk)
              chunk = ch
            } else {
              chunk = next
            }
          }
          current = chunk
        } else {
          current = candidate
        }
      } else {
        lines.push(current)
        current = word
      }
    }
    lines.push(current)
  }
  return lines
}

function sampledPathPoints(obj: AnyObject, inv: Inverted): Vec[][] {
  const commands = (obj.path ?? []) as any[]
  const offset = (obj.pathOffset ?? { x: 0, y: 0 }) as Vec
  const toScene = (x: number, y: number) => {
    const m = obj.calcTransformMatrix()
    const p = util.transformPoint(new Point(x - offset.x, y - offset.y), m)
    return inv.point(p.x, p.y)
  }
  const strokes: Vec[][] = []
  let current: Vec | null = null
  let start: Vec | null = null
  let stroke: Vec[] = []
  const flush = () => {
    if (stroke.length > 1) strokes.push(stroke)
    else if (stroke.length === 1) strokes.push(stroke)
    stroke = []
  }
  for (const command of commands) {
    const op = command[0]
    if (op === 'M') {
      flush()
      current = toScene(command[1], command[2])
      start = current
      stroke = [current]
    } else if (op === 'L') {
      if (!current) continue
      current = toScene(command[1], command[2])
      stroke.push(current)
    } else if (op === 'Q') {
      if (!current) continue
      const c = toScene(command[1], command[2])
      const end = toScene(command[3], command[4])
      const from = current
      for (let i = 1; i <= 8; i += 1) {
        const t = i / 8
        const mt = 1 - t
        stroke.push({
          x: mt * mt * from.x + 2 * mt * t * c.x + t * t * end.x,
          y: mt * mt * from.y + 2 * mt * t * c.y + t * t * end.y,
        })
      }
      current = end
    } else if (op === 'C') {
      if (!current) continue
      const c1 = toScene(command[1], command[2])
      const c2 = toScene(command[3], command[4])
      const end = toScene(command[5], command[6])
      const from = current
      for (let i = 1; i <= 10; i += 1) {
        const t = i / 10
        const mt = 1 - t
        stroke.push({
          x: mt ** 3 * from.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * end.x,
          y: mt ** 3 * from.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * end.y,
        })
      }
      current = end
    } else if (op === 'Z' && start) {
      stroke.push(start)
      current = start
      flush()
    }
  }
  flush()
  return strokes
}

export interface BuildOptions {
  onProgress?: (done: number, total: number) => void
}

export async function buildPdf(
  originalBytes: Uint8Array,
  pages: ExportPageInput[],
  options: BuildOptions = {},
): Promise<Uint8Array> {
  const source = await PDFDocument.load(originalBytes, { ignoreEncryption: true, updateMetadata: false })
  const out = await PDFDocument.create()
  out.registerFontkit(fontkit)
  try {
    const title = source.getTitle()
    if (title) out.setTitle(title)
    const author = source.getAuthor()
    if (author) out.setAuthor(author)
    const subject = source.getSubject()
    if (subject) out.setSubject(subject)
    const keywords = source.getKeywords()
    if (keywords) out.setKeywords(keywords.split(/[,;]\s*/))
    const creator = source.getCreator()
    if (creator) out.setCreator(creator)
  } catch {
    // Metadata is best-effort.
  }

  const fonts = new Map<string, PDFFont>()
  const getFont = async (family: FontFamily, bold: boolean, italic: boolean): Promise<PDFFont> => {
    const variant = bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'normal'
    const key = `${family}:${variant}`
    const hit = fonts.get(key)
    if (hit) return hit
    const font = await out.embedFont(FONT_MAP[family][variant], { subset: false })
    fonts.set(key, font)
    return font
  }

  // Font programs collected while editing existing text (see lib/textEdit.ts).
  const customFonts = new Map<string, CustomFontInfo | null>()
  const getCustomFontInfo = async (assetId: string): Promise<CustomFontInfo | null> => {
    const hit = customFonts.get(assetId)
    if (hit !== undefined) return hit
    const src = getAsset(assetId)
    if (!src) {
      customFonts.set(assetId, null)
      return null
    }
    try {
      const bytes = dataUrlBytes(src)
      const font = await out.embedFont(bytes, { subset: true })
      let metrics: CustomFontMetrics | null = null
      try {
        metrics = makeCustomFontMetrics(fontkit.create(bytes))
      } catch (error) {
        console.warn('Could not read the original font metrics', error)
      }
      const info = { font, metrics }
      customFonts.set(assetId, info)
      return info
    } catch (error) {
      console.warn('Could not embed the original font; falling back to a standard font', error)
      customFonts.set(assetId, null)
      return null
    }
  }

  // Loaded only when some text needs glyphs the standard fonts lack.
  let fallback: Promise<FallbackFonts | null> | null = null
  const getFallback = (): Promise<FallbackFonts | null> => {
    fallback ??= import('./fonts/fallback')
      .then(({ createFallbackFonts }) => createFallbackFonts(out))
      .catch((error) => {
        console.warn('Could not load the fallback fonts', error)
        return null
      })
    return fallback
  }

  const images = new Map<string, PDFImage>()
  const getImage = async (src: string): Promise<PDFImage> => {
    const hit = images.get(src)
    if (hit) return hit
    const mime = dataUrlMime(src)
    const bytes = dataUrlBytes(src)
    let embedded: PDFImage
    if (mime === 'image/jpeg' || (bytes[0] === 0xff && bytes[1] === 0xd8)) {
      embedded = await out.embedJpg(bytes)
    } else {
      embedded = await out.embedPng(bytes)
    }
    images.set(src, embedded)
    return embedded
  }

  const total = pages.length
  for (let index = 0; index < total; index += 1) {
    const input = pages[index]
    let page: PDFPage
    if (input.sourceIndex != null) {
      const [copied] = await out.copyPages(source, [input.sourceIndex])
      page = out.addPage(copied)
    } else {
      page = out.addPage([input.width, input.height])
    }
    const inv = makeInverse(input.transform)
    const objects = await enliven(input.objects)
    const realEdits = new WeakSet<FabricObject>()
    if (input.sourceIndex != null) {
      const edits = objects.filter((object) => {
        const edit = object as AnyObject
        return edit.data?.kind === 'pdftext' && String(edit.text ?? '').trim()
      })
      if (edits.length) {
        const targets = edits.map((object) => pdfTextTarget(object as AnyObject, inv))
        try {
          for (const index of removeTextRuns(page, targets)) realEdits.add(edits[index])
        } catch (error) {
          // Fall back to covering the original run.
          console.warn('Could not remove the original text from the page', error)
        }
      }
    }
    for (const obj of objects) {
      await drawObject(obj as AnyObject, page, inv, { getFont, getImage, getCustomFontInfo, getFallback, realEdits })
    }
    options.onProgress?.(index + 1, total)
  }

  return out.save({ useObjectStreams: true })
}

interface CustomFontMetrics {
  /** Space advance in em fractions. */
  spaceEm: number
  /** True when the font can draw this code point (space and newlines always can). */
  hasGlyph: (codePoint: number) => boolean
  /**
   * Width of a string in em fractions, from the raw glyph advances. PDF
   * viewers position glyphs with the widths array, not with kerning, so this
   * matches what the saved file will render.
   */
  advanceEm: (value: string) => number
}

interface CustomFontInfo {
  font: PDFFont
  metrics: CustomFontMetrics | null
}

interface DrawContext {
  getFont: (family: FontFamily, bold: boolean, italic: boolean) => Promise<PDFFont>
  getImage: (src: string) => Promise<PDFImage>
  getCustomFontInfo: (assetId: string) => Promise<CustomFontInfo | null>
  /** Fallback fonts for characters outside WinAnsi, loaded on first use. */
  getFallback: () => Promise<FallbackFonts | null>
  /** Edited runs whose original glyphs were deleted from the content stream. */
  realEdits: WeakSet<FabricObject>
}

/**
 * Location of a retyped run, in PDF user space. The spawn box is stored in
 * scene coordinates; undo the fabric baseline offset and the viewport transform
 * to get back to the content-stream coordinate system.
 */
export function pdfTextTarget(obj: AnyObject, inv: Inverted): TextRemovalTarget {
  const spawn = (obj.data?.spawn ?? {}) as { left?: number; top?: number; width?: number; angle?: number }
  const fontSize = Number(obj.fontSize) || 16
  const angle = Number(spawn.angle) || 0
  const radians = (angle * Math.PI) / 180
  const baselineFromTop = fontSize * FONT_SIZE_MULT * (1 - FONT_SIZE_FRACTION)
  const sceneX = (Number(spawn.left) || 0) - Math.sin(radians) * baselineFromTop
  const sceneY = (Number(spawn.top) || 0) + Math.cos(radians) * baselineFromTop
  const origin = inv.point(sceneX, sceneY)
  const direction = inv.dir(Math.cos(radians), Math.sin(radians))
  const spawnWidth = Number(spawn.width) || fontSize
  const width =
    typeof obj.data?.originalWidth === 'number'
      ? obj.data.originalWidth
      : Math.max(fontSize, (spawnWidth - 2) / 1.02)
  return {
    text: String(obj.data?.originalText ?? ''),
    x: origin.x,
    y: origin.y,
    width,
    fontSize,
    angle: Math.atan2(direction.y, direction.x),
  }
}

function makeCustomFontMetrics(fk: ReturnType<typeof fontkit.create>): CustomFontMetrics {
  const unitsPerEm = fk.unitsPerEm || 1000
  let spaceEm = 0
  if (fk.hasGlyphForCodePoint(0x20)) {
    spaceEm = fk.glyphForCodePoint(0x20).advanceWidth / unitsPerEm
  } else {
    // pdf.js rebuilds embedded fonts without their empty glyphs, so space has
    // no cmap entry; use the most common empty-glyph advance instead.
    const counts = new Map<number, number>()
    for (let id = 1; id < (fk.numGlyphs ?? 0); id += 1) {
      let glyph
      try {
        glyph = fk.getGlyph(id)
      } catch {
        continue
      }
      if (!glyph || glyph.advanceWidth <= 0) continue
      const { numberOfContours } = glyph as unknown as { numberOfContours?: number | null }
      if (numberOfContours !== 0 && numberOfContours != null) continue
      const key = Math.round((glyph.advanceWidth / unitsPerEm) * 1000)
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
    spaceEm = best / 1000
  }
  if (!(spaceEm > 0.05 && spaceEm < 2)) spaceEm = 0.25
  return {
    spaceEm,
    hasGlyph: (codePoint) =>
      codePoint === 0x20 || codePoint === 0x0a || codePoint === 0x0d || fk.hasGlyphForCodePoint(codePoint),
    advanceEm: (value) => {
      let units = 0
      for (const ch of value) {
        const code = ch.codePointAt(0) ?? 0
        units += fk.glyphForCodePoint(code).advanceWidth
      }
      return units / unitsPerEm
    },
  }
}

async function enliven(objects: unknown[]): Promise<FabricObject[]> {
  if (!objects.length) return []
  const result = await util.enlivenObjects<FabricObject>(objects as any[])
  return result
}

async function drawObject(obj: AnyObject, page: PDFPage, inv: Inverted, ctx: DrawContext): Promise<void> {
  if (obj.visible === false) return
  const kind = (obj.data?.kind as string | undefined) ?? undefined
  const type = String(obj.type ?? '').toLowerCase()

  if (type === 'group' || type === 'activeselection') {
    const children = (obj.getObjects?.() ?? []) as AnyObject[]
    for (const child of children) {
      await drawObject(child, page, inv, ctx)
    }
    return
  }

  if (kind === 'pdftext') {
    await drawTextObject(obj, page, inv, ctx)
    return
  }
  if (kind === 'text' || type === 'i-text' || type === 'textbox' || type === 'text') {
    await drawTextObject(obj, page, inv, ctx)
    return
  }
  if (kind === 'image' || type === 'image') {
    await drawImageObject(obj, page, inv, ctx)
    return
  }
  if (kind === 'draw' || kind === 'highlight' || type === 'path') {
    drawPathObject(obj, page, inv)
    return
  }
  if (kind === 'line' || type === 'line') {
    drawLineObject(obj, page, inv)
    return
  }
  if (kind === 'triangle' || type === 'triangle') {
    drawTriangleObject(obj, page, inv)
    return
  }
  if (kind === 'ellipse' || type === 'ellipse' || type === 'circle') {
    drawEllipseObject(obj, page, inv)
    return
  }
  if (kind === 'rect' || kind === 'whiteout' || type === 'rect') {
    drawRectObject(obj, page, inv)
    return
  }
}

function strokeStyle(obj: AnyObject): { thickness: number; color: ReturnType<typeof parseColor>; opacity: number } | null {
  if (!obj.stroke || obj.strokeWidth == null) return null
  const color = parseColor(obj.stroke)
  if (color.a === 0) return null
  const opacity = Math.max(0, Math.min(1, (obj.opacity ?? 1) * color.a))
  return { thickness: Math.max(0.25, obj.strokeWidth * scaleOf(obj)), color, opacity }
}

function fillStyle(obj: AnyObject): { color: ReturnType<typeof parseColor>; opacity: number } | null {
  if (!obj.fill || obj.fill === 'transparent') return null
  const color = parseColor(obj.fill)
  if (color.a === 0) return null
  return { color, opacity: Math.max(0, Math.min(1, (obj.opacity ?? 1) * color.a)) }
}

function drawRectObject(obj: AnyObject, page: PDFPage, inv: Inverted): void {
  const box = boxOf(obj, inv)
  if (box.width <= 0 || box.height <= 0) return
  const stroke = strokeStyle(obj)
  const fillPaint = fillStyle(obj)
  if (!stroke && !fillPaint) return
  page.drawRectangle({
    x: box.anchor.x,
    y: box.anchor.y,
    width: box.width,
    height: box.height,
    rotate: degrees(box.angle),
    color: fillPaint ? toPdfRgb(fillPaint.color) : undefined,
    opacity: fillPaint?.opacity,
    borderColor: stroke ? toPdfRgb(stroke.color) : undefined,
    borderOpacity: stroke?.opacity,
    borderWidth: stroke?.thickness,
  })
}

function drawEllipseObject(obj: AnyObject, page: PDFPage, inv: Inverted): void {
  const box = boxOf(obj, inv)
  if (box.width <= 0 || box.height <= 0) return
  const stroke = strokeStyle(obj)
  const fillPaint = fillStyle(obj)
  if (!stroke && !fillPaint) return
  page.drawEllipse({
    x: box.center.x,
    y: box.center.y,
    xScale: box.width / 2,
    yScale: box.height / 2,
    rotate: degrees(box.angle),
    color: fillPaint ? toPdfRgb(fillPaint.color) : undefined,
    opacity: fillPaint?.opacity,
    borderColor: stroke ? toPdfRgb(stroke.color) : undefined,
    borderOpacity: stroke?.opacity,
    borderWidth: stroke?.thickness,
  })
}

function drawLineObject(obj: AnyObject, page: PDFPage, inv: Inverted): void {
  const stroke = strokeStyle(obj)
  if (!stroke) return
  const points = (obj as any).calcLinePoints() as { x1: number; y1: number; x2: number; y2: number }
  const m = obj.calcTransformMatrix()
  const a = util.transformPoint(new Point(points.x1, points.y1), m)
  const b = util.transformPoint(new Point(points.x2, points.y2), m)
  const start = inv.point(a.x, a.y)
  const end = inv.point(b.x, b.y)
  page.drawLine({
    start,
    end,
    thickness: stroke.thickness,
    color: toPdfRgb(stroke.color),
    opacity: stroke.opacity,
    lineCap: LineCapStyle.Round,
  })
}

function drawTriangleObject(obj: AnyObject, page: PDFPage, inv: Inverted): void {
  const fillPaint = fillStyle(obj)
  if (!fillPaint) return
  const w = obj.width
  const h = obj.height
  const apex = localToScene(obj, w / 2, 0)
  const left = localToScene(obj, 0, h)
  const right = localToScene(obj, w, h)
  const p1 = inv.point(apex.x, apex.y)
  const p2 = inv.point(left.x, left.y)
  const p3 = inv.point(right.x, right.y)
  page.pushOperators(
    pushGraphicsState(),
    setFillingColor(toPdfRgb(fillPaint.color)),
    moveTo(p1.x, p1.y),
    lineTo(p2.x, p2.y),
    lineTo(p3.x, p3.y),
    closePath(),
    fill(),
    popGraphicsState(),
  )
}

function drawPathObject(obj: AnyObject, page: PDFPage, inv: Inverted): void {
  const stroke = strokeStyle(obj)
  if (!stroke) return
  const isHighlight = obj.globalCompositeOperation === 'multiply'
  const color = toPdfRgb(stroke.color)
  for (const points of sampledPathPoints(obj, inv)) {
    if (!points.length) continue
    if (points.length === 1) {
      page.drawCircle({
        x: points[0].x,
        y: points[0].y,
        size: stroke.thickness / 2,
        color,
        opacity: stroke.opacity,
      })
      continue
    }
    // One stroked SVG path per stroke so opacity/blend apply a single time,
    // matching what the canvas layer shows (and keeping the file small).
    const origin = points[0]
    const commands = [`M 0 0`]
    for (let i = 1; i < points.length; i += 1) {
      const point = points[i]
      commands.push(`L ${(point.x - origin.x).toFixed(3)} ${(origin.y - point.y).toFixed(3)}`)
    }
    page.drawSvgPath(commands.join(' '), {
      x: origin.x,
      y: origin.y,
      borderColor: color,
      borderWidth: stroke.thickness,
      borderOpacity: stroke.opacity,
      borderLineCap: LineCapStyle.Round,
      blendMode: isHighlight ? BlendMode.Multiply : undefined,
    })
  }
}

async function drawTextObject(obj: AnyObject, page: PDFPage, inv: Inverted, ctx: DrawContext): Promise<void> {
  const text = typeof obj.text === 'string' ? obj.text : ''
  if (!text.trim()) return
  const data = (obj.data ?? {}) as {
    kind?: string
    font?: { assetId?: string; family?: FontFamily; bold?: boolean; italic?: boolean; spaceEm?: number }
  }
  const editing = data.kind === 'pdftext'
  const fontSize = Number(obj.fontSize) || 16
  let font: PDFFont
  let custom: CustomFontInfo | null = null
  let bold = false
  if (editing && typeof data.font?.assetId === 'string') {
    custom = await ctx.getCustomFontInfo(data.font.assetId)
  }
  if (custom) {
    font = custom.font
  } else {
    const family = editing && data.font?.family ? data.font.family : normalizeFamily(obj.fontFamily)
    bold = editing
      ? Boolean(data.font?.bold)
      : String(obj.fontWeight ?? '').toLowerCase() === 'bold' || Number(obj.fontWeight) >= 600
    const italic = editing
      ? Boolean(data.font?.italic)
      : String(obj.fontStyle ?? '').toLowerCase() === 'italic'
    font = await ctx.getFont(family, bold, italic)
  }
  const fallback = custom ? null : await planFallback(text, font, bold, ctx)
  const plan = fallback?.plan ?? null
  const sanitized = custom
    ? sanitizeCustomText(text, custom.metrics)
    : fallback?.text ?? sanitizeText(text, font)
  const lineHeight = Number(obj.lineHeight) || 1.16
  const heightImpl = fontSize * FONT_SIZE_MULT
  const lineAdvance = editing ? heightImpl * lineHeight : fontSize * (Number(obj.lineHeightFactor) || 1.16)
  const baseline = editing ? heightImpl * (1 - FONT_SIZE_FRACTION) : fontSize * 0.8
  const align = String(obj.textAlign ?? 'left')
  const color = parseColor(obj.fill)
  const opacity = Math.max(0, Math.min(1, (obj.opacity ?? 1) * (color.a === 0 ? 1 : color.a)))
  const paint = color.a === 0 ? parseColor('#000000') : color
  const boxWidth = obj.width
  const spaceEm = custom ? clampSpaceEm(data.font?.spaceEm ?? custom.metrics?.spaceEm) : 0
  const measure = (value: string): number => {
    if (custom) return measureCustomText(custom, value, fontSize, spaceEm)
    if (plan) return textRuns(value, plan).reduce((sum, run) => sum + runWidth(run, fontSize), 0)
    try {
      return font.widthOfTextAtSize(value, fontSize)
    } catch {
      return value.length * fontSize * 0.5
    }
  }
  // Text-tool objects are IText: their lines are exactly their newlines, so
  // only Textbox runs (edited PDF text) wrap to the box width.
  const lines = wrapText(sanitized, obj instanceof Textbox ? boxWidth : 0, measure)
  const angle = dirAngle(obj, inv)
  if (editing) {
    // When the original run was deleted from the content stream there is
    // nothing left to cover; only fall back to a sampled background rectangle
    // when the run could not be located in the saved content.
    if (!ctx.realEdits.has(obj)) {
      const background = parseColor(obj.backgroundColor)
      if (background.a > 0) {
        const coverHeight = (lines.length - 1) * lineAdvance + heightImpl
        const box = boxOf(obj, inv, coverHeight)
        if (box.width > 0 && box.height > 0) {
          page.drawRectangle({
            x: box.anchor.x,
            y: box.anchor.y,
            width: box.width,
            height: box.height,
            rotate: degrees(box.angle),
            color: toPdfRgb(background),
            opacity: Math.max(0, Math.min(1, (obj.opacity ?? 1) * background.a)),
          })
        }
      }
    }
  }
  if (custom && align === 'left' && opacity >= 1) {
    drawCustomFontText(obj, page, inv, custom, lines, {
      fontSize,
      lineAdvance,
      baseline,
      angle,
      color: toPdfRgb(paint),
      spaceEm,
    })
    return
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line) continue
    const lineWidth = measure(line)
    let lx = 0
    if (align === 'center') lx = (boxWidth - lineWidth) / 2
    else if (align === 'right' || align === 'justify' || align === 'justify-center' || align === 'justify-right') {
      lx = boxWidth - lineWidth
    }
    const runs = plan ? textRuns(line, plan) : [{ font, text: line }]
    let offset = 0
    for (const run of runs) {
      const scene = localToScene(obj, lx + offset, baseline + i * lineAdvance)
      const point = inv.point(scene.x, scene.y)
      page.drawText(run.text, {
        x: point.x,
        y: point.y,
        size: fontSize,
        font: run.font,
        color: toPdfRgb(paint),
        opacity,
        rotate: degrees(angle),
      })
      if (runs.length > 1) offset += runWidth(run, fontSize)
    }
  }
}

function clampSpaceEm(value: number | undefined): number {
  return typeof value === 'number' && value > 0.05 && value < 2 ? value : 0.25
}

/** Replaces characters the embedded font cannot draw with a question mark. */
function sanitizeCustomText(text: string, metrics: CustomFontMetrics | null): string {
  if (!metrics) return text
  let out = ''
  for (const ch of text) {
    if (ch === '\t') {
      out += '    '
      continue
    }
    const code = ch.codePointAt(0) ?? 0
    if (code < 32 && ch !== '\n') continue
    out += metrics.hasGlyph(code) ? ch : '?'
  }
  return out
}

/** Width of a string when spaces advance by `spaceEm` instead of a glyph. */
function measureCustomText(
  custom: CustomFontInfo,
  text: string,
  size: number,
  spaceEm: number,
): number {
  if (!custom.metrics) {
    try {
      return custom.font.widthOfTextAtSize(text, size)
    } catch {
      return text.length * size * 0.5
    }
  }
  const parts = text.split(' ')
  let width = 0
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) width += spaceEm * size
    if (parts[i]) width += custom.metrics.advanceEm(parts[i]) * size
  }
  return width
}

/**
 * Draws text with an embedded font at the operator level. Spaces are emitted
 * as positioning offsets: pdf.js removes empty glyphs when rebuilding fonts,
 * so the embedded space glyph may not exist. `Td` is relative to the line
 * matrix, which only moves when we move it, so each gap adds the previous
 * word's width plus the space advance.
 */
function drawCustomFontText(
  obj: AnyObject,
  page: PDFPage,
  inv: Inverted,
  custom: CustomFontInfo,
  lines: string[],
  options: { fontSize: number; lineAdvance: number; baseline: number; angle: number; color: ReturnType<typeof toPdfRgb>; spaceEm: number },
): void {
  const { font, metrics } = custom
  const { newFontKey: fontKey } = (
    page as unknown as {
      setOrEmbedFont: (value: PDFFont) => { newFont: PDFFont; newFontKey: PDFName }
    }
  ).setOrEmbedFont(font)
  const spaceWidth = options.spaceEm * options.fontSize
  const advance = (word: string): number => {
    if (metrics) return metrics.advanceEm(word) * options.fontSize
    try {
      return font.widthOfTextAtSize(word, options.fontSize)
    } catch {
      return word.length * options.fontSize * 0.5
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line) continue
    const scene = localToScene(obj, 0, options.baseline + i * options.lineAdvance)
    const point = inv.point(scene.x, scene.y)
    const operators = [
      beginText(),
      setFillingColor(options.color),
      setFontAndSize(fontKey, options.fontSize),
      rotateAndSkewTextDegreesAndTranslate(options.angle, 0, 0, point.x, point.y),
    ]
    const words = line.split(' ')
    for (let w = 0; w < words.length; w += 1) {
      if (words[w]) operators.push(showText(font.encodeText(words[w])))
      if (w < words.length - 1) operators.push(moveText(advance(words[w]) + spaceWidth, 0))
    }
    operators.push(endText())
    page.pushOperators(...operators)
  }
}
async function drawImageObject(obj: AnyObject, page: PDFPage, inv: Inverted, ctx: DrawContext): Promise<void> {
  let src = typeof obj.getSrc === 'function' ? obj.getSrc() : (obj.src as string | undefined)
  if (!src) return
  if (obj.flipX || obj.flipY) {
    try {
      src = await flipDataUrl(src, Boolean(obj.flipX), Boolean(obj.flipY))
    } catch {
      // Fall back to the unflipped bitmap.
    }
  }
  const image = await ctx.getImage(src)
  const box = boxOf(obj, inv)
  if (box.width <= 0 || box.height <= 0) return
  const bottomLeft = localToScene(obj, 0, obj.height)
  const anchor = inv.point(bottomLeft.x, bottomLeft.y)
  page.drawImage(image, {
    x: anchor.x,
    y: anchor.y,
    width: box.width,
    height: box.height,
    rotate: degrees(dirAngle(obj, inv)),
    opacity: Math.max(0, Math.min(1, obj.opacity ?? 1)),
  })
}

/** Viewport transform equivalent for a blank page of the given height. */
export function blankPageTransform(height: number): number[] {
  return [1, 0, 0, -1, 0, height]
}
