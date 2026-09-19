import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { EMU_PER_POINT, TWIPS_PER_POINT, xmlAttribute, xmlEscape } from './ooxml'
import { createZip, type ZipEntry } from './zip'

export interface PdfTextSpan {
  text: string
  x: number
  width: number
  size: number
  bold: boolean
  italic: boolean
  fontName: string | null
}

export interface PdfTextLine {
  spans: PdfTextSpan[]
  text: string
  x: number
  y: number
  width: number
  size: number
  bold: boolean
  italic: boolean
  fontName: string | null
}

export interface PdfPageText {
  width: number
  height: number
  lines: PdfTextLine[]
}

interface RawItem {
  str: string
  transform: number[]
  width: number
  fontName: string
}

function fontSize(transform: number[]): number {
  return Math.hypot(transform[2], transform[3]) || Math.hypot(transform[0], transform[1]) || 10
}

interface ViewportMapper {
  x: (x: number, y: number) => number
  y: (x: number, y: number) => number
  scale: number
}

function viewportMapper(transform: number[]): ViewportMapper {
  return {
    x: (x, y) => transform[0] * x + transform[2] * y + transform[4],
    y: (x, y) => transform[1] * x + transform[3] * y + transform[5],
    scale: Math.hypot(transform[0], transform[1]) || 1,
  }
}

function fontInfo(page: PDFPageProxy, fontName: string): { name: string | null; bold: boolean; italic: boolean } {
  let name: string | null = null
  try {
    const font = page.commonObjs.get(fontName) as { name?: string; loadedName?: string } | undefined | null
    name = font?.name ?? null
  } catch {
    name = null
  }
  const probe = (name ?? fontName).toLowerCase()
  return {
    name,
    bold: /bold|black|heavy|semibold|demi/.test(probe),
    italic: /italic|oblique/.test(probe),
  }
}

function mergeSpans(spans: PdfTextSpan[]): PdfTextSpan[] {
  const sorted = [...spans].sort((a, b) => a.x - b.x)
  const merged: PdfTextSpan[] = []
  for (const span of sorted) {
    const previous = merged[merged.length - 1]
    const gap = previous ? span.x - (previous.x + previous.width) : Infinity
    if (
      previous &&
      previous.bold === span.bold &&
      previous.italic === span.italic &&
      Math.abs(previous.size - span.size) < 0.6 &&
      gap < 1.6
    ) {
      const separator = !previous.text.endsWith(' ') && !span.text.startsWith(' ') && gap > span.size * 0.18 ? ' ' : ''
      previous.text += separator + span.text
      previous.width = span.x + span.width - previous.x
      continue
    }
    merged.push({ ...span })
  }
  return merged
}

/** Reads positioned text lines from every page, for Office export. */
export async function extractPdfText(pdf: PDFDocumentProxy): Promise<PdfPageText[]> {
  const pages: PdfPageText[] = []
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent({ includeMarkedContent: false })
    const items: RawItem[] = []
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue
      items.push({
        str: item.str,
        transform: item.transform as number[],
        width: item.width ?? 0,
        fontName: item.fontName,
      })
    }

    const mapper = viewportMapper(viewport.transform)
    items.sort(
      (a, b) =>
        mapper.y(a.transform[4], a.transform[5]) - mapper.y(b.transform[4], b.transform[5]) ||
        mapper.x(a.transform[4], a.transform[5]) - mapper.x(b.transform[4], b.transform[5]),
    )

    interface DraftLine {
      baseline: number
      spans: PdfTextSpan[]
    }
    const drafts: DraftLine[] = []
    for (const item of items) {
      const size = fontSize(item.transform) * mapper.scale
      const x = mapper.x(item.transform[4], item.transform[5])
      const y = mapper.y(item.transform[4], item.transform[5])
      const info = fontInfo(page, item.fontName)
      const span: PdfTextSpan = {
        text: item.str,
        x,
        width: item.width * mapper.scale,
        size,
        bold: info.bold,
        italic: info.italic,
        fontName: info.name,
      }
      const current = drafts[drafts.length - 1]
      if (current && Math.abs(current.baseline - y) <= Math.max(2, size * 0.4)) current.spans.push(span)
      else drafts.push({ baseline: y, spans: [span] })
    }

    const lines: PdfTextLine[] = drafts.map((draft) => {
      const spans = mergeSpans(draft.spans)
      const first = spans[0]
      const last = spans[spans.length - 1]
      const x = first?.x ?? 0
      const right = last ? last.x + last.width : x
      const size = spans.reduce((max, span) => Math.max(max, span.size), 0)
      return {
        spans,
        text: spans.map((span) => span.text).join(' '),
        x,
        y: draft.baseline,
        width: right - x,
        size,
        bold: first?.bold ?? false,
        italic: first?.italic ?? false,
        fontName: first?.fontName ?? null,
      }
    })

    pages.push({ width: viewport.width, height: viewport.height, lines })
  }
  return pages
}

function cleanFontName(name: string | null): string | null {
  if (!name) return null
  if (/^[A-Z]{6}\+/.test(name)) name = name.slice(7)
  if (/^[a-z]*_?[df]\d+$/i.test(name) || /^[fg]_d\d+_f\d+$/.test(name)) return null
  const cleaned = name
    .replace(/[-_,]?(bold|semibold|demi|black|heavy)(italic|oblique)?$/i, '')
    .replace(/[-_,]?(italic|oblique)$/i, '')
    .replace(/[^0-9a-zA-Z ]/g, '')
    .trim()
  return cleaned.length >= 2 ? cleaned : null
}

function lineAlignment(line: PdfTextLine, page: PdfPageText): 'center' | 'right' | null {
  const left = line.x
  const right = page.width - (line.x + line.width)
  if (left > page.width * 0.22 && Math.abs(left - right) < page.width * 0.07) return 'center'
  if (right < page.width * 0.12 && left > page.width * 0.3) return 'right'
  return null
}

async function packOffice(entries: ZipEntry[]): Promise<Uint8Array> {
  const blob = await createZip(entries, { compress: true })
  return new Uint8Array(await blob.arrayBuffer())
}

const CONTENT_TYPES = (overrides: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  overrides.join('') +
  `</Types>`

function runXml(span: PdfTextSpan): string {
  const props = [`<w:sz w:val="${Math.max(2, Math.round(span.size * 2))}"/>`, `<w:szCs w:val="${Math.max(2, Math.round(span.size * 2))}"/>`]
  if (span.bold) props.push('<w:b/>')
  if (span.italic) props.push('<w:i/>')
  const font = cleanFontName(span.fontName)
  if (font) {
    props.push(`<w:rFonts w:ascii="${xmlAttribute(font)}" w:hAnsi="${xmlAttribute(font)}"/>`)
  }
  return `<w:r><w:rPr>${props.join('')}</w:rPr><w:t xml:space="preserve">${xmlEscape(span.text)}</w:t></w:r>`
}

export async function pdfToDocx(pdf: PDFDocumentProxy): Promise<Uint8Array> {
  const pages = await extractPdfText(pdf)
  if (!pages.length) throw new Error('The document has no pages to convert')
  const first = pages[0]
  const width = Math.round(first.width * TWIPS_PER_POINT)
  const height = Math.round(first.height * TWIPS_PER_POINT)

  const body: string[] = []
  pages.forEach((page, pageIndex) => {
    if (!page.lines.length) {
      body.push(pageIndex > 0 ? '<w:p><w:pPr><w:pageBreakBefore/></w:pPr></w:p>' : '<w:p/>')
      return
    }
    page.lines.forEach((line, lineIndex) => {
      const alignment = lineAlignment(line, page)
      const properties = [
        pageIndex > 0 && lineIndex === 0 ? '<w:pageBreakBefore/>' : '',
        alignment ? `<w:jc w:val="${alignment}"/>` : '',
      ].join('')
      const runs = line.spans.map(runXml).join('')
      body.push(`<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${runs || '<w:r/>'}</w:p>`)
    })
  })

  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<w:body>${body.join('')}` +
    `<w:sectPr><w:pgSz w:w="${width}" w:h="${height}"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>` +
    `</w:body></w:document>`

  return packOffice([
    {
      name: '[Content_Types].xml',
      data: CONTENT_TYPES([
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
      ]),
    },
    {
      name: '_rels/.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`,
    },
    { name: 'word/document.xml', data: document },
  ])
}

function columnLetter(index: number): string {
  let value = index + 1
  let letters = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    value = Math.floor((value - 1) / 26)
  }
  return letters
}

interface SheetData {
  name: string
  rows: string[][]
  widths: number[]
}

function buildSheet(page: PdfPageText, name: string): SheetData {
  const starts: number[] = []
  for (const line of page.lines) {
    for (const span of line.spans) {
      if (!starts.some((start) => Math.abs(start - span.x) <= 10)) starts.push(span.x)
    }
  }
  starts.sort((a, b) => a - b)
  const columns: number[] = []
  for (const start of starts) {
    const last = columns[columns.length - 1]
    if (last != null && start - last < 16) continue
    columns.push(start)
  }

  const rows: string[][] = []
  for (const line of page.lines) {
    const row: string[] = []
    for (const span of [...line.spans].sort((a, b) => a.x - b.x)) {
      let index = columns.findIndex((column) => Math.abs(column - span.x) <= 16)
      if (index < 0) {
        columns.push(span.x)
        columns.sort((a, b) => a - b)
        index = columns.indexOf(span.x)
      }
      row[index] = row[index] ? `${row[index]} ${span.text}` : span.text
    }
    if (row.length) rows.push(row)
  }

  const widths = columns.map((_, index) => {
    const longest = rows.reduce((max, row) => Math.max(max, (row[index] ?? '').length), 4)
    return Math.min(80, Math.max(8, longest)) * 1.05
  })
  return { name, rows, widths }
}

export async function pdfToXlsx(pdf: PDFDocumentProxy): Promise<Uint8Array> {
  const pages = await extractPdfText(pdf)
  if (!pages.length) throw new Error('The document has no pages to convert')
  const sheets = pages.map((page, index) => buildSheet(page, `Page ${index + 1}`))

  const sheetParts = sheets.map((sheet) => {
    const rows = sheet.rows
      .map((row, rowIndex) => {
        const cells = row
          .map((value, columnIndex) => {
            if (!value) return ''
            const reference = `${columnLetter(columnIndex)}${rowIndex + 1}`
            return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`
          })
          .join('')
        return cells ? `<row r="${rowIndex + 1}">${cells}</row>` : ''
      })
      .join('')
    const columns = sheet.widths
      .map(
        (width, index) =>
          `<col min="${index + 1}" max="${index + 1}" width="${width.toFixed(2)}" customWidth="1"/>`,
      )
      .join('')
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      (columns ? `<cols>${columns}</cols>` : '') +
      `<sheetData>${rows}</sheetData></worksheet>`
    )
  })

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheets
      .map((sheet, index) => `<sheet name="${xmlAttribute(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
      .join('')}</sheets></workbook>`

  const overrides = [
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    ...sheets.map(
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    ),
  ]

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: CONTENT_TYPES(overrides) },
    {
      name: '_rels/.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    },
    { name: 'xl/workbook.xml', data: workbook },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets
          .map(
            (_, index) =>
              `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
          )
          .join('') +
        `</Relationships>`,
    },
    ...sheetParts.map((data, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data })),
  ]

  return packOffice(entries)
}

const THEME_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">` +
  `<a:themeElements>` +
  `<a:clrScheme name="Office">` +
  `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
  `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
  `<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>` +
  `<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>` +
  `<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>` +
  `<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>` +
  `<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>` +
  `</a:clrScheme>` +
  `<a:fontScheme name="Office">` +
  `<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
  `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
  `</a:fontScheme>` +
  `<a:fmtScheme name="Office">` +
  `<a:fillStyleLst>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>` +
  `<a:solidFill><a:schemeClr val="phClr"><a:shade val="51000"/><a:satMod val="150000"/></a:schemeClr></a:solidFill>` +
  `</a:fillStyleLst>` +
  `<a:lnStyleLst>` +
  `<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>` +
  `<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>` +
  `<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>` +
  `</a:lnStyleLst>` +
  `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
  `<a:bgFillStyleLst>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>` +
  `<a:gradFill rotWithShape="1"><a:gsLst>` +
  `<a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs>` +
  `<a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/></a:schemeClr></a:gs>` +
  `<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs>` +
  `</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>` +
  `</a:bgFillStyleLst>` +
  `</a:fmtScheme>` +
  `</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`

const SLIDE_MASTER_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
  `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>` +
  `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
  `<p:txStyles>` +
  `<p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle>` +
  `<p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle>` +
  `<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>` +
  `</p:txStyles>` +
  `</p:sldMaster>`

const SLIDE_LAYOUT_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">` +
  `<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>` +
  `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
  `</p:sldLayout>`

function textBoxXml(line: PdfTextLine, id: number): string {
  const size = line.size > 0 ? line.size : 12
  const top = Math.max(0, line.y - size * 0.82)
  const x = Math.max(0, line.x)
  const width = Math.max(size * 2, line.width * 1.25 + 4)
  const height = size * 1.6
  const runs = line.spans
    .filter((span) => span.text)
    .map((span) => {
      const attributes = [`lang="en-US"`, `sz="${Math.max(100, Math.round(span.size * 100))}"`, 'dirty="0"']
      if (span.bold) attributes.push('b="1"')
      if (span.italic) attributes.push('i="1"')
      const font = cleanFontName(span.fontName)
      const latin = font ? `<a:latin typeface="${xmlAttribute(font)}"/>` : ''
      return `<a:r><a:rPr ${attributes.join(' ')}>${latin}</a:rPr><a:t>${xmlEscape(span.text)}</a:t></a:r>`
    })
    .join('')
  if (!runs) return ''
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id - 1}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${Math.round(x * EMU_PER_POINT)}" y="${Math.round(top * EMU_PER_POINT)}"/>` +
    `<a:ext cx="${Math.round(width * EMU_PER_POINT)}" cy="${Math.round(height * EMU_PER_POINT)}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>` +
    `<a:p><a:pPr algn="l"/>${runs}</a:p>` +
    `</p:txBody></p:sp>`
  )
}

export async function pdfToPptx(pdf: PDFDocumentProxy): Promise<Uint8Array> {
  const pages = await extractPdfText(pdf)
  if (!pages.length) throw new Error('The document has no pages to convert')
  const width = Math.round(pages[0].width * EMU_PER_POINT)
  const height = Math.round(pages[0].height * EMU_PER_POINT)

  const slideParts = pages.map((page) => {
    const shapes = page.lines
      .map((line, lineIndex) => textBoxXml(line, lineIndex + 2))
      .filter(Boolean)
      .join('')
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
      `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld>` +
      `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
      `</p:sld>`
    )
  })

  const presentation =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>${slideParts
      .map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 3}"/>`)
      .join('')}</p:sldIdLst>` +
    `<p:sldSz cx="${width}" cy="${height}"/><p:notesSz cx="6858000" cy="9144000"/>` +
    `</p:presentation>`

  const overrides = [
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    ...slideParts.map(
      (_, index) =>
        `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    ),
  ]

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: CONTENT_TYPES(overrides) },
    {
      name: '_rels/.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
        `</Relationships>`,
    },
    { name: 'ppt/presentation.xml', data: presentation },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>` +
        slideParts
          .map(
            (_, index) =>
              `<Relationship Id="rId${index + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
          )
          .join('') +
        `</Relationships>`,
    },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: SLIDE_MASTER_XML },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>` +
        `</Relationships>`,
    },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: SLIDE_LAYOUT_XML },
    {
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
        `</Relationships>`,
    },
    { name: 'ppt/theme/theme1.xml', data: THEME_XML },
    ...slideParts.map((data, index) => ({ name: `ppt/slides/slide${index + 1}.xml`, data })),
  ]

  return packOffice(entries)
}
