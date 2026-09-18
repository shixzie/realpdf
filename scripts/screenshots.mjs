/** Captures README screenshots. Requires the dev server on :5173. */
import fs from 'node:fs'
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } })
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.empty-card')
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
const box = await page.locator('.page[data-page-index="0"]').boundingBox()

async function drag(from, to, steps = 10) {
  await page.mouse.move(box.x + from.x, box.y + from.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    await page.mouse.move(box.x + from.x + (to.x - from.x) * t, box.y + from.y + (to.y - from.y) * t)
  }
  await page.mouse.up()
  await page.waitForTimeout(150)
}

await page.click('.tool[title^="Highlight"]')
await drag({ x: 56, y: 447 }, { x: 470, y: 468 })
await page.click('.tool[title^="Rectangle"]')
await page.click('.options .swatch[title="#2563eb"]')
await drag({ x: 350, y: 160 }, { x: 525, y: 240 })
await page.click('.tool[title^="Arrow"]')
await page.click('.options .swatch[title="#dc2626"]')
await drag({ x: 350, y: 320 }, { x: 520, y: 260 })
await page.click('.tool[title^="Text"]')
await page.click('.options .swatch[title="#111827"]')
await page.mouse.click(box.x + 62, box.y + 610)
await page.keyboard.type('Reviewed and approved — J.C.')
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
await page.waitForTimeout(600)
await page.screenshot({ path: 'docs/editor.png' })

await page.click('button[title="Merge, split and convert documents"]')
await page.waitForTimeout(400)
await page.screenshot({ path: 'docs/tools.png' })
await browser.close()
console.log('saved docs/editor.png and docs/tools.png')
