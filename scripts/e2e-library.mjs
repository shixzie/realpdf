/**
 * Library suite: saving a document locally, renaming, persistence across a
 * reload, restoring the editable state and rebuilding the PDF.
 *   node scripts/e2e-library.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
const OUT = process.env.OUT_DIR ?? '/tmp/opencode'
fs.mkdirSync(OUT, { recursive: true })

const failures = []
const notes = []
const check = (condition, message) => (condition ? notes.push(`ok - ${message}`) : failures.push(`FAIL - ${message}`))

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))

const loadSample = async () => {
  const base64 = fs.readFileSync('sample.pdf').toString('base64')
  await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    const file = new File([bytes], 'quarterly-report.pdf', { type: 'application/pdf' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const input = document.querySelector('#open-pdf-input') || document.querySelector('input[accept*="pdf"]')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, base64)
  await page.waitForSelector('.page canvas.page-base', { timeout: 20000 })
  await page.waitForTimeout(1000)
}

try {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.empty-card')
  await loadSample()
  await page.click('button.zoom-label')
  await page.waitForTimeout(300)

  // annotate so the restored state is verifiable
  const box = await page.locator('.page[data-page-index="0"]').boundingBox()
  await page.click('.tool[title^="Rectangle"]')
  await page.mouse.move(box.x + 120, box.y + 600)
  await page.mouse.down()
  await page.mouse.move(box.x + 320, box.y + 680, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(700)

  // ------------------------------------------------------------ save it
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('button:has-text("Save PDF")'),
  ])
  const exportedPath = path.join(OUT, 'library-export.pdf')
  await download.saveAs(exportedPath)
  await page.waitForSelector('.toast:has-text("Saved your edited PDF")', { timeout: 30000 })
  await page.waitForTimeout(800)

  // --------------------------------------------------------- in library
  await page.click('button:has-text("Library")')
  await page.waitForSelector('.library-item')
  check((await page.locator('.library-item').count()) === 1, 'saved document appears in the library')
  const meta = await page.locator('.library-meta').first().innerText()
  check(meta.includes('3 pages'), `library entry shows the page count (${meta})`)
  check((await page.locator('.library-thumb img').count()) === 1, 'library entry has a page thumbnail')

  // rename
  await page.click('.library-title')
  await page.fill('.library-title-input', 'Quarterly report — final')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  check(
    (await page.locator('.library-title').first().innerText()).includes('Quarterly report — final'),
    'library entry can be renamed',
  )
  await page.click('.modal-head .icon-button')
  await page.waitForTimeout(300)

  // ------------------------------------------- persistence across reload
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.empty-card')
  await page.waitForTimeout(800)
  check((await page.locator('.recent-card').count()) === 1, 'homepage shows recent work after a reload')
  await page.locator('.recent-card').first().click()
  await page.waitForSelector('.page canvas.page-base', { timeout: 20000 })
  await page.waitForTimeout(1200)
  check((await page.locator('.thumb').count()) === 3, 'restored document has its pages')
  const restoredName = await page.locator('.file-name').innerText()
  check(restoredName === 'Quarterly report — final', `restored document keeps its title (${restoredName})`)
  const restoredBadge = await page.locator('.thumb-badge').first().innerText().catch(() => null)
  check(restoredBadge === '1', `restored document keeps its annotations (badge: ${restoredBadge})`)

  // ------------------------------------- rebuild the PDF from the library
  await page.click('button:has-text("Library")')
  await page.waitForSelector('.library-item')
  const [libraryDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('.library-item button:has-text("PDF")'),
  ])
  const rebuiltPath = path.join(OUT, 'library-rebuilt.pdf')
  await libraryDownload.saveAs(rebuiltPath)
  const rebuilt = fs.readFileSync(rebuiltPath)
  check(
    rebuilt.length > 2000 && rebuilt[0] === 0x25 && rebuilt[1] === 0x50 && rebuilt[2] === 0x44 && rebuilt[3] === 0x46,
    `library can rebuild the PDF (${rebuilt.length} bytes)`,
  )

  // ------------------------------------------------------------- delete
  await page.click('.library-item button[title="Delete"]')
  await page.waitForTimeout(600)
  check((await page.locator('.library-item').count()) === 0, 'library entry can be deleted')

  check(pageErrors.length === 0, `no browser errors (${pageErrors.slice(0, 2).join(' | ')})`)
} catch (error) {
  failures.push(`FAIL - ${error?.stack ?? error}`)
} finally {
  await browser.close()
}

for (const note of notes) console.log(note)
for (const failure of failures) console.log(failure)
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed')
process.exit(failures.length ? 1 : 0)
