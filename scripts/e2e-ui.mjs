/**
 * UI suite: light/dark theme, homepage tool cards, signature upload and the
 * Ko-fi support button. Requires the dev server on :5173.
 *   node scripts/e2e-ui.mjs
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
    const file = new File([bytes], 'sample.pdf', { type: 'application/pdf' })
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

  // ------------------------------------------------------------ theme
  const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme)
  check(initialTheme === 'dark' || initialTheme === 'light', `a theme is applied (${initialTheme})`)
  await page.click('button[aria-label="Toggle color theme"]')
  await page.waitForTimeout(300)
  const toggledTheme = await page.evaluate(() => document.documentElement.dataset.theme)
  check(toggledTheme !== initialTheme, `theme toggle switches (${initialTheme} → ${toggledTheme})`)
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  check(
    toggledTheme === 'light' ? background !== 'rgb(11, 15, 20)' : background === 'rgb(11, 15, 20)',
    `body background follows the theme (${background})`,
  )
  await page.screenshot({ path: 'docs/home-light.png' })
  await page.click('button[aria-label="Toggle color theme"]')
  await page.waitForTimeout(200)

  // ------------------------------------------------- homepage tool cards
  check((await page.locator('.home-tool').count()) === 5, 'homepage shows five tool cards')
  const mergeCard = page.locator('.home-tool:has-text("Merge PDFs")')
  await mergeCard.click()
  await page.waitForSelector('.modal-wide')
  check(
    (await page.locator('.tab.is-active').innerText()).includes('Merge'),
    'Merge card opens the tools modal on the Merge tab',
  )
  await page.click('.modal-head .icon-button')
  await page.waitForTimeout(200)

  const splitCard = page.locator('.home-tool:has-text("Split PDF")')
  await splitCard.click()
  await loadSample()
  await page.waitForSelector('.modal-wide', { timeout: 10000 })
  check(
    (await page.locator('.tab.is-active').innerText()).includes('Split'),
    'Split card opens the file picker, then the Split tab',
  )
  await page.click('.modal-head .icon-button')
  await page.waitForTimeout(200)

  // -------------------------------------------------- signature upload
  // A drawn-looking signature on a white background, as a photo would be.
  await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 420
    canvas.height = 160
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fdfdfb'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#1a2740'
    ctx.lineWidth = 5
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(40, 110)
    ctx.bezierCurveTo(90, 30, 140, 150, 190, 70)
    ctx.bezierCurveTo(230, 20, 280, 140, 340, 80)
    ctx.stroke()
    window.__signatureDataUrl = canvas.toDataURL('image/png')
  })
  await page.click('.tool[title^="Signature"]')
  await page.waitForSelector('.signature-pad')
  check((await page.locator('.segmented button:has-text("Upload image")').count()) === 1, 'signature modal offers image upload')
  await page.click('.segmented button:has-text("Upload image")')
  await page.waitForTimeout(200)
  const uploadBase64 = await page.evaluate(() => window.__signatureDataUrl.split(',')[1])
  const uploadPath = path.join(OUT, 'signature-upload.png')
  fs.writeFileSync(uploadPath, Buffer.from(uploadBase64, 'base64'))
  await page.setInputFiles('.signature-upload input[type="file"]', uploadPath)
  await page.waitForFunction(() => {
    const img = document.querySelector('.signature-preview')
    return Boolean(img && img.src.startsWith('data:image/png'))
  }, { timeout: 10000 })
  check(true, 'uploaded signature gets processed and previewed')
  await page.click('button:has-text("Add signature")')
  await page.waitForTimeout(900)
  const badge = await page.locator('.thumb-badge').first().innerText().catch(() => null)
  check(badge === '1', `uploaded signature inserted (page 1 annotation badge: ${badge})`)
  await page.click('button[title^="Undo"]')
  await page.waitForTimeout(400)

  // ------------------------------------------------------ kofi button
  const kofi = page.locator('a.button-kofi')
  check((await kofi.count()) === 1, 'Ko-fi support button is present next to Save PDF')
  check(
    (await kofi.getAttribute('href')) === 'https://ko-fi.com/shixzie',
    'Ko-fi button links to the support page',
  )
  const order = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('.topbar .button, .topbar .icon-button'))
    const labels = buttons.map((b) => (b.textContent || '').trim() || b.getAttribute('aria-label') || '')
    return labels
  })
  const kofiIndex = order.findIndex((label) => label.includes('Support'))
  const saveIndex = order.findIndex((label) => label.includes('Save PDF'))
  check(kofiIndex > -1 && saveIndex > -1 && kofiIndex < saveIndex, 'Ko-fi button sits beside (before) Save PDF')

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
