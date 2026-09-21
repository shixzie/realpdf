/** Captures warm light-mode screenshots (editor + library). */
import fs from 'node:fs'
import { chromium } from 'playwright'

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
await context.addInitScript(() => localStorage.setItem('realpdf-theme', 'light'))
const page = await context.newPage()
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.empty-card')
await page.screenshot({ path: 'docs/home-light.png' })

const b64 = fs.readFileSync('sample.pdf').toString('base64')
await page.evaluate(async (data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  const file = new File([bytes], 'quarterly-report.pdf', { type: 'application/pdf' })
  const dt = new DataTransfer(); dt.items.add(file)
  const input = document.querySelector('#open-pdf-input')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}, b64)
await page.waitForSelector('.page canvas.page-base')
await page.waitForTimeout(1400)
await page.click('button.zoom-label')
await page.waitForTimeout(400)
const box = await page.locator('.page[data-page-index="0"]').boundingBox()

async function drag(from, to, steps = 12) {
  await page.mouse.move(box.x + from.x, box.y + from.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    await page.mouse.move(box.x + from.x + (to.x - from.x) * t, box.y + from.y + (to.y - from.y) * t)
  }
  await page.mouse.up()
  await page.waitForTimeout(180)
}

await page.click('.tool[title^="Highlight"]')
await drag({ x: 56, y: 447 }, { x: 470, y: 468 })
await page.click('.tool[title^="Rectangle"]')
await page.click('.options .swatch[title="#2563eb"]')
await drag({ x: 350, y: 170 }, { x: 520, y: 250 })
await page.click('.tool[title^="Arrow"]')
await page.click('.options .swatch[title="#dc2626"]')
await drag({ x: 350, y: 330 }, { x: 520, y: 265 })
await page.click('.tool[title^="Text"]')
await page.click('.options .swatch[title="#111827"]')
await page.mouse.click(box.x + 62, box.y + 610)
await page.keyboard.type('Reviewed and approved — J.C.')
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
await page.screenshot({ path: 'docs/editor-light.png' })

// save once so the library has an entry with a thumbnail
await Promise.all([
  page.waitForEvent('download'),
  (async () => {
    await page.click('.export-trigger')
    await page.waitForSelector('.export-menu-item-pdf')
    await page.click('.export-menu-item-pdf')
  })(),
])
await page.waitForSelector('.toast:has-text("Saved your edited PDF")', { timeout: 30000 })
await page.waitForTimeout(600)
await page.click('button:has-text("Library")')
await page.waitForSelector('.library-item')
await page.waitForTimeout(500)
await page.screenshot({ path: 'docs/library.png' })
await browser.close()
console.log('saved docs/home-light.png, docs/editor-light.png, docs/library.png')
