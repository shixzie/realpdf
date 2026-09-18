/**
 * End-to-end test for the document tools: merge, split, conversions and form
 * filling. Run the dev server first, then: node scripts/e2e-tools.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
const OUT = process.env.OUT_DIR ?? '/tmp/opencode'
fs.mkdirSync(OUT, { recursive: true })

const failures = []
const notes = []
const check = (condition, message) => (condition ? notes.push(`ok - ${message}`) : failures.push(`FAIL - ${message}`))

async function makeFormFixture() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([595, 842])
  page.drawText('Interactive form test', { x: 56, y: 780, size: 18, font })
  const form = doc.getForm()
  const name = form.createTextField('full_name')
  name.addToPage(page, { x: 56, y: 700, width: 300, height: 26 })
  const agree = form.createCheckBox('agree')
  agree.addToPage(page, { x: 56, y: 650, width: 20, height: 20 })
  const color = form.createDropdown('color')
  color.addOptions(['Red', 'Green', 'Blue'])
  color.addToPage(page, { x: 56, y: 600, width: 180, height: 26 })
  const file = path.join(OUT, 'form-fixture.pdf')
  fs.writeFileSync(file, await doc.save())
  return file
}

async function pdfText(file) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: false }).promise
  let text = ''
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    for (const item of content.items) text += `${item.str ?? ''} `
  }
  return text
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`)
})

async function loadSample() {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.empty-card')
  const base64 = fs.readFileSync('sample.pdf').toString('base64')
  await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    const file = new File([bytes], 'sample.pdf', { type: 'application/pdf' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const input = document.querySelector('#open-pdf-input')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, base64)
  await page.waitForSelector('.page canvas.page-base', { timeout: 20000 })
  await page.waitForTimeout(900)
}

const openTools = async (tab) => {
  const already = await page.locator('.modal-wide').count()
  if (!already) await page.click('button[title="Merge, split and convert documents"]')
  await page.click(`.tab:has-text("${tab}")`)
}

try {
  await loadSample()

  // ------------------------------------------------------------- merge
  await openTools('Merge')
  await page.uncheck('.tools-body .check input[type="checkbox"]')
  await page.setInputFiles('input[accept="application/pdf,.pdf"][multiple]', [
    path.resolve('sample.pdf'),
    path.resolve('sample.pdf'),
  ])
  await page.waitForTimeout(400)
  check((await page.locator('.source-item').count()) >= 2, 'merge lists the selected files')
  await page.click('button:has-text("Merge & open")')
  await page.waitForTimeout(1600)
  check((await page.locator('.thumb').count()) === 6, 'merged document has 6 pages')

  // ------------------------------------------------------------- split
  await openTools('Split')
  await page.fill('.text-input', '1,3')
  await page.click('button:has-text("Extract & open")')
  await page.waitForTimeout(1600)
  check((await page.locator('.thumb').count()) === 2, 'split range keeps 2 pages')

  // --------------------------------------------------- pdf -> png
  await openTools('Convert')
  const [pngDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('button:has-text("Current page")'),
  ])
  const pngPath = path.join(OUT, 'converted-page.png')
  await pngDownload.saveAs(pngPath)
  const png = fs.readFileSync(pngPath)
  check(
    png.length > 1000 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47,
    `PDF → PNG produced a valid image (${png.length} bytes)`,
  )

  // --------------------------------------------------- pdf -> text
  const [txtDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('button:has-text("Download .txt")'),
  ])
  const txtPath = path.join(OUT, 'converted.txt')
  await txtDownload.saveAs(txtPath)
  const text = fs.readFileSync(txtPath, 'utf8')
  check(text.includes('RealPDF sample document'), 'PDF → text contains the document text')

  // --------------------------------------------------- images -> pdf
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR42mP8z8BQz0AEYBxVSF+F/1GFA6pwUAFjKmYgWwAAtBwF/0kzR6YAAAAASUVORK5CYII=',
    'base64',
  )
  const pixelPath = path.join(OUT, 'pixel.png')
  fs.writeFileSync(pixelPath, pixel)
  await page.setInputFiles('input[accept^="image/png"][multiple]', pixelPath)
  await page.waitForTimeout(400)
  check((await page.locator('.source-item').count()) === 1, 'images → PDF lists the added image')
  await page.click('button:has-text("Create PDF & open")')
  await page.waitForTimeout(1600)
  check((await page.locator('.thumb').count()) === 1, 'images → PDF opened a one-page document')

  // --------------------------------------------------- text -> pdf
  await openTools('Convert')
  await page.fill('.text-area', 'Generated from plain text.\nSecond line.')
  await page.click('.tool-block:has-text("Text → PDF") button:has-text("Create PDF & open")')
  await page.waitForTimeout(1600)
  const textPdfPath = path.join(OUT, 'from-text.pdf')
  check((await page.locator('.thumb').count()) === 1, 'text → PDF opened a one-page document')

  // ------------------------------------------------------- form filling
  const formFixture = await makeFormFixture()
  const page2 = await context.newPage()
  page2.on('pageerror', (error) => pageErrors.push(`forms: ${error}`))
  await page2.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page2.waitForSelector('.empty-card')
  const fixtureBase64 = fs.readFileSync(formFixture).toString('base64')
  await page2.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    const file = new File([bytes], 'form-fixture.pdf', { type: 'application/pdf' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const input = document.querySelector('#open-pdf-input')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, fixtureBase64)
  await page2.waitForSelector('.page canvas.page-base', { timeout: 20000 })
  await page2.waitForTimeout(900)
  await page2.waitForSelector('button:has-text("Fill forms")', { timeout: 10000 })
  check(true, 'form detection exposes the Fill forms button')
  await page2.click('button:has-text("Fill forms")')
  await page2.waitForSelector('.form-widget', { timeout: 10000 })
  await page2.waitForTimeout(300)
  check((await page2.locator('.form-widget').count()) === 3, 'form overlay shows text, checkbox and dropdown widgets')
  await page2.fill('.forms-layer input.form-widget:not([type="checkbox"]):not([type="radio"])', 'Ada Lovelace')
  await page2.check('.forms-layer input[type="checkbox"]')
  await page2.selectOption('.forms-layer select.form-widget', 'Green')
  await page2.waitForTimeout(200)
  const [formDownload] = await Promise.all([
    page2.waitForEvent('download', { timeout: 30000 }),
    page2.click('button:has-text("Save filled PDF")'),
  ])
  const filledPath = path.join(OUT, 'form-filled.pdf')
  await formDownload.saveAs(filledPath)
  const filledText = await pdfText(filledPath)
  check(filledText.includes('Ada Lovelace'), 'filled text field appears in the exported PDF')
  check(filledText.includes('Green'), 'selected dropdown value appears in the exported PDF')
  check(fs.statSync(filledPath).size > 1000, 'filled PDF has content')

  check(pageErrors.length === 0, `no browser errors (${pageErrors.slice(0, 3).join(' | ')})`)
} catch (error) {
  failures.push(`FAIL - ${error?.stack ?? error}`)
} finally {
  await browser.close()
}

for (const note of notes) console.log(note)
for (const failure of failures) console.log(failure)
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed')
process.exit(failures.length ? 1 : 0)
