import {
  BlendMode,
  LineCapStyle,
  PDFDocument,
  StandardFonts,
  closePath,
  degrees,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  setFillingColor,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib'
import { Point, util, type FabricObject } from 'fabric'
import { parseColor, toPdfRgb } from './color'
import { dataUrlBytes, dataUrlMime, flipDataUrl } from './assets'
import type { FontFamily } from '../types'

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

interface Inverted {
  point: (x: number, y: number) => Vec
  dir: (x: number, y: number) => Vec
}

/** Inverts the pdf.js viewport transform (view space -> PDF user space). */
function makeInverse(t: number[]): Inverted {
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

function boxOf(obj: AnyObject, inv: Inverted): Box {
  const w = obj.width
  const h = obj.height
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

function normalizeFamily(family: unknown): FontFamily {
  if (typeof family !== 'string') return 'Helvetica'
  const f = family.toLowerCase()
  if (f.includes('times') || f.includes('serif') || f.includes('georgia')) return 'Times New Roman'
  if (f.includes('courier') || f.includes('mono')) return 'Courier New'
  return 'Helvetica'
}

const encodingCache = new WeakMap<PDFFont, Map<string, string>>()

/** Standard fonts use WinAnsi; replace anything they cannot encode. */
function sanitizeText(text: string, font: PDFFont): string {
  let cache = encodingCache.get(font)
  if (!cache) {
    cache = new Map()
    encodingCache.set(font, cache)
  }
  let out = ''
  for (const ch of text) {
    if (ch === '\t') {
      out += '    '
      continue
    }
    const code = ch.codePointAt(0) ?? 0
    if (code < 32) continue
    let mapped = cache.get(ch)
    if (mapped === undefined) {
      mapped = ch
      try {
        font.encodeText(ch)
      } catch {
        mapped = '?'
      }
      cache.set(ch, mapped)
    }
    out += mapped
  }
  return out
}

function wrapText(text: string, maxWidth: number, font: PDFFont, size: number): string[] {
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
    for (let word of words) {
      const candidate = current ? `${current} ${word}` : word
      let candidateWidth = 0
      try {
        candidateWidth = font.widthOfTextAtSize(candidate, size)
      } catch {
        candidateWidth = candidate.length * size * 0.5
      }
      if (candidateWidth <= maxWidth || !current) {
        if (candidateWidth > maxWidth && !current) {
          // Single word too long: hard-break it.
          let chunk = ''
          for (const ch of word) {
            const next = chunk + ch
            let w = 0
            try {
              w = font.widthOfTextAtSize(next, size)
            } catch {
              w = next.length * size * 0.5
            }
            if (w > maxWidth && chunk) {
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
    for (const obj of objects) {
      await drawObject(obj as AnyObject, page, inv, { getFont, getImage })
    }
    options.onProgress?.(index + 1, total)
  }

  return out.save({ useObjectStreams: true })
}

interface DrawContext {
  getFont: (family: FontFamily, bold: boolean, italic: boolean) => Promise<PDFFont>
  getImage: (src: string) => Promise<PDFImage>
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
  const fontSize = Number(obj.fontSize) || 16
  const family = normalizeFamily(obj.fontFamily)
  const bold = String(obj.fontWeight ?? '').toLowerCase() === 'bold' || Number(obj.fontWeight) >= 600
  const italic = String(obj.fontStyle ?? '').toLowerCase() === 'italic'
  const font = await ctx.getFont(family, bold, italic)
  const sanitized = sanitizeText(text, font)
  const lineAdvance = fontSize * (Number(obj.lineHeightFactor) || 1.16)
  const ascent = fontSize * 0.8
  const align = String(obj.textAlign ?? 'left')
  const color = parseColor(obj.fill)
  const opacity = Math.max(0, Math.min(1, (obj.opacity ?? 1) * (color.a === 0 ? 1 : color.a)))
  const paint = color.a === 0 ? parseColor('#000000') : color
  const boxWidth = obj.width
  const lines = wrapText(sanitized, boxWidth, font, fontSize)
  const angle = dirAngle(obj, inv)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line) continue
    let lineWidth = 0
    try {
      lineWidth = font.widthOfTextAtSize(line, fontSize)
    } catch {
      lineWidth = line.length * fontSize * 0.5
    }
    let lx = 0
    if (align === 'center') lx = (boxWidth - lineWidth) / 2
    else if (align === 'right' || align === 'justify' || align === 'justify-center' || align === 'justify-right') {
      lx = boxWidth - lineWidth
    }
    const scene = localToScene(obj, lx, ascent + i * lineAdvance)
    const point = inv.point(scene.x, scene.y)
    page.drawText(line, {
      x: point.x,
      y: point.y,
      size: fontSize,
      font,
      color: toPdfRgb(paint),
      opacity,
      rotate: degrees(angle),
    })
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
