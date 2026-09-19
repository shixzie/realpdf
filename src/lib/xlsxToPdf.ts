import { PDFDocument, rgb, type RGB, type PDFPage } from 'pdf-lib'
import {
  NS,
  attributeNS,
  childrenOf,
  descendants,
  excelSerialToDate,
  first,
  formatNumber,
  hexToRgb,
  isDateFormat,
  readRels,
  unitToPt,
} from './ooxml'
import { FontBook, layoutRuns, drawLayoutLine, standardFamily, textStyle, type PdfRunStyle } from './pdfLayout'
import { readZip, zipText, type ZipArchive } from './zipRead'

const PAGE_WIDTH = 841.89
const PAGE_HEIGHT = 595.28
const MARGIN = 36
const TITLE_HEIGHT = 22
const DEFAULT_COLUMN = 48
const DEFAULT_ROW_HEIGHT = 15

interface FontDefinition {
  name: string | null
  size: number
  bold: boolean
  italic: boolean
  color: RGB
}

interface XfDefinition {
  fontIndex: number
  numFmtId: number
  align: 'left' | 'center' | 'right'
}

interface WorkbookStyles {
  fonts: FontDefinition[]
  xfs: XfDefinition[]
  formats: Map<number, string>
}

interface CellData {
  text: string
  style: XfDefinition
  colSpan: number
  rowSpan: number
}

interface MergeRange {
  colSpan: number
  rowSpan: number
}

function parseStyles(entries: ZipArchive): WorkbookStyles {
  const styles: WorkbookStyles = {
    fonts: [{ name: null, size: 11, bold: false, italic: false, color: rgb(0, 0, 0) }],
    xfs: [{ fontIndex: 0, numFmtId: 0, align: 'left' }],
    formats: new Map(),
  }
  const text = zipText(entries, 'xl/styles.xml')
  if (!text) return styles
  const document = new DOMParser().parseFromString(text, 'application/xml')

  const fonts: FontDefinition[] = []
  for (const node of descendants(document, NS.ss, 'font')) {
    if (node.parentNode?.nodeName.endsWith('fonts')) {
      const size = unitToPt(first(node, NS.ss, 'sz')?.getAttribute('val'), 1) ?? 11
      const colorNode = first(node, NS.ss, 'color')
      const color = hexToRgb(colorNode?.getAttribute('rgb') ?? null)
      fonts.push({
        name: first(node, NS.ss, 'name')?.getAttribute('val') ?? null,
        size,
        bold: Boolean(first(node, NS.ss, 'b')),
        italic: Boolean(first(node, NS.ss, 'i')),
        color: color ? rgb(color.r, color.g, color.b) : rgb(0, 0, 0),
      })
    }
  }
  if (fonts.length) styles.fonts = fonts

  for (const node of descendants(document, NS.ss, 'numFmt')) {
    const id = Number(node.getAttribute('numFmtId'))
    const code = node.getAttribute('formatCode')
    if (Number.isFinite(id) && code) styles.formats.set(id, code)
  }

  const xfs: XfDefinition[] = []
  for (const node of descendants(document, NS.ss, 'xf')) {
    if (!node.parentNode?.nodeName.endsWith('cellXfs')) continue
    const alignment = first(node, NS.ss, 'alignment')?.getAttribute('horizontal')
    xfs.push({
      fontIndex: Number(node.getAttribute('fontId') ?? '0') || 0,
      numFmtId: Number(node.getAttribute('numFmtId') ?? '0') || 0,
      align: alignment === 'center' || alignment === 'centerContinuous' ? 'center' : alignment === 'right' ? 'right' : 'left',
    })
  }
  if (xfs.length) styles.xfs = xfs
  return styles
}

function runStyleFor(styles: WorkbookStyles, xf: XfDefinition): PdfRunStyle {
  const font = styles.fonts[xf.fontIndex] ?? styles.fonts[0]
  return textStyle({
    family: standardFamily(font.name),
    size: font.size,
    bold: font.bold,
    italic: font.italic,
    color: font.color,
  })
}

function sharedStringText(node: Element): string {
  let out = ''
  const walk = (parent: Element) => {
    for (const child of Array.from(parent.children)) {
      if (child.namespaceURI !== NS.ss) continue
      if (child.localName === 'rPh') continue
      if (child.localName === 't') out += child.textContent ?? ''
      else walk(child)
    }
  }
  walk(node)
  return out
}

function parseSharedStrings(entries: ZipArchive): string[] {
  const text = zipText(entries, 'xl/sharedStrings.xml')
  if (!text) return []
  const document = new DOMParser().parseFromString(text, 'application/xml')
  return descendants(document, NS.ss, 'si').map(sharedStringText)
}

function columnIndex(reference: string): number {
  const letters = reference.replace(/\d+/g, '').toUpperCase()
  let index = 0
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64)
  return Math.max(0, index - 1)
}

function rowIndex(reference: string): number {
  const digits = /\d+/.exec(reference)
  return digits ? Number(digits[0]) - 1 : 0
}

function splitReference(reference: string): { row: number; column: number } {
  return { row: rowIndex(reference), column: columnIndex(reference) }
}

function cellDisplay(
  type: string | null,
  raw: string,
  style: XfDefinition,
  styles: WorkbookStyles,
  shared: string[],
): string {
  const format = styles.formats.get(style.numFmtId)
  if (type === 's') {
    const value = shared[Number(raw)]
    return value ?? ''
  }
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE'
  if (type === 'str' || type === 'e' || type === 'd') return raw
  if (!raw) return ''
  const number = Number(raw)
  if (!Number.isFinite(number)) return raw
  if (isDateFormat(style.numFmtId, format)) return excelSerialToDate(number)
  if (format) {
    const decimals = /\.(0+)/.exec(format)?.[1].length ?? 0
    const percent = format.includes('%')
    const value = percent ? number * 100 : number
    return `${value.toFixed(decimals)}${percent ? '%' : ''}`
  }
  return formatNumber(number)
}

interface SheetData {
  name: string
  columns: number[]
  rows: Map<number, Map<number, CellData>>
  merges: Map<string, MergeRange>
}

function parseSheet(name: string, path: string, entries: ZipArchive, styles: WorkbookStyles, shared: string[]): SheetData {
  const text = zipText(entries, path)
  if (!text) return { name, columns: [], rows: new Map(), merges: new Map() }
  const document = new DOMParser().parseFromString(text, 'application/xml')

  const columns: number[] = []
  for (const node of descendants(document, NS.ss, 'col')) {
    if (node.parentNode?.nodeName.endsWith('cols') === false) continue
    if (node.getAttribute('hidden') === '1') continue
    const min = Number(node.getAttribute('min') ?? '1')
    const max = Number(node.getAttribute('max') ?? String(min))
    const width = Number(node.getAttribute('width') ?? '')
    const points = Number.isFinite(width) && width > 0 ? (width * 7 + 5) * 0.75 : DEFAULT_COLUMN
    for (let index = min - 1; index < max; index += 1) columns[index] = points
  }

  const rows = new Map<number, Map<number, CellData>>()
  for (const rowNode of descendants(document, NS.ss, 'row')) {
    if (rowNode.parentNode?.nodeName.endsWith('sheetData') === false) continue
    if (rowNode.getAttribute('hidden') === '1') continue
    const rowNumber = Number(rowNode.getAttribute('r') ?? '')
    const index = Number.isFinite(rowNumber) && rowNumber > 0 ? rowNumber - 1 : rows.size
    const cells = new Map<number, CellData>()
    for (const cellNode of childrenOf(rowNode, NS.ss, 'c')) {
      const reference = cellNode.getAttribute('r') ?? ''
      const column = reference ? columnIndex(reference) : cells.size
      const styleIndex = Number(cellNode.getAttribute('s') ?? '0') || 0
      const style = styles.xfs[styleIndex] ?? styles.xfs[0]
      const type = cellNode.getAttribute('t')
      let raw = ''
      if (type === 'inlineStr') {
        raw = sharedStringText(first(cellNode, NS.ss, 'is') ?? cellNode)
      } else {
        raw = first(cellNode, NS.ss, 'v')?.textContent ?? ''
      }
      const value = cellDisplay(type, raw, style, styles, shared)
      if (value === '' && !style) continue
      if (value === '') continue
      cells.set(column, { text: value, style, colSpan: 1, rowSpan: 1 })
    }
    if (cells.size) rows.set(index, cells)
  }

  const merges = new Map<string, MergeRange>()
  for (const node of descendants(document, NS.ss, 'mergeCell')) {
    const reference = node.getAttribute('ref')
    if (!reference || !reference.includes(':')) continue
    const [start, end] = reference.split(':')
    const from = splitReference(start)
    const to = splitReference(end)
    const colSpan = to.column - from.column + 1
    const rowSpan = to.row - from.row + 1
    merges.set(`${from.row}:${from.column}`, { colSpan, rowSpan })
    for (let row = from.row; row <= to.row; row += 1) {
      for (let column = from.column; column <= to.column; column += 1) {
        if (row === from.row && column === from.column) continue
        const cells = rows.get(row)
        if (cells) cells.delete(column)
      }
    }
  }

  return { name, columns, rows, merges }
}

function createPage(pdf: PDFDocument): PDFPage {
  return pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
}

export async function xlsxToPdf(bytes: Uint8Array): Promise<Uint8Array> {
  const entries = readZip(bytes)
  const workbookText = zipText(entries, 'xl/workbook.xml')
  if (!workbookText) throw new Error('The Excel workbook has no readable workbook part')
  const workbook = new DOMParser().parseFromString(workbookText, 'application/xml')
  const rels = readRels(entries, 'xl/workbook.xml')
  const sheetNodes = descendants(workbook, NS.ss, 'sheet')
  if (!sheetNodes.length) throw new Error('The Excel workbook contains no sheets')
  const styles = parseStyles(entries)
  const shared = parseSharedStrings(entries)

  const sheets: SheetData[] = []
  for (const node of sheetNodes) {
    const rid = attributeNS(node, NS.r, 'id')
    const relationship = rid ? rels.get(rid) : null
    const name = node.getAttribute('name') ?? 'Sheet'
    if (!relationship) continue
    sheets.push(parseSheet(name, relationship.target, entries, styles, shared))
  }
  if (!sheets.length) throw new Error('The Excel workbook contains no readable sheets')

  const pdf = await PDFDocument.create()
  const fonts = new FontBook(pdf)

  for (const sheet of sheets) {
    await renderSheet(pdf, fonts, styles, sheet)
  }
  return pdf.save({ useObjectStreams: true })
}

async function renderSheet(
  pdf: PDFDocument,
  fonts: FontBook,
  styles: WorkbookStyles,
  sheet: SheetData,
): Promise<void> {
  const maxColumn = Math.max(-1, ...Array.from(sheet.rows.values()).flatMap((cells) => Array.from(cells.keys())))
  const maxRow = Math.max(-1, ...Array.from(sheet.rows.keys()))
  const titleFont = await fonts.get({ family: 'helvetica', bold: true, italic: false })
  const drawTitle = (page: PDFPage) => {
    page.drawText(sheet.name, {
      x: MARGIN,
      y: PAGE_HEIGHT - MARGIN + 4,
      size: 9,
      font: titleFont,
      color: rgb(0.45, 0.48, 0.55),
    })
  }

  if (maxColumn < 0 || maxRow < 0) {
    drawTitle(createPage(pdf))
    return
  }

  const widths: number[] = []
  for (let column = 0; column <= maxColumn; column += 1) widths[column] = sheet.columns[column] ?? DEFAULT_COLUMN
  const contentWidth = PAGE_WIDTH - MARGIN * 2

  const columnPages: number[][] = []
  let current: number[] = []
  let used = 0
  for (let column = 0; column <= maxColumn; column += 1) {
    if (current.length && used + widths[column] > contentWidth) {
      columnPages.push(current)
      current = []
      used = 0
    }
    current.push(column)
    used += widths[column]
  }
  if (current.length) columnPages.push(current)

  for (const columns of columnPages) {
    let page = createPage(pdf)
    drawTitle(page)
    let y = PAGE_HEIGHT - MARGIN - TITLE_HEIGHT
    let rowIndex = 0
    while (rowIndex <= maxRow) {
      const row = await layoutRow(fonts, styles, sheet, rowIndex, columns, widths)
      if (y - row.height < MARGIN) {
        page = createPage(pdf)
        drawTitle(page)
        y = PAGE_HEIGHT - MARGIN - TITLE_HEIGHT
      }
      const top = y
      y -= row.height
      let x = MARGIN
      for (const entry of row.cells) {
        const cellWidth = widths[entry.column] ?? DEFAULT_COLUMN
        page.drawRectangle({
          x,
          y,
          width: cellWidth * entry.colSpan,
          height: row.height,
          borderColor: rgb(0.78, 0.8, 0.84),
          borderWidth: 0.5,
        })
        const style = runStyleFor(styles, entry.cell.style)
        let lineY = top - 2
        for (const line of entry.lines) {
          const height = style.size * 1.25
          lineY -= height
          const offset = entry.cell.style.align === 'right' ? Math.max(0, cellWidth * entry.colSpan - 4 - line.width) : entry.cell.style.align === 'center' ? Math.max(0, (cellWidth * entry.colSpan - line.width) / 2) : 0
          drawLayoutLine(page, line, x + 3 + offset, lineY + height * 0.25)
        }
        x += cellWidth * entry.colSpan
      }
      rowIndex += row.rowSpan
    }
  }
}

interface LaidOutRow {
  height: number
  rowSpan: number
  cells: Array<{ column: number; colSpan: number; cell: CellData; lines: Awaited<ReturnType<typeof layoutRuns>> }>
}

async function layoutRow(
  fonts: FontBook,
  styles: WorkbookStyles,
  sheet: SheetData,
  rowIndex: number,
  columns: number[],
  widths: number[],
): Promise<LaidOutRow> {
  const row = sheet.rows.get(rowIndex)
  const cells: LaidOutRow['cells'] = []
  let height = DEFAULT_ROW_HEIGHT
  let rowSpan = 1
  if (row) {
    for (const [column, cell] of row) {
      if (!columns.includes(column)) continue
      const merge = sheet.merges.get(`${rowIndex}:${column}`)
      const colSpan = Math.min(merge?.colSpan ?? 1, columns[columns.length - 1] - column + 1)
      rowSpan = Math.max(rowSpan, merge?.rowSpan ?? 1)
      let cellWidth = 0
      for (let index = 0; index < Math.max(1, colSpan); index += 1) cellWidth += widths[column + index] ?? DEFAULT_COLUMN
      const style = runStyleFor(styles, cell.style)
      const lines = await layoutRuns([{ text: cell.text, style }], Math.max(8, cellWidth - 6), fonts)
      const visible: typeof lines = []
      for (const line of lines) {
        if ((visible.length + 1) * style.size * 1.25 + 4 > 150) break
        visible.push(line)
      }
      height = Math.max(height, visible.length * style.size * 1.25 + 4)
      cells.push({ column, colSpan: Math.max(1, colSpan), cell, lines: visible })
    }
    if (rowSpan > 1) {
      height *= rowSpan
    }
  }
  return { height, rowSpan, cells }
}
