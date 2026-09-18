/**
 * End-to-end test for restyling text through the text tool.
 *
 * Run the dev server first, then:
 *   node scripts/e2e-textselect.mjs
 *
 * It verifies that selecting a text annotation (or a replacement of existing
 * PDF text) activates the text tool, that the options panel edits the selected
 * text instead of only the defaults, and that the changes survive export.
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { PDFDocument } from 'pdf-lib'

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/opencode'

const failures = []
const notes = []
function check(condition, message) {
  if (condition) notes.push(`ok - ${message}`)
  else failures.push(`FAIL - ${message}`)
}

/** A blank A4 page, used for text annotations. */
async function buildBlankPdf() {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  fs.writeFileSync(path.join(OUT_DIR, 'textselect-blank.pdf'), await doc.save())
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

/** Counts colour/dark pixels in a page-local region of a specific canvas. */
async function pixelStats(target, selector, local) {
  return target.evaluate(
    ({ selector: canvasSelector, x, y, w, h }) => {
      const canvas = document.querySelector(canvasSelector)
      const rect = canvas.getBoundingClientRect()
      const scale = canvas.width / rect.width
      const data = canvas
        .getContext('2d')
        .getImageData(Math.round(x * scale), Math.round(y * scale), Math.round(w * scale), Math.round(h * scale))
        .data
      let red = 0
      let blue = 0
      let dark = 0
      let opaque = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] <= 100) continue
        opaque += 1
        if (data[i] > 120 && data[i + 1] < 120 && data[i + 2] < 120) red += 1
        if (data[i + 2] > 150 && data[i] < 130 && data[i + 1] < 150) blue += 1
        if (data[i] < 235 || data[i + 1] < 225) dark += 1
      }
      return { red, blue, dark, opaque }
    },
    { selector, x: local.x, y: local.y, w: local.w, h: local.h },
  )
}

const toolIsActive = async (prefix) =>
  page.locator(`.tool[title^="${prefix}"]`).evaluate((element) => element.classList.contains('is-active'))

try {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  await buildBlankPdf()
  fs.writeFileSync(path.join(OUT_DIR, 'textselect-standard.pdf'), buildStandardFontPdf())

  // ------------------------------------------------ text annotations
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.empty-card')
  await openPdf(page, path.join(OUT_DIR, 'textselect-blank.pdf'))
  const box = await page.locator('.page[data-page-index="0"]').boundingBox()

  await page.click('.tool[title^="Text"]')
  await page.mouse.click(box.x + 120, box.y + 150)
  await page.waitForTimeout(200)
  await page.keyboard.type('Style me')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  check(await toolIsActive('Text'), 'the text tool stays active after typing')

  // Selecting the text with the select tool activates the text tool.
  await page.click('.tool[title^="Select"]')
  await page.mouse.click(box.x + 420, box.y + 420)
  await page.waitForTimeout(200)
  await page.mouse.click(box.x + 135, box.y + 155)
  await page.waitForTimeout(400)
  check(await toolIsActive('Text'), 'selecting a text annotation activates the text tool')
  check((await page.locator('.options-title').innerText()).trim().toLowerCase() === 'text', 'the options panel shows the text tool')
  check((await page.locator('.options select').inputValue()) === 'Helvetica', 'the font picker shows the text font')
  check((await page.locator('.slider-size').inputValue()) === '16', 'the size slider shows the text size')
  check(
    (await page.locator('.swatch.is-active').count()) >= 1,
    'the colour swatches show the text colour',
  )

  // Changes apply to the selected text, not just to the defaults.
  await page.locator('.slider-size').fill('40')
  await page.waitForTimeout(200)
  await page.locator('.swatch[title="#dc2626"]').click()
  await page.waitForTimeout(200)
  await page.locator('.options select').selectOption('Courier New')
  await page.waitForTimeout(300)
  const styled = await pixelStats(page, '.page-overlay canvas.lower-canvas', { x: 110, y: 140, w: 200, h: 60 })
  check(styled.red > 20, `the selected text turns red on the canvas (${styled.red} red pixels)`)
  check(styled.dark > 20, `the selected text grows with the size slider (${styled.dark} dark pixels)`)

  // Style changes go through the history.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(500)
  const undone = await pixelStats(page, '.page-overlay canvas.lower-canvas', { x: 110, y: 140, w: 200, h: 60 })
  check(undone.red === 0, 'undo restores the original text style')
  await page.keyboard.press('Control+Shift+z')
  await page.waitForTimeout(500)
  const redone = await pixelStats(page, '.page-overlay canvas.lower-canvas', { x: 110, y: 140, w: 200, h: 60 })
  check(redone.red > 20, 'redo reapplies the text style')

  const [annotationDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('button:has-text("Save PDF")'),
  ])
  const annotationExport = path.join(OUT_DIR, 'textselect-annotation-exported.pdf')
  await annotationDownload.saveAs(annotationExport)

  const view = await context.newPage()
  view.on('pageerror', (error) => pageErrors.push(String(error)))
  await view.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await view.waitForSelector('.empty-card')
  await openPdf(view, annotationExport)
  const exported = await pixelStats(view, 'canvas.page-base', { x: 110, y: 140, w: 200, h: 60 })
  check(exported.red > 20, `the export keeps the selected colour (${exported.red} red pixels)`)
  check(exported.dark > 20, `the export keeps the selected size (${exported.dark} dark pixels)`)
  await view.close()

  // -------------------------------------- replacements of existing PDF text
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.empty-card')
  await openPdf(page, path.join(OUT_DIR, 'textselect-standard.pdf'))
  const standardBox = await page.locator('.page[data-page-index="0"]').boundingBox()

  await page.click('.tool[title^="Edit text"]')
  await page.mouse.click(standardBox.x + 100, standardBox.y + 92)
  await page.waitForTimeout(800)
  check(await toolIsActive('Text'), 'editing existing PDF text activates the text tool')
  check((await page.locator('.slider-size').inputValue()) === '28', 'the size slider shows the matched size')

  await page.locator('.slider-size').fill('40')
  await page.waitForTimeout(200)
  await page.locator('.swatch[title="#2563eb"]').click()
  await page.waitForTimeout(200)
  const edited = await pixelStats(page, '.page-overlay canvas.lower-canvas', { x: 35, y: 55, w: 360, h: 80 })
  check(edited.blue > 20, `the replacement turns blue on the canvas (${edited.blue} blue pixels)`)

  // Clicking away keeps the restyled replacement (even without new text).
  await page.mouse.click(standardBox.x + 350, standardBox.y + 180)
  await page.waitForTimeout(500)
  check(await toolIsActive('Edit text'), 'finishing an in-place edit returns to the edit-text tool')
  const persisted = await pixelStats(page, '.page-overlay canvas.lower-canvas', { x: 35, y: 55, w: 360, h: 80 })
  check(persisted.blue > 20, `the restyled replacement survives deselecting (${persisted.blue} blue pixels)`)

  const [standardDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('button:has-text("Save PDF")'),
  ])
  const standardExport = path.join(OUT_DIR, 'textselect-standard-exported.pdf')
  await standardDownload.saveAs(standardExport)

  const view2 = await context.newPage()
  view2.on('pageerror', (error) => pageErrors.push(String(error)))
  await view2.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await view2.waitForSelector('.empty-card')
  await openPdf(view2, standardExport)
  const exportedStandard = await pixelStats(view2, 'canvas.page-base', { x: 35, y: 55, w: 360, h: 80 })
  check(exportedStandard.blue > 20, `the exported replacement keeps the new colour (${exportedStandard.blue} blue pixels)`)
  await view2.close()

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
