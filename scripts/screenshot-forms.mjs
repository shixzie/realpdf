import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const fixture = '/tmp/opencode/membership-fixture.pdf'
if (!fs.existsSync(fixture)) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([595, 842])
  page.drawText('Membership application', { x: 56, y: 770, size: 20, font, color: rgb(0.07, 0.09, 0.13) })
  const form = doc.getForm()
  const name = form.createTextField('full_name')
  name.addToPage(page, { x: 56, y: 690, width: 320, height: 26 })
  const email = form.createTextField('email')
  email.addToPage(page, { x: 56, y: 630, width: 320, height: 26 })
  const plan = form.createDropdown('plan')
  plan.addOptions(['Starter', 'Pro', 'Team'])
  plan.addToPage(page, { x: 56, y: 570, width: 200, height: 26 })
  const agree = form.createCheckBox('terms')
  agree.addToPage(page, { x: 56, y: 520, width: 20, height: 20 })
  fs.writeFileSync(fixture, await doc.save())
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto('http://127.0.0.1:8787/', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.empty-card')
const b64 = fs.readFileSync(fixture).toString('base64')
await page.evaluate(async (data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  const file = new File([bytes], 'membership.pdf', { type: 'application/pdf' })
  const dt = new DataTransfer(); dt.items.add(file)
  const input = document.querySelector('#open-pdf-input')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}, b64)
await page.waitForSelector('.page canvas.page-base')
await page.waitForTimeout(1200)
await page.click('button.zoom-label')
await page.waitForTimeout(400)
await page.click('button:has-text("Fill forms")')
await page.waitForSelector('.form-widget')
await page.waitForTimeout(400)
const inputs = page.locator('.forms-layer input.form-widget:not([type="checkbox"]):not([type="radio"])')
await inputs.nth(0).fill('Juan Carlos Alvarez')
await inputs.nth(1).fill('juan@nemphi.com')
await page.selectOption('.forms-layer select.form-widget', 'Pro')
await page.check('.forms-layer input[type="checkbox"]')
await page.waitForTimeout(400)
await page.screenshot({ path: 'docs/forms.png' })
await browser.close()
console.log('saved docs/forms.png')
