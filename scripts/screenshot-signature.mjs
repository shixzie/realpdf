import fs from 'node:fs'
import { chromium } from 'playwright'


const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(() => localStorage.setItem('realpdf-theme', 'light'))
const page = await context.newPage()
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.empty-card')
const b64 = fs.readFileSync('sample.pdf').toString('base64')
await page.evaluate(async (data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  const file = new File([bytes], 'membership.pdf', { type: 'application/pdf' })
  const dt = new DataTransfer(); dt.items.add(file)
  const input = document.querySelector('#open-pdf-input')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}, b64)
await page.waitForSelector('.page canvas.page-base')
await page.waitForTimeout(1400)
await page.click('.tool[title^="Signature"]')
await page.waitForSelector('.signature-pad')
await page.click('.segmented button:has-text("Upload image")')
await page.setInputFiles('.signature-upload input[type="file"]', '/tmp/opencode/signature-photo.png')
await page.waitForTimeout(900)
await page.screenshot({ path: 'docs/signature-upload.png' })
await browser.close()
console.log('saved docs/signature-upload.png')
