/**
 * End-to-end smoke test for RealPDF.
 *
 * Run the dev server first, then:
 *   node scripts/e2e.mjs
 *
 * It loads the sample PDF, draws annotations with real pointer input, exports
 * the PDF through the UI, then re-opens the exported file and verifies the
 * annotations are present in the rendered pixels.
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
const OUT_DIR = process.env.OUT_DIR ?? '/tmp/opencode'

function buildStandardFontPdf() {
  // A hand-built PDF whose text uses the base-14 Helvetica font without
  // embedding it, so pdf.js must load `standard_fonts/` from our assets.
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

const failures = []
const notes = []
function check(condition, message) {
  if (condition) {
    notes.push(`ok - ${message}`)
  } else {
    failures.push(`FAIL - ${message}`)
  }
}

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
const page = await context.newPage()

const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`)
})

async function loadPdf(filePath) {
  const base64 = fs.readFileSync(filePath).toString('base64')
  await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    const file = new File([bytes], 'sample.pdf', { type: 'application/pdf' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const input = document.querySelector('#open-pdf-input') || document.querySelector('input[accept*="pdf"]')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, base64)
  await page.waitForSelector('.page canvas.page-base', { timeout: 20000 })
  await page.waitForTimeout(1200)
  // Normalize zoom so page-local coordinates are PDF points.
  await page.click('button.zoom-label')
  await page.waitForTimeout(300)
}

function pageBox(index = 0) {
  return page.locator(`.page[data-page-index="${index}"]`).boundingBox()
}

/** Drags on the page at page-local coordinates (PDF points at zoom 1). */
async function dragOnPage(from, to, index = 0) {
  const box = await pageBox(index)
  if (!box) throw new Error('page not found')
  await page.mouse.move(box.x + from.x, box.y + from.y)
  await page.mouse.down()
  await page.mouse.move(box.x + (from.x + to.x) / 2, box.y + (from.y + to.y) / 2, { steps: 6 })
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(220)
}

/** Counts dark pixels in a page-local region of the fabric annotation layer. */
async function countOverlayDark(local, index = 0) {
  return page.evaluate(
    ({ x, y, w, h, index: pageIndex }) => {
      const pages = document.querySelectorAll('.page')
      const host = pages[pageIndex]
      const canvas = host.querySelector('.page-overlay canvas.lower-canvas')
      const rect = canvas.getBoundingClientRect()
      const scale = canvas.width / rect.width
      const ctx = canvas.getContext('2d')
      const data = ctx.getImageData(
        Math.max(0, Math.round(x * scale)),
        Math.max(0, Math.round(y * scale)),
        Math.round(w * scale),
        Math.round(h * scale),
      ).data
      let count = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 200 && data[i + 1] < 200 && data[i + 2] < 200 && data[i + 3] > 60) count += 1
      }
      return count
    },
    { x: local.x, y: local.y, w: local.w, h: local.h, index },
  )
}

/** Reads a pixel from the fabric annotation layer at page-local coordinates. */
async function readOverlayPixel(local, index = 0) {
  return page.evaluate(
    ({ x, y, index: pageIndex }) => {
      const pages = document.querySelectorAll('.page')
      const host = pages[pageIndex]
      const canvas = host.querySelector('.page-overlay canvas.lower-canvas') || host.querySelector('.page-overlay canvas')
      const rect = canvas.getBoundingClientRect()
      const scale = canvas.width / rect.width
      const ctx = canvas.getContext('2d')
      const data = ctx.getImageData(
        Math.max(0, Math.round(x * scale)),
        Math.max(0, Math.round(y * scale)),
        1,
        1,
      ).data
      return [data[0], data[1], data[2], data[3]]
    },
    { x: local.x, y: local.y, index },
  )
}

function isDark(pixel) {
  return pixel[3] > 100 && pixel[0] < 200 && pixel[1] < 200 && pixel[2] < 200
}

function isReddish(pixel) {
  return pixel[0] > 120 && pixel[1] < 120 && pixel[2] < 120
}

try {
  // ---------------------------------------------------------------- load
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.empty-card')
  await loadPdf(path.resolve('sample.pdf'))
  check((await page.locator('.page').count()) >= 1, 'sample.pdf loaded and at least one page rendered')
  check((await page.locator('.thumb').count()) === 3, 'sidebar shows 3 thumbnails')

  // ------------------------------------------------------------ rectangle
  await page.click('.tool[title^="Rectangle"]')
  await dragOnPage({ x: 120, y: 620 }, { x: 330, y: 700 })
  check(
    (await page.locator('.page canvas.page-base').count()) > 0,
    'rectangle tool created an annotation without crashing',
  )
  const rectEdge = await readOverlayPixel({ x: 120, y: 660 })
  check(isDark(rectEdge), `rectangle stroke visible on canvas (pixel ${rectEdge.join(',')})`)

  // --------------------------------------------------------------- text
  await page.click('.tool[title^="Text"]')
  const box = await pageBox()
  await page.mouse.click(box.x + 120, box.y + 470)
  await page.waitForTimeout(150)
  await page.keyboard.type('Reviewed by E2E')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(350)
  const textDark = await countOverlayDark({ x: 112, y: 455, w: 200, h: 30 })
  check(textDark > 5, `text annotation visible on canvas (${textDark} dark pixels)`)

  // --------------------------------------------------------- highlighter
  await page.click('.tool[title^="Highlight"]')
  await dragOnPage({ x: 60, y: 452 }, { x: 480, y: 470 })
  const highlightPixel = await readOverlayPixel({ x: 240, y: 461 })
  check(
    highlightPixel[0] > 200 && highlightPixel[1] > 150 && highlightPixel[2] < 160,
    `highlighter paints a translucent yellow (pixel ${highlightPixel.join(',')})`,
  )
  await page.keyboard.press('Escape')

  // --------------------------------------------------------------- image
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 80
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#e11d48'
    ctx.fillRect(0, 0, 160, 80)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(40, 30, 80, 20)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    const file = new File([blob], 'stamp.png', { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const input = document.querySelector('input[accept*="image/"]')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitForTimeout(600)
  const imagePixel = await readOverlayPixel({ x: 237, y: 391 })
  check(isReddish(imagePixel), `image annotation visible on canvas (pixel ${imagePixel.join(',')})`)

  // ------------------------------------------------------- pen + eraser
  await page.click('.tool[title^="Draw"]')
  await dragOnPage({ x: 400, y: 545 }, { x: 520, y: 600 }, 0)
  const penDark = await countOverlayDark({ x: 395, y: 535, w: 140, h: 80 })
  check(penDark > 10, `pen stroke visible on canvas (${penDark} dark pixels)`)

  await page.click('.tool[title^="Erase annotation"]')
  const eraseBox = await pageBox()
  await page.mouse.click(eraseBox.x + 200, eraseBox.y + 660)
  await page.waitForTimeout(300)
  const erased = await readOverlayPixel({ x: 120, y: 660 })
  check(!isDark(erased), 'eraser removed the rectangle annotation')
  await page.click('button[title^="Undo"]')
  await page.waitForTimeout(400)
  const restored = await readOverlayPixel({ x: 120, y: 660 })
  check(isDark(restored), 'undo restored the erased rectangle')

  // -------------------------------------------------------- undo / redo
  await page.click('.tool[title^="Rectangle"]')
  await dragOnPage({ x: 150, y: 180 }, { x: 250, y: 230 }, 0)
  const drawn = await readOverlayPixel({ x: 150, y: 205 })
  check(isDark(drawn), 'annotation drawn for undo/redo check')
  await page.click('button[title^="Undo"]')
  await page.waitForTimeout(450)
  const afterUndo = await readOverlayPixel({ x: 150, y: 205 })
  check(!isDark(afterUndo), 'undo removes the annotation')
  await page.click('button[title^="Redo"]')
  await page.waitForTimeout(450)
  const afterRedo = await readOverlayPixel({ x: 150, y: 205 })
  check(isDark(afterRedo), 'redo restores the annotation')

  // ----------------------------------------------------------- signature
  await page.click('.tool[title^="Signature"]')
  await page.waitForSelector('.signature-pad')
  const pad = await page.locator('.signature-pad').boundingBox()
  await page.mouse.move(pad.x + 90, pad.y + 120)
  await page.mouse.down()
  await page.mouse.move(pad.x + 160, pad.y + 70, { steps: 8 })
  await page.mouse.move(pad.x + 240, pad.y + 140, { steps: 8 })
  await page.mouse.move(pad.x + 330, pad.y + 80, { steps: 8 })
  await page.mouse.up()
  await page.click('button:has-text("Add signature")')
  await page.waitForTimeout(600)

  // ------------------------------------------------------------ undo/redo
  await page.click('button[title^="Undo"]')
  await page.waitForTimeout(300)
  await page.click('button[title^="Redo"]')
  await page.waitForTimeout(300)

  // ------------------------------------------- virtualization + page ops
  // Draw on page 2, scroll away, scroll back: the annotation must survive.
  await page.locator('.thumb').nth(1).click()
  await page.waitForTimeout(700)
  await page.click('.tool[title^="Ellipse"]')
  await dragOnPage({ x: 150, y: 400 }, { x: 300, y: 500 }, 1)
  const page2Ellipse = await page.evaluate(() => {
    const host = document.querySelector('.page[data-page-index="1"]')
    const canvas = host.querySelector('.page-overlay canvas.lower-canvas')
    const rect = canvas.getBoundingClientRect()
    const scale = canvas.width / rect.width
    const ctx = canvas.getContext('2d')
    const data = ctx.getImageData(Math.round(150 * scale), Math.round(450 * scale), 1, 1).data
    return [data[0], data[1], data[2], data[3]]
  })
  check(isDark(page2Ellipse), `page 2 ellipse drawn (pixel ${page2Ellipse.join(',')})`)
  await page.locator('.thumb').nth(2).click()
  await page.waitForTimeout(700)
  await page.locator('.thumb').nth(1).click()
  await page.waitForTimeout(900)
  const page2AfterRemount = await page.evaluate(() => {
    const host = document.querySelector('.page[data-page-index="1"]')
    const canvas = host.querySelector('.page-overlay canvas.lower-canvas')
    const rect = canvas.getBoundingClientRect()
    const scale = canvas.width / rect.width
    const ctx = canvas.getContext('2d')
    const data = ctx.getImageData(Math.round(150 * scale), Math.round(450 * scale), 1, 1).data
    return [data[0], data[1], data[2], data[3]]
  })
  check(isDark(page2AfterRemount), 'page 2 annotation survives remounting (virtualization)')

  // Move page 2 to the end and back, then add a blank page with text.
  await page.locator('.thumb').nth(1).dragTo(page.locator('.thumb').nth(2))
  await page.waitForTimeout(500)
  check((await page.locator('.thumb').count()) === 3, 'page reorder keeps 3 pages')
  await page.click('button[title^="Undo"]')
  await page.waitForTimeout(500)

  // ------------------------------------------------------- page add/delete
  await page.locator('.thumb').nth(2).click()
  await page.waitForTimeout(400)
  await page.click('.sidebar-head button[title^="Add a blank page"]')
  await page.waitForTimeout(400)
  check((await page.locator('.thumb').count()) === 4, 'adding a blank page updates the sidebar')
  await page.click('button[title^="Undo"]')
  await page.waitForTimeout(400)
  check((await page.locator('.thumb').count()) === 3, 'undo restores the page list')

  // Re-add a blank page and draw text on it so blank-page export is covered.
  await page.locator('.thumb').nth(2).click()
  await page.waitForTimeout(400)
  await page.click('.sidebar-head button[title^="Add a blank page"]')
  await page.waitForTimeout(600)
  await page.locator('.thumb').nth(3).click()
  await page.waitForTimeout(700)
  const blankBox = await pageBox(3)
  await page.click('.tool[title^="Text"]')
  await page.mouse.click(blankBox.x + 80, blankBox.y + 100)
  await page.keyboard.type('Blank page text')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)


  // --------------------------------------------------------------- export
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('button:has-text("Save PDF")'),
  ])
  const exportedPath = path.join(OUT_DIR, 'realpdf-exported.pdf')
  await download.saveAs(exportedPath)
  const exportedSize = fs.statSync(exportedPath).size
  check(exportedSize > 3000, `exported PDF written (${exportedSize} bytes)`)

  // ------------------------------------------------- verify exported file
  const page2 = await context.newPage()
  const page2Errors = []
  page2.on('pageerror', (error) => page2Errors.push(String(error)))
  await page2.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page2.waitForSelector('.empty-card')
  const base64 = fs.readFileSync(exportedPath).toString('base64')
  await page2.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    const file = new File([bytes], 'exported.pdf', { type: 'application/pdf' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const input = document.querySelector('#open-pdf-input')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, base64)
  await page2.waitForSelector('.page canvas.page-base', { timeout: 20000 })
  await page2.waitForTimeout(1200)
  await page2.click('button.zoom-label')
  await page2.waitForTimeout(300)
  check((await page2.locator('.thumb').count()) === 4, 'exported PDF reopens with 4 pages')

  const exportedPixels = await page2.evaluate(() => {
    const canvas = document.querySelector('.page canvas.page-base')
    const ctx = canvas.getContext('2d')
    const rect = canvas.getBoundingClientRect()
    const scale = canvas.width / rect.width
    const sample = (x, y) => Array.from(ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data)
    const darkCount = (x, y, w, h) => {
      const data = ctx.getImageData(
        Math.round(x * scale),
        Math.round(y * scale),
        Math.round(w * scale),
        Math.round(h * scale),
      ).data
      let count = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 200 && data[i + 1] < 200 && data[i + 2] < 200) count += 1
      }
      return count
    }
    return {
      rect: sample(120, 660),
      textDark: darkCount(112, 455, 200, 30),
      highlight: sample(240, 461),
      image: sample(237, 391),
      background: sample(540, 40),
    }
  })
  check(isDark(exportedPixels.rect), `exported PDF shows the rectangle (pixel ${exportedPixels.rect.join(',')})`)
  check(exportedPixels.textDark > 5, `exported PDF shows the text (${exportedPixels.textDark} dark pixels)`)
  check(
    exportedPixels.highlight[0] > 240 &&
      exportedPixels.highlight[1] > 215 &&
      exportedPixels.highlight[2] < 210 &&
      exportedPixels.highlight[2] < exportedPixels.highlight[1] - 40,
    `exported PDF shows a translucent yellow highlight (pixel ${exportedPixels.highlight.join(',')})`,
  )
  check(isReddish(exportedPixels.image), `exported PDF shows the image (pixel ${exportedPixels.image.join(',')})`)
  check(
    exportedPixels.background[0] > 240 && exportedPixels.background[1] > 240,
    'exported PDF page background is still white',
  )
  // Page 2 annotations after export.
  await page2.locator('.thumb').nth(1).click()
  await page2.waitForTimeout(900)
  await page2.click('button.zoom-label')
  await page2.waitForTimeout(300)
  const exportedEllipse = await page2.evaluate(() => {
    const host = document.querySelector('.page[data-page-index="1"]')
    const canvas = host.querySelector('canvas.page-base')
    const rect = canvas.getBoundingClientRect()
    const scale = canvas.width / rect.width
    const ctx = canvas.getContext('2d')
    const data = ctx.getImageData(Math.round(150 * scale), Math.round(450 * scale), 1, 1).data
    return [data[0], data[1], data[2], data[3]]
  })
  check(isDark(exportedEllipse), `exported PDF shows page 2 ellipse (pixel ${exportedEllipse.join(',')})`)

  // Blank page 4 text after export.
  await page2.locator('.thumb').nth(3).click()
  await page2.waitForTimeout(900)
  const blankExport = await page2.evaluate(() => {
    const host = document.querySelector('.page[data-page-index="3"]')
    if (!host) return { dark: -1, white: false }
    const base = host.querySelector('canvas.page-base')
    const overlayRect = host.getBoundingClientRect()
    const canvas = base.width > 2 ? base : host.querySelector('canvas.page-base')
    const rect = canvas.getBoundingClientRect()
    const scale = canvas.width / rect.width || 1
    const ctx = canvas.getContext('2d')
    let dark = 0
    const data = ctx.getImageData(
      Math.max(0, Math.round(72 * scale)),
      Math.max(0, Math.round(88 * scale)),
      Math.round(200 * scale),
      Math.round(30 * scale),
    ).data
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 200 && data[i + 1] < 200 && data[i + 2] < 200) dark += 1
    }
    const corner = ctx.getImageData(5, 5, 1, 1).data
    return { dark, white: corner[0] > 240 && corner[1] > 240 && corner[2] > 240, overlayRect: overlayRect.width }
  })
  check(blankExport.dark > 5, `exported PDF shows text on the blank page (${blankExport.dark} dark pixels)`)
  check(blankExport.white, 'exported blank page has a white background')

  check(page2Errors.length === 0, `no page errors while re-opening export (${page2Errors.join('; ')})`)

  // ------------------------------------------- standard (non-embedded) fonts
  const standardFontPath = path.join(OUT_DIR, 'standard-font.pdf')
  fs.writeFileSync(standardFontPath, buildStandardFontPdf())
  const page3 = await context.newPage()
  const fontWarnings = []
  page3.on('console', (message) => {
    const text = message.text()
    if (/standard font|standardFontData/i.test(text)) fontWarnings.push(text)
  })
  page3.on('pageerror', (error) => pageErrors.push(`standard-font: ${error}`))
  await page3.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page3.waitForSelector('.empty-card')
  const fontBase64 = fs.readFileSync(standardFontPath).toString('base64')
  await page3.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    const file = new File([bytes], 'standard-font.pdf', { type: 'application/pdf' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const input = document.querySelector('#open-pdf-input')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, fontBase64)
  await page3.waitForSelector('.page canvas.page-base', { timeout: 20000 })
  await page3.waitForTimeout(1500)
  await page3.click('button.zoom-label')
  await page3.waitForTimeout(400)
  const fontPixels = await page3.evaluate(() => {
    const canvas = document.querySelector('.page canvas.page-base')
    const ctx = canvas.getContext('2d')
    const rect = canvas.getBoundingClientRect()
    const scale = canvas.width / rect.width
    const data = ctx.getImageData(
      Math.round(35 * scale),
      Math.round(70 * scale),
      Math.round(330 * scale),
      Math.round(45 * scale),
    ).data
    let dark = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 180 && data[i + 1] < 180 && data[i + 2] < 180) dark += 1
    }
    return dark
  })
  check(fontPixels > 20, `non-embedded standard font rendered (${fontPixels} dark pixels)`)
  check(fontWarnings.length === 0, `no standard font asset warnings (${fontWarnings.join(' | ')})`)

  if (pageErrors.length) {
    failures.push(`FAIL - page errors during editing: ${pageErrors.join(' | ')}`)
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
