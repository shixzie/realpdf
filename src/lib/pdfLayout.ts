import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from 'pdf-lib'
import { pdfSafeText } from './ooxml'

export type PdfFontFamily = 'helvetica' | 'times' | 'courier'

export interface PdfRunStyle {
  family: PdfFontFamily
  size: number
  bold: boolean
  italic: boolean
  color: RGB
  highlight: RGB | null
  underline: boolean
}

export interface PdfRun {
  text: string
  style: PdfRunStyle
}

export interface LayoutSegment {
  text: string
  x: number
  width: number
  style: PdfRunStyle
  font: PDFFont
}

export interface LayoutLine {
  segments: LayoutSegment[]
  width: number
  size: number
  style: PdfRunStyle
  font: PDFFont
}

export function textStyle(patch: Partial<PdfRunStyle> = {}): PdfRunStyle {
  return {
    family: 'helvetica',
    size: 11,
    bold: false,
    italic: false,
    color: rgb(0, 0, 0),
    highlight: null,
    underline: false,
    ...patch,
  }
}

export function standardFamily(name: string | null | undefined): PdfFontFamily {
  const value = (name ?? '').toLowerCase()
  if (/times|cambria|georgia|garamond|palatino|book antiqua|serif/.test(value)) return 'times'
  if (/courier|consolas|monaco|mono/.test(value)) return 'courier'
  return 'helvetica'
}

function standardFont(family: PdfFontFamily, bold: boolean, italic: boolean): StandardFonts {
  if (family === 'times') {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic
    if (bold) return StandardFonts.TimesRomanBold
    if (italic) return StandardFonts.TimesRomanItalic
    return StandardFonts.TimesRoman
  }
  if (family === 'courier') {
    if (bold && italic) return StandardFonts.CourierBoldOblique
    if (bold) return StandardFonts.CourierBold
    if (italic) return StandardFonts.CourierOblique
    return StandardFonts.Courier
  }
  if (bold && italic) return StandardFonts.HelveticaBoldOblique
  if (bold) return StandardFonts.HelveticaBold
  if (italic) return StandardFonts.HelveticaOblique
  return StandardFonts.Helvetica
}

export class FontBook {
  private readonly cache = new Map<string, PDFFont>()

  constructor(private readonly document: PDFDocument) {}

  async get(style: Pick<PdfRunStyle, 'family' | 'bold' | 'italic'>): Promise<PDFFont> {
    const key = `${style.family}-${style.bold ? 'b' : ''}${style.italic ? 'i' : ''}`
    const cached = this.cache.get(key)
    if (cached) return cached
    const font = await this.document.embedFont(standardFont(style.family, style.bold, style.italic))
    this.cache.set(key, font)
    return font
  }

  measure(text: string, font: PDFFont, size: number): number {
    return font.widthOfTextAtSize(pdfSafeText(text), size)
  }
}

interface Token {
  text: string
  style: PdfRunStyle
  font: PDFFont
  width: number
  whitespace: boolean
}

export async function layoutRuns(runs: PdfRun[], maxWidth: number, fonts: FontBook): Promise<LayoutLine[]> {
  const tokens: Token[] = []
  for (const run of runs) {
    const text = pdfSafeText(run.text).replace(/\t/g, '    ')
    if (!text) continue
    const font = await fonts.get(run.style)
    for (const piece of text.split(/(\s+)/)) {
      if (!piece) continue
      tokens.push({
        text: piece,
        style: run.style,
        font,
        width: fonts.measure(piece, font, run.style.size),
        whitespace: /^\s+$/.test(piece),
      })
    }
  }
  if (!tokens.length) return []

  const expanded: Token[] = []
  for (const token of tokens) {
    if (token.whitespace || token.width <= maxWidth || maxWidth <= 0) {
      expanded.push(token)
      continue
    }
    let chunk = ''
    let width = 0
    for (const char of token.text) {
      const charWidth = fonts.measure(char, token.font, token.style.size)
      if (chunk && width + charWidth > maxWidth) {
        expanded.push({ ...token, text: chunk, width })
        chunk = ''
        width = 0
      }
      chunk += char
      width += charWidth
    }
    if (chunk) expanded.push({ ...token, text: chunk, width })
  }

  const lines: LayoutLine[] = []
  let segments: LayoutSegment[] = []
  let lineWidth = 0
  let cursor = 0

  const flush = () => {
    while (segments.length && segments[segments.length - 1].text.trim() === '') {
      const last = segments.pop() as LayoutSegment
      lineWidth -= last.width
    }
    if (!segments.length) {
      segments = []
      lineWidth = 0
      cursor = 0
      return
    }
    lines.push({
      segments,
      width: lineWidth,
      size: segments[0].style.size,
      style: segments[0].style,
      font: segments[0].font,
    })
    segments = []
    lineWidth = 0
    cursor = 0
  }

  for (const token of expanded) {
    if (token.whitespace && lineWidth === 0) {
      cursor += token.width
      continue
    }
    if (!token.whitespace && lineWidth > 0 && lineWidth + token.width > maxWidth) flush()
    segments.push({ text: token.text, x: cursor, width: token.width, style: token.style, font: token.font })
    cursor += token.width
    lineWidth += token.width
  }
  flush()
  return lines
}

/** Spreads the extra width of a line across its whitespace, like justified text. */
export function justifyLine(line: LayoutLine, targetWidth: number): LayoutSegment[] {
  const spaces = line.segments.filter((segment) => segment.text.trim() === '')
  const extra = targetWidth - line.width
  if (extra <= 0 || !spaces.length) return line.segments
  const addition = extra / spaces.length
  let x = 0
  return line.segments.map((segment) => {
    const shifted = { ...segment, x }
    x += segment.width + (segment.text.trim() === '' ? addition : 0)
    return shifted
  })
}

export function drawLayoutLine(
  page: PDFPage,
  line: LayoutLine,
  x: number,
  baselineY: number,
  segments: LayoutSegment[] = line.segments,
): void {
  for (const segment of segments) {
    const drawX = x + segment.x
    if (segment.style.highlight) {
      page.drawRectangle({
        x: drawX - 0.5,
        y: baselineY - segment.style.size * 0.2,
        width: segment.width + 1,
        height: segment.style.size * 1.15,
        color: segment.style.highlight,
      })
    }
    page.drawText(segment.text, {
      x: drawX,
      y: baselineY,
      size: segment.style.size,
      font: segment.font,
      color: segment.style.color,
    })
    if (segment.style.underline) {
      page.drawLine({
        start: { x: drawX, y: baselineY - segment.style.size * 0.14 },
        end: { x: drawX + segment.width, y: baselineY - segment.style.size * 0.14 },
        thickness: Math.max(0.5, segment.style.size * 0.05),
        color: segment.style.color,
      })
    }
  }
}
