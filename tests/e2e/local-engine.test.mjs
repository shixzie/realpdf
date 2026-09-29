import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { appUrl, check, gotoHome, launchApp, openFileTools, openPdf, pdfText, savePdf } from '../helpers/app.mjs'
import { OUT_DIR, SAMPLE_PDF } from '../helpers/fixtures.mjs'

async function selectTool(page, title) {
  await openFileTools(page, 'More PDF tools')
  if (await page.locator('.tool-back').count()) await page.locator('.tool-back').click()
  await page.locator('.document-tool-card').filter({ has: page.getByText(title, { exact: true }) }).click()
}

async function resultFile(page, name) {
  await page.getByRole('button', { name: 'Create result', exact: true }).click()
  await page.waitForSelector('.tool-result', { timeout: 90000 })
  const downloaded = page.waitForEvent('download')
  await page.locator('.tool-result').getByRole('button', { name: 'Download', exact: true }).click()
  const file = path.join(OUT_DIR, name)
  await (await downloaded).saveAs(file)
  return file
}

describe('local PDF engines through the UI', () => {
  let app
  const external = []
  beforeAll(async () => {
    app = await launchApp()
    const origin = new URL(appUrl()).origin
    app.context.on('request', (request) => {
      if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request.url())
    })
  })
  afterAll(async () => { await app?.browser.close() })

  it('protects, unlocks, compresses, linearizes, and repairs without uploads', async () => {
    const { page } = app
    await gotoHome(page)
    await openPdf(page, SAMPLE_PDF, { resetZoom: false })
    await selectTool(page, 'Compress PDF')
    const compressed = await resultFile(page, 'engine-compressed.pdf')
    check((await pdfText(compressed)).includes('RealPDF sample document'), 'compression preserves text')
    await selectTool(page, 'Web optimize PDF')
    const optimized = await resultFile(page, 'engine-linearized.pdf')
    check(fs.readFileSync(optimized).subarray(0, 512).toString().includes('/Linearized'), 'web optimization produces a linearized PDF')
    await selectTool(page, 'Protect PDF')
    await page.getByLabel('Password', { exact: true }).fill('engine-test-password')
    await page.getByLabel('Confirm password').fill('engine-test-password')
    const protectedFile = await resultFile(page, 'engine-protected.pdf')
    check((await PDFDocument.load(fs.readFileSync(protectedFile), { ignoreEncryption: true })).isEncrypted, 'export is encrypted')
    await selectTool(page, 'Unlock PDF')
    await page.getByLabel('PDF file', { exact: true }).setInputFiles(protectedFile)
    await page.getByLabel('Password', { exact: true }).fill('wrong-password')
    await page.getByRole('button', { name: 'Create result', exact: true }).click()
    await page.waitForSelector('.document-tool-panel [role="alert"]')
    check(await page.locator('.tool-result').count() === 0, 'wrong password creates no output')
    await page.getByLabel('Password', { exact: true }).fill('engine-test-password')
    const unlocked = await resultFile(page, 'engine-unlocked.pdf')
    check((await pdfText(unlocked)).includes('RealPDF sample document'), 'unlock restores readable text')
    await page.locator('.modal-head button').click()
    page.once('dialog', (dialog) => dialog.accept('engine-test-password'))
    await openPdf(page, protectedFile, { resetZoom: false })
    const resaved = path.join(OUT_DIR, 'engine-protected-editable.pdf')
    await savePdf(page, resaved)
    check((await pdfText(resaved)).includes('RealPDF sample document'), 'password-protected files can be opened and exported without corrupt streams')
    const fixture = await PDFDocument.create()
    fixture.addPage().drawText('Recovered content')
    const damaged = Buffer.from(await fixture.save({ useObjectStreams: false })).toString('latin1').replace(/startxref\s+\d+/, 'startxref\n15')
    const damagedFile = path.join(OUT_DIR, 'engine-damaged.pdf')
    fs.writeFileSync(damagedFile, Buffer.from(damaged, 'latin1'))
    await selectTool(page, 'Repair PDF')
    await page.getByLabel('PDF file', { exact: true }).setInputFiles(damagedFile)
    const repaired = await resultFile(page, 'engine-repaired.pdf')
    check((await pdfText(repaired)).includes('Recovered content'), 'repair recovers text from an invalid cross-reference pointer')
    check(external.length === 0, 'security and optimization do not send external requests')
  })

  it('creates a searchable PDF from a scanned English page using local assets', async () => {
    const { page } = app
    await gotoHome(page)
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 1200
      canvas.height = 400
      const context = canvas.getContext('2d')
      context.fillStyle = 'white'
      context.fillRect(0, 0, 1200, 400)
      context.fillStyle = 'black'
      context.font = '72px Arial'
      context.fillText('Local OCR acceptance test', 48, 180)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    const fixture = await PDFDocument.create()
    const image = await fixture.embedPng(Buffer.from(png, 'base64'))
    fixture.addPage([600, 200]).drawImage(image, { width: 600, height: 200 })
    const scanned = path.join(OUT_DIR, 'engine-scanned.pdf')
    fs.writeFileSync(scanned, await fixture.save())
    check((await pdfText(scanned)).trim() === '', 'OCR input has no text layer')
    await openPdf(page, scanned, { resetZoom: false })
    await selectTool(page, 'Recognize text (OCR)')
    const recognized = await resultFile(page, 'engine-ocr.pdf')
    const text = await pdfText(recognized)
    check(/local/i.test(text) && /ocr/i.test(text) && /acceptance/i.test(text), `OCR result contains searchable words (${text})`)
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download recognized text' }).click()
    const output = path.join(OUT_DIR, 'engine-ocr.txt')
    await (await download).saveAs(output)
    check(/Local OCR acceptance/i.test(fs.readFileSync(output, 'utf8')), 'OCR also provides a text download')
    check(external.length === 0, 'OCR workers and language data load only from the app origin')
  })
})
