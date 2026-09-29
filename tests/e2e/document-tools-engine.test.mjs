import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { check, gotoHome, launchApp, openFileTools, openPdf, pdfText } from '../helpers/app.mjs'
import { OUT_DIR } from '../helpers/fixtures.mjs'
import { readZip } from '../../src/lib/zipRead.ts'

async function writeFixtures(page) {
  const transparentDataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 6
    const context = canvas.getContext('2d')
    context.fillStyle = 'rgba(220, 40, 40, 0.7)'
    context.fillRect(0, 0, 8, 6)
    context.clearRect(2, 2, 3, 2)
    return canvas.toDataURL('image/png')
  })
  const transparentPng = Buffer.from(transparentDataUrl.split(',')[1], 'base64')
  const imageDoc = await PDFDocument.create()
  const imagePage = imageDoc.addPage([240, 180])
  const image = await imageDoc.embedPng(transparentPng)
  imagePage.drawImage(image, { x: 30, y: 30, width: 80, height: 60 })
  const imagePath = path.join(OUT_DIR, 'document-tools-image.pdf')
  fs.writeFileSync(imagePath, await imageDoc.save())

  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const first = doc.addPage([420, 300])
  first.setCropBox(35, 25, 320, 220)
  first.drawRectangle({ x: 40, y: 35, width: 80, height: 40, color: rgb(0.9, 0.1, 0.1) })
  first.drawText('hidden text', { x: 50, y: 180, size: 18, font })
  first.setRotation({ type: 'degrees', angle: 90 })
  const second = doc.addPage([420, 300])
  second.setCropBox(35, 25, 320, 220)
  second.drawRectangle({ x: 180, y: 100, width: 60, height: 50, color: rgb(0.1, 0.2, 0.9) })
  const basePath = path.join(OUT_DIR, 'document-tools-base.pdf')
  fs.writeFileSync(basePath, await doc.save())
  return { imagePath, basePath }
}

async function chooseTool(page, name) {
  await page.click(`.document-tool-card:has-text("${name}")`)
  await page.waitForSelector('.document-tool-panel')
}

async function downloadResult(page, filePath) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('.tool-result button:has-text("Download")'),
  ])
  await download.saveAs(filePath)
}

async function waitForResult(page) {
  await page.waitForSelector('.tool-result, [role="alert"]', { timeout: 30000 })
  if (await page.locator('[role="alert"]').count()) throw new Error(await page.locator('[role="alert"]').innerText())
}

describe('document tools through the editor UI', () => {
  let app
  let fixtures

  beforeAll(async () => {
    app = await launchApp({ viewport: { width: 1500, height: 1000 } })
    fixtures = await writeFixtures(app.page)
  })

  afterAll(async () => {
    await app?.browser.close()
  })

  it('extracts the embedded transparent image as a PNG in a ZIP', async () => {
    const { page } = app
    await gotoHome(page)
    await openPdf(page, fixtures.imagePath)
    await openFileTools(page, 'More PDF tools')
    await chooseTool(page, 'Extract PDF images')
    await page.click('button:has-text("Create result")')
    await waitForResult(page)
    const resultPath = path.join(OUT_DIR, 'document-tools-images.zip')
    await downloadResult(page, resultPath)
    const entries = readZip(new Uint8Array(fs.readFileSync(resultPath)))
    const extracted = entries.get('image-001.png')
    check(Boolean(extracted && extracted.length > 20), 'image extraction produced a nonempty PNG')
    check(Boolean(extracted && extracted[0] === 0x89 && extracted[1] === 0x50), 'ZIP contains a PNG signature')
    const transparent = await page.evaluate(async (base64) => {
      const image = new Image()
      image.src = `data:image/png;base64,${base64}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      return context.getImageData(0, 0, 1, 1).data[3]
    }, Buffer.from(extracted ?? []).toString('base64'))
    check(transparent < 255, `embedded alpha survives PNG extraction (${transparent})`)
  })

  it('watermarks and rasterizes a cropped rotated document', async () => {
    const { page } = app
    await gotoHome(page)
    await openPdf(page, fixtures.basePath)
    await openFileTools(page, 'More PDF tools')
    await chooseTool(page, 'Add watermark')
    await page.fill('label.advanced-field:has-text("Watermark text") input', 'MARK')
    await page.click('button:has-text("Create result")')
    await waitForResult(page)
    const watermarkedPath = path.join(OUT_DIR, 'document-tools-watermarked.pdf')
    await downloadResult(page, watermarkedPath)
    check((await pdfText(watermarkedPath)).includes('MARK'), 'watermark text is present in exported PDF')

    await page.click('button:has-text("All tools")')
    await chooseTool(page, 'Rasterize PDF')
    await page.click('button:has-text("Create result")')
    await waitForResult(page)
    const rasterPath = path.join(OUT_DIR, 'document-tools-raster.pdf')
    await downloadResult(page, rasterPath)
    check(!(await pdfText(rasterPath)).includes('hidden text'), 'raster output removes selectable hidden text')
  })

  it('compares identical and changed documents through the compare tool', async () => {
    const { page } = app
    await gotoHome(page)
    await openPdf(page, fixtures.imagePath)
    await openFileTools(page, 'More PDF tools')
    await chooseTool(page, 'Add watermark')
    await page.fill('label.advanced-field:has-text("Watermark text") input', 'DIFF')
    await page.click('button:has-text("Create result")')
    await waitForResult(page)
    const changedPath = path.join(OUT_DIR, 'document-tools-changed.pdf')
    await downloadResult(page, changedPath)

    await page.click('button:has-text("All tools")')
    await chooseTool(page, 'Compare PDFs')
    await page.setInputFiles('label.advanced-field:has-text("PDF to compare") input[type="file"]', fixtures.imagePath)
    await page.waitForTimeout(200)
    await page.click('button:has-text("Create result")')
    await waitForResult(page)
    const identicalReport = await page.locator('.tool-result').innerText()
    check(identicalReport.includes('0 of 1'), `identical comparison reports zero changed pages (${identicalReport})`)

    await page.click('button:has-text("All tools")')
    await chooseTool(page, 'Compare PDFs')
    await page.setInputFiles('label.advanced-field:has-text("PDF to compare") input[type="file"]', changedPath)
    await page.waitForTimeout(200)
    await page.click('button:has-text("Create result")')
    await waitForResult(page)
    const changedReport = await page.locator('.tool-result').innerText()
    check(changedReport.includes('1 of 1'), `changed comparison reports one changed page (${changedReport})`)
  })
})
