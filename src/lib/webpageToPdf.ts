import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import { PDFDocument } from 'pdf-lib'
import { FontBook, drawLayoutLine, layoutRuns, textStyle } from './pdfLayout'
import { t } from '../i18n'

interface Paragraph {
  text: string
  heading: number
}

const OMIT = new Set(['head', 'script', 'style', 'iframe', 'object', 'template', 'noscript', 'svg', 'canvas'])
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'li', 'tr', 'blockquote', 'pre'])

export async function webpageToPdf(html: string): Promise<Uint8Array> {
  const paragraphs: Paragraph[] = []
  let text = ''
  let heading = 0
  const flush = () => {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (clean) paragraphs.push({ text: clean, heading })
    text = ''
  }
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    if (node.nodeName === '#text') {
      text += (node as DefaultTreeAdapterTypes.TextNode).value
      return
    }
    const element = 'tagName' in node ? node : null
    if (element) {
      if (OMIT.has(element.tagName) || element.attrs.some((attr) =>
        attr.name === 'hidden' || (attr.name === 'style' && /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attr.value)),
      )) return
      if (element.tagName === 'br') {
        flush()
        return
      }
    }
    const level = element && /^h[1-6]$/.test(element.tagName) ? Number(element.tagName[1]) : 0
    const block = level || (element && BLOCK.has(element.tagName))
    const previousHeading = heading
    if (block) flush()
    if (level) heading = level
    if ('childNodes' in node) for (const child of node.childNodes) visit(child)
    if (element?.tagName === 'td' || element?.tagName === 'th') text += '  '
    if (block) flush()
    heading = previousHeading
  }
  visit(parse(html))
  flush()
  if (!paragraphs.length) throw new Error(t('advanced.noHtmlText'))
  const pdf = await PDFDocument.create()
  const fonts = new FontBook(pdf)
  let page = pdf.addPage([595.28, 841.89])
  let y = 790
  for (const paragraph of paragraphs) {
    const size = paragraph.heading ? Math.max(12, 26 - paragraph.heading * 2) : 11
    const style = textStyle({ size, bold: paragraph.heading > 0 })
    const lines = await layoutRuns([{ text: paragraph.text, style }], 491, fonts)
    for (const line of lines) {
      if (y < 52 + size) {
        page = pdf.addPage([595.28, 841.89])
        y = 790
      }
      drawLayoutLine(page, line, 52, y)
      y -= size * 1.4
    }
    y -= 8
  }
  return pdf.save({ useObjectStreams: true })
}
