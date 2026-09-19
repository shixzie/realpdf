import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import {
  EMU_PER_POINT,
  NS,
  TWIPS_PER_POINT,
  attributeNS,
  childrenOf,
  descendants,
  first,
  hexToRgb,
  readRels,
  relationshipOfType,
  unitToPt,
  type Relationship,
} from './ooxml'
import {
  FontBook,
  drawLayoutLine,
  justifyLine,
  layoutRuns,
  standardFamily,
  textStyle,
  type LayoutLine,
  type PdfRun,
  type PdfRunStyle,
} from './pdfLayout'
import { readZip, zipText, type ZipArchive } from './zipRead'

interface DocxSection {
  width: number
  height: number
  marginTop: number
  marginRight: number
  marginBottom: number
  marginLeft: number
}

const DEFAULT_SECTION: DocxSection = {
  width: 612,
  height: 792,
  marginTop: 72,
  marginRight: 72,
  marginBottom: 72,
  marginLeft: 72,
}

interface RawStyle {
  basedOn: string | null
  family: string | null
  size: number | null
  bold: boolean
  italic: boolean
  underline: boolean
  color: string | null
  headingLevel: number | null
  spaceBefore: number | null
  spaceAfter: number | null
  lineFactor: number | null
  lineHeight: number | null
}

function emptyRawStyle(): RawStyle {
  return {
    basedOn: null,
    family: null,
    size: null,
    bold: false,
    italic: false,
    underline: false,
    color: null,
    headingLevel: null,
    spaceBefore: null,
    spaceAfter: null,
    lineFactor: null,
    lineHeight: null,
  }
}

interface DocxStyles {
  family: string
  size: number
  styles: Map<string, RawStyle>
}

interface Numbering {
  formats: Map<string, string>
}

interface ImageRun {
  data: Uint8Array
  width: number
  height: number
  kind: 'jpg' | 'png'
}

interface Run {
  text: string
  break: boolean
  style: PdfRunStyle
  image?: ImageRun
}

interface ParagraphProps {
  align: 'left' | 'center' | 'right' | 'justify'
  spaceBefore: number
  spaceAfter: number
  indentLeft: number
  indentRight: number
  firstLine: number
  lineFactor: number
  lineHeight: number | null
  numbering: { numId: string; ilvl: number } | null
  style: PdfRunStyle
}

interface TableCell {
  colSpan: number
  shading: string | null
  paragraphs: Array<{ props: ParagraphProps; runs: Run[] }>
}

interface TableRow {
  cells: TableCell[]
  height: number | null
}

type BodyItem =
  | { kind: 'paragraph'; props: ParagraphProps; runs: Run[] }
  | { kind: 'table'; grid: number[]; rows: TableRow[] }

const IMAGE_KINDS: Record<string, ImageRun['kind']> = {
  jpg: 'jpg',
  jpeg: 'jpg',
  png: 'png',
}

function boolProperty(node: Element | null): boolean {
  if (!node) return false
  const value = node.getAttributeNS(NS.w, 'val')
  return value == null || (value !== '0' && value.toLowerCase() !== 'false' && value.toLowerCase() !== 'off')
}

function val(node: Element | null): string | null {
  return node ? node.getAttributeNS(NS.w, 'val') : null
}

function firstChild(parent: Element | null, namespace: string, local: string): Element | null {
  if (!parent) return null
  return childrenOf(parent, namespace, local)[0] ?? null
}

function styleColor(hex: string | null): PdfRunStyle['color'] | null {
  const value = hexToRgb(hex)
  return value ? rgb(value.r, value.g, value.b) : null
}

function applyRunProperties(properties: Element, style: PdfRunStyle): string | null {
  const fonts = firstChild(properties, NS.w, 'rFonts')
  let familyName: string | null = null
  if (fonts) {
    familyName =
      fonts.getAttributeNS(NS.w, 'ascii') ??
      fonts.getAttributeNS(NS.w, 'hAnsi') ??
      fonts.getAttributeNS(NS.w, 'cs') ??
      null
    if (familyName) style.family = standardFamily(familyName)
  }
  const size = unitToPt(val(firstChild(properties, NS.w, 'sz')), 2)
  if (size && size > 0) style.size = size
  const bold = firstChild(properties, NS.w, 'b')
  if (bold) style.bold = boolProperty(bold)
  const italic = firstChild(properties, NS.w, 'i')
  if (italic) style.italic = boolProperty(italic)
  const underline = firstChild(properties, NS.w, 'u')
  if (underline) style.underline = (val(underline) ?? 'single') !== 'none'
  const color = styleColor(val(firstChild(properties, NS.w, 'color')))
  if (color) style.color = color
  const highlight = highlightHex(val(firstChild(properties, NS.w, 'highlight')))
  if (highlight) {
    const mapped = styleColor(highlight)
    if (mapped) style.highlight = mapped
  }
  const shading = styleColor(val(firstChild(firstChild(properties, NS.w, 'shd'), NS.w, 'fill')))
  if (shading) style.highlight = shading
  return familyName
}

function highlightHex(name: string | null): string | null {
  if (!name) return null
  const colors: Record<string, string> = {
    black: '000000',
    blue: '0000FF',
    cyan: '00FFFF',
    green: '00FF00',
    magenta: 'FF00FF',
    red: 'FF0000',
    yellow: 'FFFF00',
    white: 'FFFFFF',
    darkblue: '000080',
    darkcyan: '008080',
    darkgreen: '008000',
    darkmagenta: '800080',
    darkred: '800000',
    darkyellow: '808000',
    darkgray: '808080',
    lightgray: 'C0C0C0',
  }
  return colors[name.toLowerCase()] ?? null
}

function applyLineSpacing(raw: RawStyle, spacing: Element): void {
  const line = Number(spacing.getAttributeNS(NS.w, 'line') ?? '')
  if (!Number.isFinite(line) || line <= 0) return
  const rule = spacing.getAttributeNS(NS.w, 'lineRule') ?? 'auto'
  if (rule === 'exact' || rule === 'atLeast') raw.lineHeight = line / TWIPS_PER_POINT
  else raw.lineFactor = line / 240
}

function parseStyles(entries: ZipArchive): DocxStyles {
  const styles: DocxStyles = { family: 'Calibri', size: 11, styles: new Map() }
  const text = zipText(entries, 'word/styles.xml')
  if (!text) return styles
  const document = new DOMParser().parseFromString(text, 'application/xml')
  const defaultRun = firstChild(firstChild(first(document, NS.w, 'docDefaults'), NS.w, 'rPrDefault'), NS.w, 'rPr')
  if (defaultRun) {
    const fonts = firstChild(defaultRun, NS.w, 'rFonts')
    styles.family =
      fonts?.getAttributeNS(NS.w, 'ascii') ?? fonts?.getAttributeNS(NS.w, 'hAnsi') ?? styles.family
    styles.size = unitToPt(val(firstChild(defaultRun, NS.w, 'sz')), 2) ?? styles.size
  }

  for (const node of descendants(document, NS.w, 'style')) {
    const id = node.getAttributeNS(NS.w, 'styleId')
    if (!id) continue
    const raw = emptyRawStyle()
    raw.basedOn = val(firstChild(node, NS.w, 'basedOn'))
    const name = val(firstChild(node, NS.w, 'name')) ?? ''
    const heading = /^heading\s*([1-9])$/i.exec(name) ?? /^heading([1-9])$/i.exec(id)
    if (heading) raw.headingLevel = Number(heading[1])
    else if (/^title$/i.test(name) || /^title$/i.test(id)) raw.headingLevel = 1

    const pPr = firstChild(node, NS.w, 'pPr')
    if (pPr) {
      const outline = unitToPt(val(firstChild(pPr, NS.w, 'outlineLvl')), 1)
      if (outline != null) raw.headingLevel = outline + 1
      const spacing = firstChild(pPr, NS.w, 'spacing')
      if (spacing) {
        raw.spaceBefore = unitToPt(spacing.getAttributeNS(NS.w, 'before'), TWIPS_PER_POINT)
        raw.spaceAfter = unitToPt(spacing.getAttributeNS(NS.w, 'after'), TWIPS_PER_POINT)
        applyLineSpacing(raw, spacing)
      }
    }
    const rPr = firstChild(node, NS.w, 'rPr')
    if (rPr) {
      const style = textStyle()
      raw.family = applyRunProperties(rPr, style)
      raw.size = unitToPt(val(firstChild(rPr, NS.w, 'sz')), 2)
      raw.bold = style.bold
      raw.italic = style.italic
      raw.underline = style.underline
      raw.color = val(firstChild(rPr, NS.w, 'color'))
    }
    styles.styles.set(id, raw)
  }
  return styles
}

function resolveStyle(id: string | null, styles: DocxStyles, seen = new Set<string>()): RawStyle {
  if (!id || seen.has(id)) return emptyRawStyle()
  const raw = styles.styles.get(id)
  if (!raw) return emptyRawStyle()
  seen.add(id)
  const parent = resolveStyle(raw.basedOn, styles, seen)
  return {
    basedOn: null,
    family: raw.family ?? parent.family,
    size: raw.size ?? parent.size,
    bold: raw.bold || parent.bold,
    italic: raw.italic || parent.italic,
    underline: raw.underline || parent.underline,
    color: raw.color ?? parent.color,
    headingLevel: raw.headingLevel ?? parent.headingLevel,
    spaceBefore: raw.spaceBefore ?? parent.spaceBefore,
    spaceAfter: raw.spaceAfter ?? parent.spaceAfter,
    lineFactor: raw.lineFactor ?? parent.lineFactor,
    lineHeight: raw.lineHeight ?? parent.lineHeight,
  }
}

function headingSize(level: number | null): number | null {
  if (level == null) return null
  const sizes = [0, 16, 13, 12, 11, 11, 11]
  return sizes[Math.min(level, sizes.length - 1)] || 11
}

function parseParagraphProps(paragraph: Element, styles: DocxStyles): ParagraphProps {
  const pPr = firstChild(paragraph, NS.w, 'pPr')
  const raw = resolveStyle(val(firstChild(pPr, NS.w, 'pStyle')), styles)
  const heading = raw.headingLevel
  const baseStyle = textStyle({
    family: standardFamily(raw.family ?? styles.family),
    size: raw.size ?? headingSize(heading) ?? styles.size,
    bold: raw.bold || heading != null,
    italic: raw.italic,
    underline: raw.underline,
    color: styleColor(raw.color) ?? (heading != null ? rgb(0.15, 0.28, 0.51) : rgb(0, 0, 0)),
  })

  const props: ParagraphProps = {
    align: 'left',
    spaceBefore: raw.spaceBefore ?? (heading != null ? 12 : 0),
    spaceAfter: raw.spaceAfter ?? (heading != null ? 6 : 0),
    indentLeft: 0,
    indentRight: 0,
    firstLine: 0,
    lineFactor: raw.lineFactor ?? 1.15,
    lineHeight: raw.lineHeight,
    numbering: null,
    style: baseStyle,
  }

  const alignment = val(firstChild(pPr, NS.w, 'jc'))
  if (alignment === 'center') props.align = 'center'
  else if (alignment === 'right' || alignment === 'end') props.align = 'right'
  else if (alignment === 'both' || alignment === 'distribute') props.align = 'justify'

  const spacing = firstChild(pPr, NS.w, 'spacing')
  if (spacing) {
    const before = unitToPt(spacing.getAttributeNS(NS.w, 'before'), TWIPS_PER_POINT)
    const after = unitToPt(spacing.getAttributeNS(NS.w, 'after'), TWIPS_PER_POINT)
    if (before != null && before >= 0) props.spaceBefore = before
    if (after != null && after >= 0) props.spaceAfter = after
    const lineSpacing = emptyRawStyle()
    applyLineSpacing(lineSpacing, spacing)
    if (lineSpacing.lineFactor != null) props.lineFactor = lineSpacing.lineFactor
    if (lineSpacing.lineHeight != null) props.lineHeight = lineSpacing.lineHeight
  }

  const indent = firstChild(pPr, NS.w, 'ind')
  if (indent) {
    const left = unitToPt(
      indent.getAttributeNS(NS.w, 'left') ?? indent.getAttributeNS(NS.w, 'start'),
      TWIPS_PER_POINT,
    )
    const right = unitToPt(
      indent.getAttributeNS(NS.w, 'right') ?? indent.getAttributeNS(NS.w, 'end'),
      TWIPS_PER_POINT,
    )
    const firstLine = unitToPt(indent.getAttributeNS(NS.w, 'firstLine'), TWIPS_PER_POINT)
    const hanging = unitToPt(indent.getAttributeNS(NS.w, 'hanging'), TWIPS_PER_POINT)
    if (left != null) props.indentLeft = left
    if (right != null) props.indentRight = right
    if (firstLine != null) props.firstLine = firstLine
    if (hanging != null) props.firstLine = -hanging
  }

  const numPr = firstChild(pPr, NS.w, 'numPr')
  const numId = numPr ? val(firstChild(numPr, NS.w, 'numId')) : null
  if (numId) {
    const ilvl = Number(val(firstChild(numPr, NS.w, 'ilvl')) ?? '0')
    props.numbering = { numId, ilvl: Number.isFinite(ilvl) && ilvl >= 0 ? ilvl : 0 }
    if (!indent) props.indentLeft = 18 + props.numbering.ilvl * 18
  }
  return props
}

function parseNumbering(entries: ZipArchive): Numbering {
  const formats = new Map<string, string>()
  const text = zipText(entries, 'word/numbering.xml')
  if (!text) return { formats }
  const document = new DOMParser().parseFromString(text, 'application/xml')
  const abstracts = new Map<string, Map<number, string>>()
  for (const node of descendants(document, NS.w, 'abstractNum')) {
    const id = node.getAttributeNS(NS.w, 'abstractNumId')
    if (!id) continue
    const levels = new Map<number, string>()
    for (const level of childrenOf(node, NS.w, 'lvl')) {
      const ilvl = Number(level.getAttributeNS(NS.w, 'ilvl') ?? '0')
      const format = val(firstChild(level, NS.w, 'numFmt')) ?? 'bullet'
      levels.set(Number.isFinite(ilvl) ? ilvl : 0, format)
    }
    abstracts.set(id, levels)
  }
  for (const node of descendants(document, NS.w, 'num')) {
    const id = node.getAttributeNS(NS.w, 'numId')
    const abstractId = val(firstChild(node, NS.w, 'abstractNumId'))
    if (!id || !abstractId) continue
    const levels = abstracts.get(abstractId)
    if (!levels) continue
    for (const [ilvl, format] of levels) formats.set(`${id}:${ilvl}`, format)
  }
  return { formats }
}

function imageFromDrawing(node: Element, entries: ZipArchive, rels: Map<string, Relationship>): ImageRun | null {
  const blip = first(node, NS.a, 'blip')
  const embed = blip ? attributeNS(blip, NS.r, 'embed') : null
  if (!embed) return null
  const relationship = rels.get(embed)
  if (!relationship) return null
  const data = entries.get(relationship.target)
  if (!data) return null
  const extension = relationship.target.split('.').pop()?.toLowerCase() ?? ''
  const kind = IMAGE_KINDS[extension] ?? null
  if (!kind) return null
  const inline = first(node, NS.wp, 'inline') ?? first(node, NS.wp, 'anchor')
  const extent = inline ? first(inline, NS.wp, 'extent') : null
  const widthEmu = Number(extent?.getAttribute('cx') ?? '')
  const heightEmu = Number(extent?.getAttribute('cy') ?? '')
  const width = Number.isFinite(widthEmu) && widthEmu > 0 ? widthEmu / EMU_PER_POINT : 120
  const height = Number.isFinite(heightEmu) && heightEmu > 0 ? heightEmu / EMU_PER_POINT : 90
  return { data, width, height, kind }
}

function parseRuns(
  node: Element,
  base: PdfRunStyle,
  entries: ZipArchive,
  rels: Map<string, Relationship>,
): Run[] {
  const runs: Run[] = []
  const walk = (parent: Element) => {
    for (const child of Array.from(parent.children)) {
      if (child.namespaceURI !== NS.w) continue
      if (child.localName === 'r') {
        const style = { ...base }
        const rPr = firstChild(child, NS.w, 'rPr')
        if (rPr) applyRunProperties(rPr, style)
        for (const inner of Array.from(child.children)) {
          if (inner.namespaceURI !== NS.w) continue
          switch (inner.localName) {
            case 't':
              if (inner.textContent) runs.push({ text: inner.textContent, break: false, style })
              break
            case 'tab':
              runs.push({ text: '    ', break: false, style })
              break
            case 'br':
            case 'cr':
              runs.push({ text: '', break: true, style })
              break
            case 'noBreakHyphen':
              runs.push({ text: '-', break: false, style })
              break
            case 'sym': {
              const char = inner.getAttributeNS(NS.w, 'char')
              if (char) {
                runs.push({ text: String.fromCharCode(parseInt(char, 16)), break: false, style })
              }
              break
            }
            case 'drawing':
            case 'pict': {
              const image = imageFromDrawing(inner, entries, rels)
              if (image) runs.push({ text: '', break: false, style, image })
              break
            }
            default:
              break
          }
        }
      } else if (
        child.localName === 'hyperlink' ||
        child.localName === 'smartTag' ||
        child.localName === 'ins' ||
        child.localName === 'sdt' ||
        child.localName === 'sdtContent'
      ) {
        walk(child)
      }
    }
  }
  walk(node)
  return runs
}

function parseTable(
  table: Element,
  styles: DocxStyles,
  entries: ZipArchive,
  rels: Map<string, Relationship>,
): BodyItem {
  const grid: number[] = []
  for (const column of childrenOf(firstChild(table, NS.w, 'tblGrid') ?? table, NS.w, 'gridCol')) {
    grid.push(unitToPt(column.getAttributeNS(NS.w, 'w'), TWIPS_PER_POINT) ?? 72)
  }
  const rows: TableRow[] = []
  for (const rowNode of childrenOf(table, NS.w, 'tr')) {
    const cells: TableCell[] = []
    for (const cellNode of childrenOf(rowNode, NS.w, 'tc')) {
      const tcPr = firstChild(cellNode, NS.w, 'tcPr')
      const colSpan = Number(val(firstChild(tcPr, NS.w, 'gridSpan')) ?? '1') || 1
      const shading = val(firstChild(firstChild(tcPr, NS.w, 'shd'), NS.w, 'fill'))
      const paragraphs: TableCell['paragraphs'] = []
      for (const paragraphNode of childrenOf(cellNode, NS.w, 'p')) {
        const props = parseParagraphProps(paragraphNode, styles)
        paragraphs.push({ props, runs: parseRuns(paragraphNode, props.style, entries, rels) })
      }
      cells.push({ colSpan, shading, paragraphs })
    }
    const rowProperties = firstChild(rowNode, NS.w, 'trPr')
    const rowHeight = unitToPt(
      firstChild(rowProperties, NS.w, 'trHeight')?.getAttributeNS(NS.w, 'val'),
      TWIPS_PER_POINT,
    )
    rows.push({ cells, height: rowHeight })
  }
  return { kind: 'table', grid, rows }
}

function parseSection(node: Element | null): DocxSection {
  if (!node) return { ...DEFAULT_SECTION }
  const section = { ...DEFAULT_SECTION }
  const size = firstChild(node, NS.w, 'pgSz')
  if (size) {
    const width = unitToPt(size.getAttributeNS(NS.w, 'w'), TWIPS_PER_POINT)
    const height = unitToPt(size.getAttributeNS(NS.w, 'h'), TWIPS_PER_POINT)
    if (width && width > 0) section.width = width
    if (height && height > 0) section.height = height
  }
  const margin = firstChild(node, NS.w, 'pgMar')
  if (margin) {
    section.marginTop = unitToPt(margin.getAttributeNS(NS.w, 'top'), TWIPS_PER_POINT) ?? section.marginTop
    section.marginRight = unitToPt(margin.getAttributeNS(NS.w, 'right'), TWIPS_PER_POINT) ?? section.marginRight
    section.marginBottom = unitToPt(margin.getAttributeNS(NS.w, 'bottom'), TWIPS_PER_POINT) ?? section.marginBottom
    section.marginLeft = unitToPt(margin.getAttributeNS(NS.w, 'left'), TWIPS_PER_POINT) ?? section.marginLeft
  }
  return section
}

function roman(value: number): string {
  const table: Array<[number, string]> = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ]
  let result = ''
  let remaining = value
  for (const [amount, symbol] of table) {
    while (remaining >= amount) {
      result += symbol
      remaining -= amount
    }
  }
  return result
}

function alignmentOffset(align: ParagraphProps['align'], width: number, available: number): number {
  if (align === 'center') return Math.max(0, (available - width) / 2)
  if (align === 'right') return Math.max(0, available - width)
  return 0
}

class DocxRenderer {
  private page: PDFPage
  private y: number
  private counters = new Map<string, number>()

  constructor(
    private readonly pdf: PDFDocument,
    private readonly fonts: FontBook,
    private readonly section: DocxSection,
    private readonly numbering: Numbering,
  ) {
    this.page = pdf.addPage([section.width, section.height])
    this.y = section.height - section.marginTop
  }

  private get contentWidth(): number {
    return this.section.width - this.section.marginLeft - this.section.marginRight
  }

  private newPage(): void {
    this.page = this.pdf.addPage([this.section.width, this.section.height])
    this.y = this.section.height - this.section.marginTop
  }

  private ensure(height: number): void {
    if (this.y - height < this.section.marginBottom) this.newPage()
  }

  private lineHeight(style: PdfRunStyle, props: ParagraphProps): number {
    return props.lineHeight ?? style.size * 1.2 * props.lineFactor
  }

  private bulletPrefix(numbering: { numId: string; ilvl: number }): string {
    const format = this.numbering.formats.get(`${numbering.numId}:${numbering.ilvl}`) ?? 'bullet'
    if (format === 'bullet') return '•  '
    const key = `${numbering.numId}:${numbering.ilvl}`
    const next = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, next)
    if (format === 'lowerLetter') return `${String.fromCharCode(96 + ((next - 1) % 26) + 1)}.  `
    if (format === 'upperLetter') return `${String.fromCharCode(64 + ((next - 1) % 26) + 1)}.  `
    if (format === 'lowerRoman') return `${roman(next).toLowerCase()}.  `
    if (format === 'upperRoman') return `${roman(next)}.  `
    return `${next}.  `
  }

  async paragraph(props: ParagraphProps, runs: Run[]): Promise<void> {
    const indent = Math.max(0, props.indentLeft)
    const width = Math.max(24, this.contentWidth - props.indentRight - indent)
    if (props.spaceBefore > 0) {
      this.ensure(props.spaceBefore)
      this.y -= props.spaceBefore
    }

    const groups = splitAtBreaks(runs)
    let first = true
    for (const group of groups) {
      if (!group.length) {
        const height = this.lineHeight(props.style, props)
        this.ensure(height)
        this.y -= height
        first = false
        continue
      }
      const prefix = first && props.numbering ? this.bulletPrefix(props.numbering) : ''
      const textRuns: PdfRun[] = prefix ? [{ text: prefix, style: props.style }] : []
      for (const run of group) {
        if (run.image) {
          if (textRuns.length > 1) {
            await this.drawFlow(textRuns, props, width, indent, 0)
            textRuns.length = 0
          }
          await this.drawImage(run.image)
          continue
        }
        textRuns.push({ text: run.text, style: run.style })
      }
      const firstLineIndent = first && props.firstLine > 0 ? Math.min(props.firstLine, width - 24) : 0
      if (textRuns.length) await this.drawFlow(textRuns, props, width, indent, firstLineIndent)
      first = false
    }

    if (props.spaceAfter > 0) {
      this.ensure(props.spaceAfter)
      this.y -= props.spaceAfter
    }
  }

  private async drawFlow(
    runs: PdfRun[],
    props: ParagraphProps,
    width: number,
    indent: number,
    firstLineIndent: number,
  ): Promise<void> {
    const lines = await layoutRuns(runs, width, this.fonts)
    let first = true
    for (const line of lines) {
      const height = this.lineHeight(line.style, props)
      this.ensure(height)
      const available = width - (first ? firstLineIndent : 0)
      const segments = props.align === 'justify' ? justifyLine(line, available) : line.segments
      const offset = alignmentOffset(props.align, line.width, available)
      this.y -= height
      drawLayoutLine(
        this.page,
        line,
        this.section.marginLeft + indent + (first ? firstLineIndent : 0) + offset,
        this.y + height * 0.22,
        segments,
      )
      first = false
    }
  }

  private async drawImage(image: ImageRun): Promise<void> {
    if (image.kind !== 'png' && image.kind !== 'jpg') return
    let width = image.width
    let height = image.height
    const maxWidth = this.contentWidth
    const maxHeight = this.section.height - this.section.marginTop - this.section.marginBottom
    const scale = Math.min(1, maxWidth / width, maxHeight / height)
    width *= scale
    height *= scale
    this.ensure(height + 6)
    const embedded =
      image.kind === 'png' ? await this.pdf.embedPng(image.data) : await this.pdf.embedJpg(image.data)
    this.page.drawImage(embedded, {
      x: this.section.marginLeft,
      y: this.y - height,
      width,
      height,
    })
    this.y -= height + 6
  }

  async table(item: Extract<BodyItem, { kind: 'table' }>): Promise<void> {
    const contentWidth = this.contentWidth
    const columnCount = Math.max(item.grid.length, ...item.rows.map((row) => row.cells.length), 1)
    let widths = item.grid.length ? [...item.grid] : new Array(columnCount).fill(contentWidth / columnCount)
    const total = widths.reduce((sum, value) => sum + value, 0)
    if (total > contentWidth) {
      const scale = contentWidth / total
      widths = widths.map((value) => value * scale)
    }
    const padding = 4
    for (const row of item.rows) {
      const cells: Array<{ cell: TableCell; width: number; lines: LayoutLine[]; height: number }> = []
      let column = 0
      for (const cell of row.cells) {
        const span = Math.max(1, cell.colSpan)
        let cellWidth = 0
        for (let index = 0; index < span; index += 1) cellWidth += widths[column + index] ?? 0
        column += span
        const available = Math.max(12, cellWidth - padding * 2)
        const lines: LayoutLine[] = []
        for (const paragraph of cell.paragraphs) {
          const content = paragraph.runs
            .filter((run) => run.text)
            .map((run) => ({ text: run.text, style: run.style }))
          if (!content.length) {
            const font: PDFFont = await this.fonts.get(paragraph.props.style)
            lines.push({
              segments: [],
              width: 0,
              size: paragraph.props.style.size,
              style: paragraph.props.style,
              font,
            })
            continue
          }
          lines.push(...(await layoutRuns(content, available, this.fonts)))
        }
        const height = lines.reduce((sum, line) => sum + line.size * 1.3, 0) + padding * 2
        cells.push({ cell, width: cellWidth, lines, height })
      }
      const rowHeight = Math.max(row.height ?? 0, ...cells.map((entry) => entry.height), 18)
      this.ensure(rowHeight)
      const top = this.y
      this.y -= rowHeight
      let x = this.section.marginLeft
      for (const entry of cells) {
        const fill = hexToRgb(entry.cell.shading)
        if (fill) {
          this.page.drawRectangle({
            x,
            y: this.y,
            width: entry.width,
            height: rowHeight,
            color: rgb(fill.r, fill.g, fill.b),
          })
        }
        this.page.drawRectangle({
          x,
          y: this.y,
          width: entry.width,
          height: rowHeight,
          borderColor: rgb(0.62, 0.65, 0.7),
          borderWidth: 0.6,
        })
        let lineTop = top
        for (const line of entry.lines) {
          const height = line.size * 1.3
          lineTop -= height
          drawLayoutLine(this.page, line, x + padding, lineTop + height * 0.25)
        }
        x += entry.width
      }
    }
    this.ensure(6)
    this.y -= 6
  }
}

function splitAtBreaks(runs: Run[]): Run[][] {
  const groups: Run[][] = [[]]
  for (const run of runs) {
    if (run.break) groups.push([])
    else groups[groups.length - 1].push(run)
  }
  return groups
}

export async function docxToPdf(bytes: Uint8Array): Promise<Uint8Array> {
  const entries = readZip(bytes)
  const rootRels = readRels(entries, '')
  const main = relationshipOfType(rootRels, '/officeDocument')?.target ?? 'word/document.xml'
  const text = zipText(entries, main)
  if (!text) throw new Error('The Word document has no readable document part')
  const document = new DOMParser().parseFromString(text, 'application/xml')
  const body = first(document, NS.w, 'body')
  if (!body) throw new Error('The Word document has no body')
  const rels = readRels(entries, main)
  const styles = parseStyles(entries)
  const numbering = parseNumbering(entries)
  const section = parseSection(firstChild(body, NS.w, 'sectPr'))

  const items: BodyItem[] = []
  for (const child of Array.from(body.children)) {
    if (child.namespaceURI !== NS.w) continue
    if (child.localName === 'p') {
      const props = parseParagraphProps(child, styles)
      items.push({ kind: 'paragraph', props, runs: parseRuns(child, props.style, entries, rels) })
    } else if (child.localName === 'tbl') {
      items.push(parseTable(child, styles, entries, rels))
    }
  }

  const pdf = await PDFDocument.create()
  const fonts = new FontBook(pdf)
  const renderer = new DocxRenderer(pdf, fonts, section, numbering)
  for (const item of items) {
    if (item.kind === 'paragraph') await renderer.paragraph(item.props, item.runs)
    else await renderer.table(item)
  }
  return pdf.save({ useObjectStreams: true })
}
