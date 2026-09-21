/**
 * Records a product demo video (webm) with Playwright and captures still
 * screenshots. Requires the dev server on :5173.
 *   node scripts/demo.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
const VIDEO_DIR = '/tmp/opencode/demo-video'
fs.rmSync(VIDEO_DIR, { recursive: true, force: true })
fs.mkdirSync(VIDEO_DIR, { recursive: true })
fs.mkdirSync('docs', { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  acceptDownloads: true,
  recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 720 } },
})
const page = await context.newPage()
page.on('pageerror', (error) => console.log('[pageerror]', error.message))
page.on('download', async (download) => {
  const target = path.join('/tmp/opencode', `demo-${download.suggestedFilename()}`)
  await download.saveAs(target).catch(() => undefined)
})

const wait = (ms) => page.waitForTimeout(ms)

await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.empty-card')
await wait(1200)

// ------------------------------------------------------------ open document
const sample = fs.readFileSync('sample.pdf').toString('base64')
await page.evaluate(async (data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  const file = new File([bytes], 'quarterly-report.pdf', { type: 'application/pdf' })
  const dt = new DataTransfer()
  dt.items.add(file)
  const input = document.querySelector('#open-pdf-input')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}, sample)
await page.waitForSelector('.page canvas.page-base')
await wait(2200)
await page.click('button.zoom-label')
await wait(500)
const box = await page.locator('.page[data-page-index="0"]').boundingBox()

const drag = async (from, to, steps = 14, hold = 150) => {
  await page.mouse.move(box.x + from.x, box.y + from.y)
  await wait(60)
  await page.mouse.down()
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    await page.mouse.move(box.x + from.x + (to.x - from.x) * t, box.y + from.y + (to.y - from.y) * t)
  }
  await page.mouse.up()
  await wait(hold)
}

// --------------------------------------------------------------- highlight
await page.click('.tool[title^="Highlight"]')
await wait(350)
await drag({ x: 56, y: 447 }, { x: 470, y: 468 }, 18)

// --------------------------------------------------------------- rectangle
await page.click('.tool[title^="Rectangle"]')
await page.click('.options .swatch[title="#2563eb"]')
await wait(250)
await drag({ x: 360, y: 170 }, { x: 520, y: 250 })

// ------------------------------------------------------------------- arrow
await page.click('.tool[title^="Arrow"]')
await page.click('.options .swatch[title="#dc2626"]')
await wait(250)
await drag({ x: 350, y: 330 }, { x: 520, y: 265 })

// -------------------------------------------------------------------- text
await page.click('.tool[title^="Text"]')
await page.click('.options .swatch[title="#111827"]')
await wait(250)
await page.mouse.click(box.x + 62, box.y + 690)
await wait(250)
await page.keyboard.type('Approved — J.C. Alvarez', { delay: 45 })
await wait(400)
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
await wait(500)

// ------------------------------------------------------------------- image
await page.evaluate(async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 220
  canvas.height = 110
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#0ea5e9'
  ctx.fillRect(0, 0, 220, 110)
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 30px sans-serif'
  ctx.fillText('APPROVED', 22, 68)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  const file = new File([blob], 'stamp.png', { type: 'image/png' })
  const dt = new DataTransfer()
  dt.items.add(file)
  const input = document.querySelector('input[accept*="image/"]')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
})
await wait(900)
// drag the stamp into the signature box area
await drag({ x: 300, y: 421 }, { x: 180, y: 330 }, 12, 400)

// --------------------------------------------------------------- signature
await page.click('.tool[title^="Signature"]')
await page.waitForSelector('.signature-pad')
await wait(400)
const pad = await page.locator('.signature-pad').boundingBox()
await page.mouse.move(pad.x + 110, pad.y + 130)
await page.mouse.down()
const points = [
  [170, 80],
  [230, 160],
  [300, 70],
  [360, 150],
  [430, 90],
  [490, 140],
]
for (const [x, y] of points) {
  await page.mouse.move(pad.x + x, pad.y + y, { steps: 12 })
}
await page.mouse.up()
await wait(500)
await page.screenshot({ path: 'docs/signature.png' })
await page.click('button:has-text("Add signature")')
await wait(900)

// ------------------------------------------------------------- document tools
await page.click('button[title="Merge, split and convert documents"]')
await wait(500)
await page.setInputFiles('input[accept="application/pdf,.pdf"][multiple]', [
  path.resolve('sample.pdf'),
  path.resolve('sample.pdf'),
])
await wait(1000)
await page.screenshot({ path: 'docs/merge.png' })
await page.click('.tab:has-text("Split")')
await wait(800)
await page.fill('.text-input', '1-3,7-')
await wait(900)
await page.screenshot({ path: 'docs/split.png' })
await page.click('.tab:has-text("Convert")')
await wait(1300)
await page.screenshot({ path: 'docs/convert.png' })
await page.click('.modal-head .icon-button')
await wait(500)

// ---------------------------------------------------------------- save pdf
await page.click('.export-trigger')
await page.waitForSelector('.export-menu-item-pdf')
await page.click('.export-menu-item-pdf')
await wait(2600)

// -------------------------------------------------------------------- done
await page.screenshot({ path: 'docs/editor-final.png' })
await wait(1200)

const video = page.video()
await page.close()
const videoPath = await video.path()
console.log('video:', videoPath)
await context.close()
await browser.close()
