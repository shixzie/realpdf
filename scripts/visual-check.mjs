/**
 * Visual fidelity check: draws one of every annotation type, exports, then
 * screenshots the editor canvas and the exported page render for comparison.
 * Run: node scripts/visual-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const OUT = '/tmp/opencode'
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.empty-card')
const base64 = fs.readFileSync('sample.pdf').toString('base64')
await page.evaluate(async (data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  const file = new File([bytes], 'sample.pdf', { type: 'application/pdf' })
  const dt = new DataTransfer()
  dt.items.add(file)
  const input = document.querySelector('#open-pdf-input')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}, base64)
await page.waitForSelector('.page canvas.page-base')
await page.waitForTimeout(1200)
await page.click('button.zoom-label')
await page.waitForTimeout(300)

async function box() {
  return page.locator('.page').first().boundingBox()
}

async function drag(from, to, options = {}) {
  const b = await box()
  await page.mouse.move(b.x + from.x, b.y + from.y)
  await page.mouse.down()
  const steps = options.steps ?? 10
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    await page.mouse.move(b.x + from.x + (to.x - from.x) * t, b.y + from.y + (to.y - from.y) * t)
  }
  await page.mouse.up()
  await page.waitForTimeout(180)
}

// Pen squiggle
await page.click('.tool[title^="Draw"]')
await page.click('.options .swatch[title="#2563eb"]')
await drag({ x: 80, y: 200 }, { x: 260, y: 240 }, { steps: 24 })

// Highlighter over body text
await page.click('.tool[title^="Highlight"]')
await drag({ x: 60, y: 452 }, { x: 500, y: 470 })

// Ellipse
await page.click('.tool[title^="Ellipse"]')
await page.click('.options .swatch[title="#16a34a"]')
await drag({ x: 340, y: 180 }, { x: 520, y: 260 })

// Line
await page.click('.tool[title^="Line"]')
await page.click('.options .swatch[title="#ea580c"]')
await drag({ x: 340, y: 290 }, { x: 520, y: 340 })

// Arrow
await page.click('.tool[title^="Arrow"]')
await page.click('.options .swatch[title="#dc2626"]')
await drag({ x: 340, y: 360 }, { x: 520, y: 300 })

// Whiteout + text on top
await page.click('.tool[title^="Cover"]')
await drag({ x: 60, y: 620 }, { x: 300, y: 655 })
await page.click('.tool[title^="Text"]')
let b = await box()
await page.mouse.click(b.x + 66, b.y + 626)
await page.keyboard.type('Replacement text')
await page.keyboard.press('Escape')

// Text with rotation + font size for baseline/rotation fidelity
await page.click('.tool[title^="Text"]')
await page.selectOption('.options select', 'Times New Roman')
b = await box()
await page.mouse.click(b.x + 60, b.y + 700)
await page.keyboard.type('Times text')
await page.keyboard.press('Escape')
await page.waitForTimeout(400)

const beforeExport = await page.evaluate(() => {
  const state = window.__realpdf.useStore.getState()
  return {
    stored: state.pages[0].annotations.objects.map((o) => ({ type: o.type, kind: o.data?.kind, text: o.text })),
    live: (() => {
      const c = window.__realpdf.getCanvas(state.currentPageId)
      return c ? c.getObjects().map((o) => ({ type: o.type, kind: o.data?.kind, text: o.text })) : null
    })(),
  }
})
console.log('before export:', JSON.stringify(beforeExport, null, 1))

const editorShot = path.join(OUT, 'editor-page.png')
await page.locator('.page').first().screenshot({ path: editorShot })

const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 30000 }),
  page.click('button:has-text("Save PDF")'),
])
const exported = path.join(OUT, 'visual-exported.pdf')
await download.saveAs(exported)

const page2 = await context.newPage()
page2.on('pageerror', (error) => errors.push(`reopen: ${error}`))
await page2.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' })
await page2.waitForSelector('.empty-card')
const b64 = fs.readFileSync(exported).toString('base64')
await page2.evaluate(async (data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  const file = new File([bytes], 'exported.pdf', { type: 'application/pdf' })
  const dt = new DataTransfer()
  dt.items.add(file)
  const input = document.querySelector('#open-pdf-input')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}, b64)
await page2.waitForSelector('.page canvas.page-base')
await page2.waitForTimeout(1400)
await page2.click('button.zoom-label')
await page2.waitForTimeout(400)
const exportedShot = path.join(OUT, 'exported-page.png')
await page2.locator('.page').first().screenshot({ path: exportedShot })

console.log('editor screenshot:', editorShot)
console.log('exported screenshot:', exportedShot)
console.log('pdf:', exported, fs.statSync(exported).size, 'bytes')
console.log('errors:', errors.length ? errors.join(' | ') : 'none')
await browser.close()
process.exit(errors.length ? 1 : 0)
