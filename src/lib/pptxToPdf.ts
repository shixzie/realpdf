import { PDFDocument, rgb, type PDFPage, type RGB } from 'pdf-lib'
import {
  EMU_PER_POINT,
  NS,
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
  layoutRuns,
  standardFamily,
  textStyle,
  type LayoutLine,
  type PdfRunStyle,
} from './pdfLayout'
import { readZip, zipText, type ZipArchive } from './zipRead'

const DEFAULT_WIDTH = 960
const DEFAULT_HEIGHT = 540

interface PlaceholderInfo {
  x: number
  y: number
  width: number
  height: number
  size: number | null
}

interface MasterStyles {
  title: number | null
  body: number | null
  other: number | null
  placeholders: Map<string, PlaceholderInfo>
}

interface TextDefaults {
  size: number
  bold: boolean
  italic: boolean
  color: RGB
  family: string | null
  align: 'left' | 'center' | 'right' | 'justify'
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface ShapeContext {
  pdf: PDFDocument
  fonts: FontBook
  entries: ZipArchive
  rels: Map<string, Relationship>
  page: PDFPage
  slideHeight: number
  master: MasterStyles
  offsetX: number
  offsetY: number
  scaleX: number
  scaleY: number
  shiftX: number
  shiftY: number
}

const SCHEME_COLORS: Record<string, string> = {
  tx1: '000000',
  dk1: '000000',
  tx2: '44546A',
  dk2: '44546A',
  lt1: 'FFFFFF',
  lt2: 'E7E6E6',
  accent1: '4472C4',
  accent2: 'ED7D31',
  accent3: 'A5A5A5',
  accent4: 'FFC000',
  accent5: '5B9BD5',
  accent6: '70AD47',
}

function emu(value: string | null | undefined): number | null {
  return unitToPt(value, EMU_PER_POINT)
}

function pointValue(value: string | null | undefined): number | null {
  return unitToPt(value, 100)
}

function placeholderKey(type: string | null, idx: string | null): string {
  return `${type ?? ''}:${idx ?? ''}`
}

function solidFillColor(node: Element | null): RGB | null {
  if (!node) return null
  const srgb = first(node, NS.a, 'srgbClr')
  const direct = hexToRgb(srgb?.getAttribute('val'))
  if (direct) return rgb(direct.r, direct.g, direct.b)
  const scheme = first(node, NS.a, 'schemeClr') ?? first(node, NS.a, 'prstClr')
  const name = scheme?.getAttribute('val') ?? null
  const mapped = name ? hexToRgb(SCHEME_COLORS[name] ?? null) : null
  return mapped ? rgb(mapped.r, mapped.g, mapped.b) : null
}

function runStyleFromDefaults(defaults: TextDefaults): PdfRunStyle {
  return textStyle({
    family: standardFamily(defaults.family),
    size: defaults.size,
    bold: defaults.bold,
    italic: defaults.italic,
    color: defaults.color,
  })
}

function applyRunProperties(node: Element | null, base: PdfRunStyle): PdfRunStyle {
  const style: PdfRunStyle = { ...base }
  if (!node) return style
  const size = pointValue(node.getAttribute('sz'))
  if (size && size > 0) style.size = size
  const bold = node.getAttribute('b')
  if (bold != null) style.bold = bold === '1' || bold === 'true'
  const italic = node.getAttribute('i')
  if (italic != null) style.italic = italic === '1' || italic === 'true'
  const underline = node.getAttribute('u')
  if (underline != null) style.underline = underline !== 'none'
  const color = solidFillColor(first(node, NS.a, 'solidFill'))
  if (color) style.color = color
  const latin = first(node, NS.a, 'latin')
  if (latin?.getAttribute('typeface')) style.family = standardFamily(latin.getAttribute('typeface'))
  return style
}

function defaultTextDefaults(type: string): TextDefaults {
  if (type === 'title' || type === 'ctrTitle') {
    return { size: 44, bold: false, italic: false, color: rgb(0.12, 0.12, 0.12), family: null, align: 'left' }
  }
  if (type === 'subTitle') {
    return { size: 20, bold: false, italic: false, color: rgb(0.25, 0.25, 0.25), family: null, align: 'left' }
  }
  return { size: 18, bold: false, italic: false, color: rgb(0.15, 0.15, 0.15), family: null, align: 'left' }
}

function masterStyleSize(style: Element | null): number | null {
  if (!style) return null
  return pointValue(first(first(style, NS.a, 'lvl1pPr'), NS.a, 'defRPr')?.getAttribute('sz'))
}

function placeholderMap(xml: string | undefined): Map<string, PlaceholderInfo> {
  const map = new Map<string, PlaceholderInfo>()
  if (!xml) return map
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  for (const shape of descendants(document, NS.p, 'sp')) {
    const placeholder = first(shape, NS.p, 'ph')
    if (!placeholder) continue
    const transform = first(shape, NS.a, 'xfrm')
    const offset = transform ? first(transform, NS.a, 'off') : null
    const extent = transform ? first(transform, NS.a, 'ext') : null
    if (!offset || !extent) continue
    const size = masterStyleSize(first(shape, NS.p, 'txBody') ?? shape)
    map.set(placeholderKey(placeholder.getAttribute('type'), placeholder.getAttribute('idx')), {
      x: emu(offset.getAttribute('x')) ?? 0,
      y: emu(offset.getAttribute('y')) ?? 0,
      width: emu(extent.getAttribute('cx')) ?? 0,
      height: emu(extent.getAttribute('cy')) ?? 0,
      size,
    })
  }
  return map
}

function resolvePlaceholder(
  map: Map<string, PlaceholderInfo>,
  type: string | null,
  idx: string | null,
): PlaceholderInfo | null {
  return (
    map.get(placeholderKey(type, idx)) ??
    map.get(placeholderKey(type, null)) ??
    map.get(placeholderKey(null, idx)) ??
    null
  )
}

function parseMaster(masterText: string | undefined, layoutText: string | undefined): MasterStyles {
  const master: MasterStyles = { title: null, body: null, other: null, placeholders: new Map() }
  if (masterText) {
    const document = new DOMParser().parseFromString(masterText, 'application/xml')
    const styles = first(document, NS.p, 'txStyles')
    master.title = masterStyleSize(first(styles, NS.p, 'titleStyle'))
    master.body = masterStyleSize(first(styles, NS.p, 'bodyStyle'))
    master.other = masterStyleSize(first(styles, NS.p, 'otherStyle'))
    for (const [key, value] of placeholderMap(masterText)) master.placeholders.set(key, value)
  }
  if (layoutText) {
    for (const [key, value] of placeholderMap(layoutText)) master.placeholders.set(key, value)
  }
  return master
}

function shapeTransform(node: Element): Box | null {
  const transform = first(node, NS.p, 'xfrm') ?? first(node, NS.a, 'xfrm')
  if (!transform) return null
  const offset = first(transform, NS.a, 'off')
  const extent = first(transform, NS.a, 'ext')
  if (!offset || !extent) return null
  return {
    x: emu(offset.getAttribute('x')) ?? 0,
    y: emu(offset.getAttribute('y')) ?? 0,
    width: emu(extent.getAttribute('cx')) ?? 0,
    height: emu(extent.getAttribute('cy')) ?? 0,
  }
}

function transformed(context: ShapeContext, box: Box): Box {
  const x = context.offsetX + (box.x - context.shiftX) / context.scaleX
  const y = context.offsetY + (box.y - context.shiftY) / context.scaleY
  return {
    x,
    y,
    width: box.width / context.scaleX,
    height: box.height / context.scaleY,
  }
}

function defaultsForPlaceholder(type: string | null, info: PlaceholderInfo | null, master: MasterStyles): TextDefaults {
  const key = type ?? ''
  const defaults = defaultTextDefaults(key)
  if (key === 'title' || key === 'ctrTitle') defaults.size = master.title ?? defaults.size
  else if (key === 'body' || key === 'subTitle' || key === 'obj') defaults.size = master.body ?? defaults.size
  else defaults.size = master.other ?? defaults.size
  if (info?.size) defaults.size = info.size
  return defaults
}

async function renderTextBody(
  context: ShapeContext,
  body: Element,
  box: Box,
  defaults: TextDefaults,
): Promise<void> {
  const bodyProperties = first(body, NS.a, 'bodyPr')
  const leftInset = emu(bodyProperties?.getAttribute('lIns')) ?? 7.2
  const rightInset = emu(bodyProperties?.getAttribute('rIns')) ?? 7.2
  const topInset = emu(bodyProperties?.getAttribute('tIns')) ?? 3.6
  const bottomInset = emu(bodyProperties?.getAttribute('bIns')) ?? 3.6
  const anchor = bodyProperties?.getAttribute('anchor') ?? 't'
  const available = Math.max(12, box.width - leftInset - rightInset)

  interface Paragraph {
    lines: LayoutLine[]
    align: TextDefaults['align']
    spaceBefore: number
    spaceAfter: number
    lineHeight: number
  }
  const paragraphs: Paragraph[] = []
  let totalHeight = 0

  for (const paragraph of childrenOf(body, NS.a, 'p')) {
    const properties = first(paragraph, NS.a, 'pPr')
    const alignValue = properties?.getAttribute('algn')
    const align: TextDefaults['align'] =
      alignValue === 'ctr' ? 'center' : alignValue === 'r' ? 'right' : alignValue === 'just' ? 'justify' : defaults.align
    const level = Math.max(0, Number(properties?.getAttribute('lvl') ?? '0') || 0)
    const base = applyRunProperties(first(properties, NS.a, 'defRPr'), runStyleFromDefaults(defaults))
    const runs: Array<{ text: string; style: PdfRunStyle }> = []
    for (const child of childrenOf(paragraph, NS.a, 'r')) {
      const style = applyRunProperties(first(child, NS.a, 'rPr'), base)
      for (const textNode of childrenOf(child, NS.a, 't')) runs.push({ text: textNode.textContent ?? '', style })
    }
    for (const child of childrenOf(paragraph, NS.a, 'fld')) {
      const style = applyRunProperties(first(child, NS.a, 'rPr'), base)
      for (const textNode of childrenOf(child, NS.a, 't')) runs.push({ text: textNode.textContent ?? '', style })
    }
    const bulletCharacter = first(properties, NS.a, 'buChar')?.getAttribute('char')
    const autoNumber = first(properties, NS.a, 'buAutoNum')
    if (bulletCharacter || autoNumber) {
      runs.unshift({ text: `${bulletCharacter ?? '•'}  `, style: base })
    }
    const marginLeft = emu(properties?.getAttribute('marL')) ?? 0
    const indent = level * 18 + marginLeft
    const lines = runs.length ? await layoutRuns(runs, Math.max(12, available - indent), context.fonts) : []
    const lineHeight = (lines[0]?.style.size ?? base.size) * 1.2
    const paragraphHeight = Math.max(lineHeight, lines.length * lineHeight)
    const spaceBefore = pointValue(first(first(properties, NS.a, 'spcBef'), NS.a, 'spcPts')?.getAttribute('val')) ?? 0
    const spaceAfter = pointValue(first(first(properties, NS.a, 'spcAft'), NS.a, 'spcPts')?.getAttribute('val')) ?? 0
    paragraphs.push({ lines, align, spaceBefore, spaceAfter, lineHeight })
    totalHeight += spaceBefore + paragraphHeight + spaceAfter
  }

  if (!paragraphs.length || totalHeight <= 0) return

  const top = box.y + box.height
  let cursor =
    anchor === 'ctr'
      ? (top + box.y) / 2 + totalHeight / 2
      : anchor === 'b'
        ? box.y + bottomInset + totalHeight
        : top - topInset

  for (const paragraph of paragraphs) {
    cursor -= paragraph.spaceBefore
    for (const line of paragraph.lines) {
      cursor -= paragraph.lineHeight
      const offset =
        paragraph.align === 'center'
          ? Math.max(0, (available - line.width) / 2)
          : paragraph.align === 'right'
            ? Math.max(0, available - line.width)
            : 0
      drawLayoutLine(context.page, line, box.x + leftInset + offset, cursor + paragraph.lineHeight * 0.2)
    }
    cursor -= paragraph.spaceAfter
  }
}

async function renderPicture(context: ShapeContext, node: Element, box: Box): Promise<void> {
  const blip = first(node, NS.a, 'blip')
  const embed = blip ? attributeNS(blip, NS.r, 'embed') : null
  if (!embed) return
  const relationship = context.rels.get(embed)
  if (!relationship) return
  const data = context.entries.get(relationship.target)
  if (!data) return
  const options = { x: box.x, y: box.y, width: box.width, height: box.height }
  if (data[0] === 0xff && data[1] === 0xd8) {
    context.page.drawImage(await context.pdf.embedJpg(data), options)
  } else if (data[0] === 0x89 && data[1] === 0x50) {
    context.page.drawImage(await context.pdf.embedPng(data), options)
  }
}

async function renderTable(context: ShapeContext, frame: Element, box: Box): Promise<void> {
  const table = first(frame, NS.a, 'tbl')
  if (!table) return
  const grid: number[] = []
  for (const column of childrenOf(first(table, NS.a, 'tblGrid') ?? table, NS.a, 'gridCol')) {
    grid.push(emu(column.getAttribute('w')) ?? box.width)
  }
  const rows = childrenOf(table, NS.a, 'tr')
  if (!rows.length) return
  const heights = rows.map((row) => emu(row.getAttribute('h')) ?? 24)
  const totalHeight = heights.reduce((sum, value) => sum + value, 0) || box.height
  const scale = totalHeight > box.height ? box.height / totalHeight : 1
  let y = box.y + box.height

  for (const [rowIndex, row] of rows.entries()) {
    const rowHeight = heights[rowIndex] * scale
    y -= rowHeight
    let column = 0
    let x = box.x
    for (const cell of childrenOf(row, NS.a, 'tc')) {
      const gridSpan = Math.max(1, Number(cell.getAttribute('gridSpan') ?? '1') || 1)
      const rowSpan = Math.max(1, Number(cell.getAttribute('rowSpan') ?? '1') || 1)
      let cellWidth = 0
      for (let index = 0; index < gridSpan; index += 1) cellWidth += grid[column + index] ?? 0
      if (cellWidth <= 0) cellWidth = box.width / Math.max(1, childrenOf(row, NS.a, 'tc').length)
      const cellHeight = heights.slice(rowIndex, rowIndex + rowSpan).reduce((sum, value) => sum + value, 0) * scale
      const cellBottom = y + rowHeight - cellHeight
      const fill = solidFillColor(first(first(cell, NS.a, 'tcPr'), NS.a, 'solidFill'))
      context.page.drawRectangle({
        x,
        y: cellBottom,
        width: cellWidth,
        height: cellHeight,
        borderColor: rgb(0.5, 0.52, 0.56),
        borderWidth: 0.6,
        ...(fill ? { color: fill } : {}),
      })
      const body = first(cell, NS.a, 'txBody')
      if (body) {
        await renderTextBody(
          context,
          body,
          { x, y: cellBottom, width: cellWidth, height: cellHeight },
          { ...defaultTextDefaults('body'), size: 12 },
        )
      }
      x += cellWidth
      column += gridSpan
    }
  }
}

async function renderGroup(context: ShapeContext, group: Element): Promise<void> {
  const transform = first(group, NS.p, 'xfrm') ?? first(group, NS.a, 'xfrm')
  const offset = transform ? first(transform, NS.a, 'off') : null
  const extent = transform ? first(transform, NS.a, 'ext') : null
  const childOffset = transform ? first(transform, NS.a, 'chOff') : null
  const childExtent = transform ? first(transform, NS.a, 'chExt') : null
  const childContext: ShapeContext = { ...context }
  if (offset && extent && childOffset && childExtent) {
    const childWidth = emu(childExtent.getAttribute('cx')) ?? 0
    const childHeight = emu(childExtent.getAttribute('cy')) ?? 0
    const width = emu(extent.getAttribute('cx')) ?? childWidth
    const height = emu(extent.getAttribute('cy')) ?? childHeight
    childContext.offsetX = emu(offset.getAttribute('x')) ?? 0
    childContext.offsetY = emu(offset.getAttribute('y')) ?? 0
    childContext.shiftX = emu(childOffset.getAttribute('x')) ?? 0
    childContext.shiftY = emu(childOffset.getAttribute('y')) ?? 0
    childContext.scaleX = childWidth > 0 ? width / childWidth : 1
    childContext.scaleY = childHeight > 0 ? height / childHeight : 1
  }
  await renderShapeTree(childContext, group)
}

async function renderShape(context: ShapeContext, node: Element): Promise<void> {
  const placeholder = first(node, NS.p, 'ph')
  let box = shapeTransform(node)
  if (!box && placeholder) {
    const info = resolvePlaceholder(
      context.master.placeholders,
      placeholder.getAttribute('type'),
      placeholder.getAttribute('idx'),
    )
    if (info) box = { x: info.x, y: info.y, width: info.width, height: info.height }
  }
  if (box) {
    box = transformed(context, box)
    box = { ...box, y: context.slideHeight - box.y - box.height }
  }

  if (node.localName === 'pic') {
    if (box) await renderPicture(context, node, box)
    return
  }
  if (node.localName === 'graphicFrame') {
    if (box) await renderTable(context, node, box)
    return
  }

  const type = placeholder?.getAttribute('type') ?? null
  const info = resolvePlaceholder(context.master.placeholders, type, placeholder?.getAttribute('idx') ?? null)
  const defaults = defaultsForPlaceholder(type, info, context.master)
  const body = first(node, NS.p, 'txBody')
  if (body && box && box.width > 0 && box.height > 0) {
    await renderTextBody(context, body, box, defaults)
  }
}

async function renderShapeTree(context: ShapeContext, parent: Element): Promise<void> {
  for (const node of Array.from(parent.children)) {
    if (node.namespaceURI !== NS.p) continue
    if (node.localName === 'grpSp') {
      await renderGroup(context, node)
    } else if (
      node.localName === 'sp' ||
      node.localName === 'pic' ||
      node.localName === 'graphicFrame' ||
      node.localName === 'cxnSp'
    ) {
      await renderShape(context, node)
    }
  }
}

export async function pptxToPdf(bytes: Uint8Array): Promise<Uint8Array> {
  const entries = readZip(bytes)
  const presentationText = zipText(entries, 'ppt/presentation.xml')
  if (!presentationText) throw new Error('The PowerPoint file has no readable presentation part')
  const presentation = new DOMParser().parseFromString(presentationText, 'application/xml')
  const rels = readRels(entries, 'ppt/presentation.xml')

  const sizeNode = first(presentation, NS.p, 'sldSz')
  const width = emu(sizeNode?.getAttribute('cx')) || DEFAULT_WIDTH
  const height = emu(sizeNode?.getAttribute('cy')) || DEFAULT_HEIGHT

  const slideIds: string[] = []
  for (const node of descendants(first(presentation, NS.p, 'sldIdLst') ?? presentation, NS.p, 'sldId')) {
    const rid = attributeNS(node, NS.r, 'id')
    if (rid) slideIds.push(rid)
  }

  const pdf = await PDFDocument.create()
  const fonts = new FontBook(pdf)

  for (const rid of slideIds) {
    const relationship = rels.get(rid)
    if (!relationship) continue
    const slideText = zipText(entries, relationship.target)
    if (!slideText) continue
    const slide = new DOMParser().parseFromString(slideText, 'application/xml')
    const slideRels = readRels(entries, relationship.target)
    const layoutRelationship = relationshipOfType(slideRels, '/slideLayout')
    const layoutText = layoutRelationship ? zipText(entries, layoutRelationship.target) : undefined
    const layoutRels = layoutRelationship
      ? readRels(entries, layoutRelationship.target)
      : new Map<string, Relationship>()
    const masterRelationship = relationshipOfType(layoutRels, '/slideMaster')
    const masterText = masterRelationship ? zipText(entries, masterRelationship.target) : undefined
    const master = parseMaster(masterText, layoutText)

    const page = pdf.addPage([width, height])
    const background = solidFillColor(first(first(slide, NS.p, 'bg'), NS.p, 'bgPr'))
    if (background) page.drawRectangle({ x: 0, y: 0, width, height, color: background })

    const tree = first(slide, NS.p, 'spTree')
    if (!tree) continue
    await renderShapeTree(
      {
        pdf,
        fonts,
        entries,
        rels: slideRels,
        page,
        slideHeight: height,
        master,
        offsetX: 0,
        offsetY: 0,
        scaleX: 1,
        scaleY: 1,
        shiftX: 0,
        shiftY: 0,
      },
      tree,
    )
  }

  return pdf.save({ useObjectStreams: true })
}
