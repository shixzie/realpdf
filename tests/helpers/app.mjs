import fs from 'node:fs'
import { expect } from 'vitest'
import { chromium } from 'playwright'
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

/** The URL the tests drive; the global setup starts a dev server when unset. */
export function appUrl() {
  return process.env.APP_URL ?? 'http://127.0.0.1:5173/'
}

/** Soft assertion: records a failure but keeps the flow running. */
export function check(condition, message) {
  expect.soft(Boolean(condition), message).toBe(true)
}

/** Launches a browser, a page and error collection for one suite. */
export async function launchApp(options = {}) {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    acceptDownloads: true,
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console.error: ${message.text()}`)
  })
  return { browser, context, page, pageErrors }
}

export async function gotoHome(page) {
  await page.goto(appUrl(), { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.empty-card')
}

/** Opens a local PDF through the app's file input. */
export async function openPdf(page, filePath, options = {}) {
  const base64 = fs.readFileSync(filePath).toString('base64')
  await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    const file = new File([bytes], 'document.pdf', { type: 'application/pdf' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    const input = document.querySelector('#open-pdf-input') || document.querySelector('input[accept*="pdf"]')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, base64)
  await page.waitForSelector('.page canvas.page-base', { timeout: 20000 })
  await page.waitForTimeout(options.settle ?? 1200)
  // Normalize zoom so page-local coordinates are PDF points.
  if (options.resetZoom !== false) {
    await page.click('button.zoom-label')
    await page.waitForTimeout(300)
  }
}

export function pageBox(page, index = 0) {
  return page.locator(`.page[data-page-index="${index}"]`).boundingBox()
}

/** Drags on a page at page-local coordinates (PDF points at zoom 1). */
export async function dragOnPage(page, from, to, index = 0) {
  const box = await pageBox(page, index)
  if (!box) throw new Error(`page ${index} not found`)
  await page.mouse.move(box.x + from.x, box.y + from.y)
  await page.mouse.down()
  await page.mouse.move(box.x + (from.x + to.x) / 2, box.y + (from.y + to.y) / 2, { steps: 6 })
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(220)
}

/** Clicks Save PDF and stores the download. */
export async function savePdf(page, filePath) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('button:has-text("Save PDF")'),
  ])
  await download.saveAs(filePath)
  return filePath
}

/**
 * Reads pixel statistics from a page-local region of one canvas. `selector`
 * is resolved inside the page at `index`; the defaults target its overlay.
 */
export async function pixelStats(page, local, options = {}) {
  const selector = options.selector ?? '.page-overlay canvas.lower-canvas'
  const index = options.index ?? 0
  return page.evaluate(
    ({ selector: canvasSelector, x, y, w, h, index: pageIndex }) => {
      const host = document.querySelector(`.page[data-page-index="${pageIndex}"]`)
      const canvas = host?.querySelector(canvasSelector)
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const scale = canvas.width / rect.width || 1
      const data = canvas
        .getContext('2d')
        .getImageData(
          Math.max(0, Math.round(x * scale)),
          Math.max(0, Math.round(y * scale)),
          Math.max(1, Math.round(w * scale)),
          Math.max(1, Math.round(h * scale)),
        ).data
      let red = 0
      let blue = 0
      let dark = 0
      let ink = 0
      let black = 0
      let opaque = 0
      let alpha = 0
      const bins = new Set()
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        const a = data[i + 3]
        if (a > alpha) alpha = a
        if (a <= 60) continue
        if (a > 100 && r > 120 && g < 120 && b < 120) red += 1
        if (a > 100 && b > 150 && r < 130 && g < 150) blue += 1
        if (r < 200 && g < 200 && b < 200) ink += 1
        if (a > 200) {
          opaque += 1
          if (r < 235 || g < 225 || b < 225) dark += 1
          if (r < 90 && g < 90 && b < 90) black += 1
        }
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        if (a > 200 && max > 60 && max - min > 50) {
          bins.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4))
        }
      }
      return { red, blue, dark, ink, black, opaque, alpha, saturatedBins: bins.size }
    },
    { selector, x: local.x, y: local.y, w: local.w, h: local.h, index },
  )
}

/** Reads the colour of one pixel from a page canvas. */
export async function pixelAt(page, local, options = {}) {
  const selector = options.selector ?? '.page-overlay canvas.lower-canvas'
  const index = options.index ?? 0
  return page.evaluate(
    ({ selector: canvasSelector, x, y, index: pageIndex }) => {
      const host = document.querySelector(`.page[data-page-index="${pageIndex}"]`)
      const canvas = host?.querySelector(canvasSelector)
      if (!canvas) return [0, 0, 0, 0]
      const rect = canvas.getBoundingClientRect()
      const scale = canvas.width / rect.width || 1
      const data = canvas
        .getContext('2d')
        .getImageData(Math.max(0, Math.round(x * scale)), Math.max(0, Math.round(y * scale)), 1, 1).data
      return [data[0], data[1], data[2], data[3]]
    },
    { selector, x: local.x, y: local.y, index },
  )
}

export function isDark(pixel) {
  return pixel[3] > 100 && pixel[0] < 200 && pixel[1] < 200 && pixel[2] < 200
}

export function isReddish(pixel) {
  return pixel[0] > 120 && pixel[1] < 120 && pixel[2] < 120
}

/** Opens a PDF in a fresh page and reads pixel statistics from it. */
export async function exportedPixelStats(context, filePath, local, options = {}) {
  const page = await context.newPage()
  try {
    await gotoHome(page)
    await openPdf(page, filePath)
    const stats = await pixelStats(page, local, { ...options, selector: options.selector ?? 'canvas.page-base' })
    if (!stats) throw new Error('exported page did not render')
    return stats
  } finally {
    await page.close()
  }
}

/** The text layer of a PDF, as pdf.js reads it back. */
export async function pdfText(filePath, options = {}) {
  const bytes = new Uint8Array(fs.readFileSync(filePath))
  const document = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise
  let text = ''
  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index)
    const content = await page.getTextContent()
    for (const item of content.items) text += `${item.str ?? ''}${options.itemSeparator ?? ''}`
    text += options.pageSeparator ?? ''
  }
  return text
}

/** Font entries (with whether a font program is embedded) of a PDF page. */
export async function pageFonts(filePath, pageIndex = 0) {
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
