/**
 * End-to-end test for editing text that already lives in a PDF.
 *
 * Run the dev server first, then:
 *   node scripts/e2e-textedit.mjs
 *
 * It edits embedded-font text and standard-font text through the UI, then
 * re-opens the exported files and verifies the pixels (replacement present,
 * original gone, colours kept), the text layer (the original run is really
 * deleted, not covered) and the embedded font programs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { PDFDocument, PDFName, PDFDict, StandardFonts, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import * as pdfjs from 'pdfjs-dist'

// pdf.js uses the newest typed-array helpers, which older Node builds lack.
if (typeof Uint8Array.prototype.toHex !== 'function') {
  Object.defineProperty(Uint8Array.prototype, 'toHex', {
    value() {
      return Buffer.from(this).toString('hex')
    },
    configurable: true,
  })
}
if (typeof Uint8Array.prototype.toBase64 !== 'function') {
  Object.defineProperty(Uint8Array.prototype, 'toBase64', {
    value() {
      return Buffer.from(this).toString('base64')
    },
    configurable: true,
  })
}
if (typeof Math.sumPrecise !== 'function') {
  Math.sumPrecise = (values) => {
    let total = 0
    for (const value of values) total += value
    return total
  }
}

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/opencode'
const LIBERATION = path.resolve('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf')

const failures = []
const notes = []
function check(condition, message) {
  if (condition) notes.push(`ok - ${message}`)
  else failures.push(`FAIL - ${message}`)
}

/** A4 page whose text is drawn with an embedded TrueType font. */
async function buildEmbeddedFontPdf() {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const font = await doc.embedFont(fs.readFileSync(LIBERATION), { subset: false })
  const page = doc.addPage([595, 842])
  page.drawText('The quick brown fox', { x: 56, y: 700, size: 18, font, color: rgb(0.8, 0.1, 0.1) })
  page.drawText('Second line stays', { x: 56, y: 660, size: 12, font, color: rgb(0.1, 0.1, 0.1) })
  fs.writeFileSync(path.join(OUT_DIR, 'textedit-embedded.pdf'), await doc.save())
}

/** Small page whose text uses the non-embedded base-14 Helvetica. */
function buildStandardFontPdf() {
  const stream = 'BT /F1 28 Tf 40 100 Td (Standard font test) Tj ET'
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  bodies.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

/** Page whose text sits on coloured stripes, so a cover would be visible. */
async function buildStripedPdf() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([400, 200])
  const colors = [rgb(0.86, 0.2, 0.2), rgb(0.2, 0.65, 0.3), rgb(0.2, 0.3, 0.85)]
  for (let index = 0; index < 13; index += 1) {
    page.drawRectangle({ x: 30 + index * 14, y: 100, width: 14, height: 30, color: colors[index % 3] })
  }
  page.drawText('Replace this', { x: 34, y: 110, size: 16, font, color: rgb(0, 0, 0) })
  fs.writeFileSync(path.join(OUT_DIR, 'textedit-striped.pdf'), await doc.save())
}

/** The text layer of the first page, as pdf.js reads it back. */
async function pdfText(filePath) {
  const bytes = new Uint8Array(fs.readFileSync(filePath))
  const document = await pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    standardFontDataUrl: `${path.resolve('node_modules/pdfjs-dist/standard_fonts')}/`,
  }).promise
  const page = await document.getPage(1)
  const content = await page.getTextContent()
  return content.items.map((item) => item.str).join('')
}

/** Font entries (with whether a font program is embedded) of a PDF page. */
async function pageFonts(filePath, pageIndex = 0) {
  const doc = await PDFDocument.load(fs.readFileSync(filePath), { ignoreEncryption: true })
  const dictionary = doc.getPage(pageIndex).node.Resources()?.lookup(PDFName.of('Font'), PDFDict)
  if (!dictionary) return []
  const entries = []
  for (const key of dictionary.keys()) {
    const raw = dictionary.get(key)
    const font = doc.context.lookup(raw)
    const base = font.get(PDFName.of('BaseFont'))?.toString() ?? ''
    const subtype = font.get(PDFName.of('Subtype'))?.toString() ?? ''
    const descendant =
      subtype === '/Type0' ? doc.context.lookup(font.get(PDFName.of('DescendantFonts'))?.get?.(0)) : font
    const descriptor = doc.context.lookup(descendant?.get?.(PDFName.of('FontDescriptor')))
    const embedded = Boolean(
      descriptor?.get?.(PDFName.of('FontFile2')) ??
        descriptor?.get?.(PDFName.of('FontFile3')) ??
        descriptor?.get?.(PDFName.of('FontFile')),
    )
    entries.push({ key: key.toString(), ref: String(raw), base, subtype, embedded })
  }
  return entries
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`)
})

async function openPdf(target, filePath) {
  const base64 = fs.readFileSync(filePath).toString('base64')
  await target.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    const file = new File([bytes], 'document.pdf', { type: 'application/pdf' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const input = document.querySelector('#open-pdf-input') || document.querySelector('input[accept*="pdf"]')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, base64)
  await target.waitForSelector('.page canvas.page-base', { timeout: 20000 })
  await target.waitForTimeout(1200)
  await target.click('button.zoom-label')
  await target.waitForTimeout(300)
}

function pageBox(index = 0) {
  return page.locator(`.page[data-page-index="${index}"]`).boundingBox()
}

async function overlayStats(local, index = 0) {
  return page.evaluate(
    ({ x, y, w, h, index: pageIndex }) => {
      const host = document.querySelectorAll('.page')[pageIndex]
      const canvas = host.querySelector('.page-overlay canvas.lower-canvas')
      const rect = canvas.getBoundingClientRect()
      const scale = canvas.width / rect.width
      const data = canvas
        .getContext('2d')
        .getImageData(
          Math.round(x * scale),
          Math.round(y * scale),
          Math.round(w * scale),
          Math.round(h * scale),
        ).data
      let dark = 0
      let opaque = 0
      let alpha = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > alpha) alpha = data[i + 3]
        if (data[i + 3] > 200) {
          opaque += 1
          if (data[i] < 235 || data[i + 1] < 225 || data[i + 2] < 225) dark += 1
        }
      }
      return { dark, opaque, alpha, total: data.length / 4 }
    },
    { x: local.x, y: local.y, w: local.w, h: local.h, index },
  )
}

async function baseStats(filePath, local, index = 0) {
  const target = await context.newPage()
  target.on('pageerror', (error) => pageErrors.push(String(error)))
  try {
    await target.goto(APP_URL, { waitUntil: 'domcontentloaded' })
    await target.waitForSelector('.empty-card')
    await openPdf(target, filePath)
    return await target.evaluate(
      ({ x, y, w, h, index: pageIndex }) => {
        const host = document.querySelectorAll('.page')[pageIndex]
        const canvas = host.querySelector('canvas.page-base')
        const rect = canvas.getBoundingClientRect()
        const scale = canvas.width / rect.width
        const data = canvas
          .getContext('2d')
          .getImageData(
            Math.round(x * scale),
            Math.round(y * scale),
            Math.round(w * scale),
            Math.round(h * scale),
          ).data
        let dark = 0
        let black = 0
        let reddish = 0
        const columns = new Array(Math.round(w * scale)).fill(0)
        const saturatedBins = new Set()
        for (let i = 0; i < data.length; i += 4) {
          const pixel = i / 4
          const column = pixel % Math.round(w * scale)
          if (data[i] < 235 || data[i + 1] < 225 || data[i + 2] < 225) {
            dark += 1
            columns[column] += 1
          }
          if (data[i] < 90 && data[i + 1] < 90 && data[i + 2] < 90) black += 1
          if (data[i] > 120 && data[i + 1] < 120 && data[i + 2] < 120) reddish += 1
          const max = Math.max(data[i], data[i + 1], data[i + 2])
          const min = Math.min(data[i], data[i + 1], data[i + 2])
          if (data[i + 3] > 200 && max > 60 && max - min > 50) {
            saturatedBins.add(((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4))
          }
        }
        let clusters = 0
        let inked = false
        for (const count of columns) {
          if (count > 0 && !inked) {
            clusters += 1
            inked = true
          } else if (count === 0) {
            inked = false
          }
        }
        return { dark, black, reddish, clusters, saturatedBins: saturatedBins.size }
      },
      { x: local.x, y: local.y, w: local.w, h: local.h, index },
    )
  } finally {
    await target.close()
  }
}

try {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  await buildEmbeddedFontPdf()
  fs.writeFileSync(path.join(OUT_DIR, 'textedit-standard.pdf'), buildStandardFontPdf())

  // ------------------------------------------------------- embedded fonts
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.empty-card')
  await openPdf(page, path.join(OUT_DIR, 'textedit-embedded.pdf'))
  check((await page.locator('.tool[title^="Edit text"]').count()) === 1, 'the Edit text tool is in the rail')

  await page.click('.tool[title^="Edit text"]')
  const first = await pageBox()
  await page.mouse.move(first.x + 150, first.y + 134)
  await page.waitForTimeout(350)
  const hover = await overlayStats({ x: 148, y: 128, w: 4, h: 4 })
  check(hover.alpha > 20, `hovering existing text shows a highlight (alpha ${hover.alpha})`)

  // Edit the first line: original is "The quick brown fox" in red 18pt.
  await page.mouse.click(first.x + 150, first.y + 134)
  await page.waitForTimeout(700)
  await page.keyboard.type('Ship it')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  // Deselect without leaving the tool, so selection controls are not sampled.
  await page.mouse.click(first.x + 520, first.y + 760)
  await page.waitForTimeout(400)
  const editedText = await overlayStats({ x: 56, y: 124, w: 60, h: 24 })
  const editedCover = await overlayStats({ x: 140, y: 130, w: 40, h: 8 })
  check(editedText.dark > 5, `replacement text renders on the overlay (${editedText.dark} dark pixels)`)
  check(
    editedCover.alpha > 200 && editedCover.dark === 0,
    `the original run is covered behind the replacement (alpha ${editedCover.alpha})`,
  )

  // Undo/redo around the edit (typing may add extra history steps).
  let undos = 0
  for (; undos < 4; undos += 1) {
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(450)
    const undone = await overlayStats({ x: 56, y: 124, w: 160, h: 24 })
    if (undone.dark === 0 && undone.alpha === 0) break
  }
  check(undos > 0 && undos < 4, `undo removes the text replacement (${undos} step(s))`)
  for (let i = 0; i < undos; i += 1) {
    await page.keyboard.press('Control+Shift+z')
    await page.waitForTimeout(350)
  }
  const redone = await overlayStats({ x: 56, y: 124, w: 60, h: 24 })
  check(redone.dark > 5, 'redo restores the text replacement')

  // Re-edit the replacement: clicking it edits in place.
  await page.mouse.click(first.x + 70, first.y + 134)
  await page.waitForTimeout(600)
  await page.keyboard.type('Ship it now')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const reedited = await overlayStats({ x: 56, y: 124, w: 100, h: 24 })
  check(reedited.dark > 5, `a replacement can be edited again (${reedited.dark} dark pixels)`)

  // Second line: the replacement is longer and wraps to two lines.
  await page.mouse.click(first.x + 90, first.y + 176)
  await page.waitForTimeout(600)
  await page.keyboard.type('Second line changed')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const wrappedTop = await overlayStats({ x: 56, y: 162, w: 110, h: 22 })
  const wrappedBottom = await overlayStats({ x: 56, y: 186, w: 110, h: 22 })
  check(wrappedTop.dark > 5 && wrappedBottom.dark > 3, 'longer replacements wrap onto a second line')

  // --------------------------------------------------------------- export
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('button:has-text("Save PDF")'),
  ])
  const exported = path.join(OUT_DIR, 'textedit-exported.pdf')
  await download.saveAs(exported)
  check(fs.statSync(exported).size > 3000, `exported PDF written (${fs.statSync(exported).size} bytes)`)

  const fonts = await pageFonts(exported)
  const uniqueFonts = [...new Map(fonts.map((font) => [font.ref, font])).values()]
  const embeddedFonts = uniqueFonts.filter((font) => font.embedded)
  check(
    embeddedFonts.length === 2,
    `export embeds the original font plus one replacement subset (${uniqueFonts.length} fonts)`,
  )
  check(
    uniqueFonts.length === 2,
    `replacement text shares a single font subset (${uniqueFonts.map((font) => font.key).join(', ')})`,
  )

  const replacement = await baseStats(exported, { x: 56, y: 124, w: 95, h: 24 })
  check(replacement.dark > 5, `exported PDF shows the replacement text (${replacement.dark} dark pixels)`)
  check(replacement.reddish > 5, `replacement keeps the original colour (${replacement.reddish} red pixels)`)
  const covered = await baseStats(exported, { x: 152, y: 124, w: 62, h: 24 })
  check(covered.dark === 0, 'the original text is gone from the export')
  const secondLine = await baseStats(exported, { x: 56, y: 162, w: 110, h: 46 })
  check(secondLine.dark > 8, `exported PDF shows the wrapped replacement (${secondLine.dark} dark pixels)`)

  // The old text must be deleted from the text layer, not just covered.
  const exportedLayer = await pdfText(exported)
  check(
    !exportedLayer.includes('The quick brown fox'),
    `the text layer no longer contains the original run (${exportedLayer})`,
  )
  check(!exportedLayer.includes('Second line stays'), 'the text layer no longer contains the second run')
  check(exportedLayer.includes('Ship it now'), 'the replacement is real text in the exported layer')
  check(
    exportedLayer.includes('Second line') && exportedLayer.includes('changed'),
    'the wrapped replacement is real text too',
  )

  // --------------------------------------------------- local library round trip
  await page.click('button:has-text("Library")')
  await page.waitForSelector('.library-item', { timeout: 15000 })
  const [libraryDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('.library-item .library-actions button:has-text("PDF")'),
  ])
  const rebuilt = path.join(OUT_DIR, 'textedit-library.pdf')
  await libraryDownload.saveAs(rebuilt)
  const rebuiltFonts = await pageFonts(rebuilt)
  const rebuiltUnique = [...new Map(rebuiltFonts.map((font) => [font.ref, font])).values()]
  check(
    rebuiltUnique.filter((font) => font.embedded).length === 2,
    `the library keeps the original font program (${rebuiltUnique.length} fonts)`,
  )
  const rebuiltLayer = await pdfText(rebuilt)
  check(
    !rebuiltLayer.includes('The quick brown fox') && rebuiltLayer.includes('Ship it now'),
    `library rebuild also deletes the original glyphs (${rebuiltLayer})`,
  )

  // Reopen from browser storage: the font asset must be restored.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.empty-card')
  await page.locator('.recent-card').first().click()
  await page.waitForSelector('.page canvas.page-base', { timeout: 20000 })
  await page.waitForTimeout(1200)
  await page.click('button.zoom-label')
  await page.waitForTimeout(300)
  const restored = await overlayStats({ x: 56, y: 124, w: 95, h: 24 })
  check(restored.dark > 5, `restored document renders the replacement (${restored.dark} dark pixels)`)

  // ------------------------------------------------------- standard fonts
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.empty-card')
  await openPdf(page, path.join(OUT_DIR, 'textedit-standard.pdf'))
  await page.click('.tool[title^="Edit text"]')
  const standardBox = await pageBox()
  await page.mouse.click(standardBox.x + 100, standardBox.y + 92)
  await page.waitForTimeout(800)
  await page.keyboard.type('Standard edited')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  const [standardDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('button:has-text("Save PDF")'),
  ])
  const standardExported = path.join(OUT_DIR, 'textedit-standard-exported.pdf')
  await standardDownload.saveAs(standardExported)
  const standardFonts = await pageFonts(standardExported)
  check(
    standardFonts.length > 0 && standardFonts.every((font) => !font.embedded),
    `standard text stays non-embedded (${standardFonts.map((font) => font.base).join(', ')})`,
  )
  check(
    standardFonts.some((font) => /helvetica/i.test(font.base)),
    'standard text keeps a Helvetica base font',
  )
  const standardText = await baseStats(standardExported, { x: 35, y: 70, w: 220, h: 40 })
  check(standardText.dark > 10, `standard-font replacement renders (${standardText.dark} dark pixels)`)
  const standardCovered = await baseStats(standardExported, { x: 242, y: 70, w: 22, h: 40 })
  check(standardCovered.dark === 0, 'standard-font original is gone from the export')
  const standardLayer = await pdfText(standardExported)
  check(
    !standardLayer.includes('Standard font test'),
    `the standard-font original is deleted, not covered (${standardLayer})`,
  )
  check(standardLayer.includes('Standard edited'), 'the standard-font replacement is real text in the layer')

  // --------------------------------------------- no background cover
  // Text over coloured stripes: if the exporter painted a sampled background
  // rectangle over the original run, the stripes would be flattened.
  await buildStripedPdf()
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.empty-card')
  await openPdf(page, path.join(OUT_DIR, 'textedit-striped.pdf'))
  await page.click('.tool[title^="Edit text"]')
  const stripedBox = await pageBox()
  await page.mouse.click(stripedBox.x + 60, stripedBox.y + 84)
  await page.waitForTimeout(700)
  await page.keyboard.type('Go')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await page.mouse.click(stripedBox.x + 350, stripedBox.y + 180)
  await page.waitForTimeout(300)

  const [stripedDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('button:has-text("Save PDF")'),
  ])
  const stripedExported = path.join(OUT_DIR, 'textedit-striped-exported.pdf')
  await stripedDownload.saveAs(stripedExported)
  const stripedLayer = await pdfText(stripedExported)
  check(!stripedLayer.includes('Replace this'), `striped original is deleted (${stripedLayer})`)
  check(stripedLayer.includes('Go'), 'striped replacement is real text')
  const stripes = await baseStats(stripedExported, { x: 60, y: 74, w: 55, h: 24 })
  check(stripes.black === 0, 'no original glyphs remain over the stripes')
  check(
    stripes.saturatedBins >= 3,
    `the striped background is intact — no cover rectangle (${stripes.saturatedBins} colours)`,
  )

  if (pageErrors.length) {
    failures.push(`FAIL - page errors during the run: ${pageErrors.join(' | ')}`)
  } else {
    notes.push('ok - no browser page errors during the whole run')
  }
} catch (error) {
  failures.push(`FAIL - ${error?.stack ?? error}`)
} finally {
  await browser.close()
}

for (const note of notes) console.log(note)
for (const failure of failures) console.log(failure)
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed')
process.exit(failures.length ? 1 : 0)
