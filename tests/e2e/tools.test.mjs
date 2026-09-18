/**
 * Tools suite: merge, split, conversions and form filling, verified through
 * the exported files.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { check, gotoHome, launchApp, openPdf, pdfText } from '../helpers/app.mjs'
import { OUT_DIR, SAMPLE_PDF, buildFormPdf } from '../helpers/fixtures.mjs'

describe('document tools', () => {
  let app

  beforeAll(async () => {
    app = await launchApp({ viewport: { width: 1500, height: 1000 } })
  })

  afterAll(async () => {
    await app?.browser.close()
  })

  it('merges, splits, converts and fills forms', async () => {
    const { page, context, pageErrors } = app

    const openTools = async (tab) => {
      const already = await page.locator('.modal-wide').count()
      if (!already) await page.click('button[title="Merge, split and convert documents"]')
      await page.click(`.tab:has-text("${tab}")`)
    }

    await gotoHome(page)
    await openPdf(page, SAMPLE_PDF, { resetZoom: false })

    // ------------------------------------------------------------- merge
    await openTools('Merge')
    await page.uncheck('.tools-body .check input[type="checkbox"]')
    await page.setInputFiles('input[accept="application/pdf,.pdf"][multiple]', [SAMPLE_PDF, SAMPLE_PDF])
    await page.waitForTimeout(400)
    check((await page.locator('.source-item').count()) >= 2, 'merge lists the selected files')
    await page.click('button:has-text("Merge & open")')
    await page.waitForTimeout(1600)
    check((await page.locator('.thumb').count()) === 6, 'merged document has 6 pages')

    // ------------------------------------------------------------- split
    await openTools('Split')
    await page.fill('.text-input', '1,3')
    await page.click('button:has-text("Extract & open")')
    await page.waitForTimeout(1600)
    check((await page.locator('.thumb').count()) === 2, 'split range keeps 2 pages')

    // --------------------------------------------------- pdf -> png
    await openTools('Convert')
    const [pngDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('button:has-text("Current page")'),
    ])
    const pngPath = path.join(OUT_DIR, 'converted-page.png')
    await pngDownload.saveAs(pngPath)
    const png = fs.readFileSync(pngPath)
    check(
      png.length > 1000 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47,
      `PDF → PNG produced a valid image (${png.length} bytes)`,
    )

    // --------------------------------------------------- pdf -> text
    const txtPath = path.join(OUT_DIR, 'converted.txt')
    const [txtDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('button:has-text("Download .txt")'),
    ])
    await txtDownload.saveAs(txtPath)
    check(
      fs.readFileSync(txtPath, 'utf8').includes('RealPDF sample document'),
      'PDF → text contains the document text',
    )

    // --------------------------------------------------- images -> pdf
    const pixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR42mP8z8BQz0AEYBxVSF+F/1GFA6pwUAFjKmYgWwAAtBwF/0kzR6YAAAAASUVORK5CYII=',
      'base64',
    )
    const pixelPath = path.join(OUT_DIR, 'pixel.png')
    fs.writeFileSync(pixelPath, pixel)
    await page.setInputFiles('input[accept^="image/png"][multiple]', pixelPath)
    await page.waitForTimeout(400)
    check((await page.locator('.source-item').count()) === 1, 'images → PDF lists the added image')
    await page.click('button:has-text("Create PDF & open")')
    await page.waitForTimeout(1600)
    check((await page.locator('.thumb').count()) === 1, 'images → PDF opened a one-page document')

    // --------------------------------------------------- text -> pdf
    await openTools('Convert')
    await page.fill('.text-area', 'Generated from plain text.\nSecond line.')
    await page.click('.tool-block:has-text("Text → PDF") button:has-text("Create PDF & open")')
    await page.waitForTimeout(1600)
    check((await page.locator('.thumb').count()) === 1, 'text → PDF opened a one-page document')

    // ------------------------------------------------------- form filling
    const formFixture = await buildFormPdf()
    const page2 = await context.newPage()
    page2.on('pageerror', (error) => pageErrors.push(`forms: ${error}`))
    await gotoHome(page2)
    await openPdf(page2, formFixture, { settle: 900, resetZoom: false })
    await page2.waitForSelector('button:has-text("Fill forms")', { timeout: 10000 })
    check(true, 'form detection exposes the Fill forms button')
    await page2.click('button:has-text("Fill forms")')
    await page2.waitForSelector('.form-widget', { timeout: 10000 })
    await page2.waitForTimeout(300)
    check(
      (await page2.locator('.form-widget').count()) === 3,
      'form overlay shows text, checkbox and dropdown widgets',
    )
    await page2.fill('.forms-layer input.form-widget:not([type="checkbox"]):not([type="radio"])', 'Ada Lovelace')
    await page2.check('.forms-layer input[type="checkbox"]')
    await page2.selectOption('.forms-layer select.form-widget', 'Green')
    await page2.waitForTimeout(200)
    const [formDownload] = await Promise.all([
      page2.waitForEvent('download', { timeout: 30000 }),
      page2.click('button:has-text("Save filled PDF")'),
    ])
    const filledPath = path.join(OUT_DIR, 'form-filled.pdf')
    await formDownload.saveAs(filledPath)
    const filledText = await pdfText(filledPath, { itemSeparator: ' ' })
    check(filledText.includes('Ada Lovelace'), 'filled text field appears in the exported PDF')
    check(filledText.includes('Green'), 'selected dropdown value appears in the exported PDF')
    check(fs.statSync(filledPath).size > 1000, 'filled PDF has content')
    await page2.close()

    check(pageErrors.length === 0, `no browser errors (${pageErrors.slice(0, 3).join(' | ')})`)
  })
})
