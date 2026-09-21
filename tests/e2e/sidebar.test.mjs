/**
 * Sidebar suite: per-page actions. The download button next to delete must
 * export that page — with its annotations — as an image.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { check, dragOnPage, gotoHome, launchApp, openPdf } from '../helpers/app.mjs'
import { OUT_DIR, SAMPLE_PDF } from '../helpers/fixtures.mjs'

describe('page sidebar', () => {
  let app

  beforeAll(async () => {
    app = await launchApp()
  })

  afterAll(async () => {
    await app?.browser.close()
  })

  it('downloads a single page as an image from the sidebar', async () => {
    const { page, pageErrors } = app

    await gotoHome(page)
    await openPdf(page, SAMPLE_PDF)

    // Mark page 2 so the downloaded image proves the right page was exported.
    await page.locator('.thumb').nth(1).click()
    await page.waitForTimeout(700)
    await page.click('.tool[title^="Rectangle"]')
    await dragOnPage(page, { x: 120, y: 620 }, { x: 330, y: 700 }, 1)

    const thumb = page.locator('.thumb').nth(1)
    await thumb.hover()
    const button = thumb.locator('.thumb-download')
    check(await button.isVisible(), 'download button appears beside delete on hover')

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      button.click(),
    ])
    const name = download.suggestedFilename()
    check(/page-2\.png$/.test(name), `file name targets page 2 (${name})`)
    const pngPath = path.join(OUT_DIR, 'sidebar-page-2.png')
    await download.saveAs(pngPath)
    const png = fs.readFileSync(pngPath)
    check(png.length > 1000, `page image written (${png.length} bytes)`)
    check(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47, 'downloaded page is a PNG')
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    check(width === 1190 && height === 1684, `page rendered at 2x (${width}×${height})`)

    // The rectangle drawn on page 2 must be visible in the downloaded image.
    const ink = await page.evaluate(async (data) => {
      const image = new Image()
      image.src = `data:image/png;base64,${data}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(230, 1230, 440, 180).data
      let dark = 0
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] > 100 && pixels[i] < 200 && pixels[i + 1] < 200 && pixels[i + 2] < 200) dark += 1
      }
      return dark
    }, png.toString('base64'))
    check(ink > 20, `downloaded image contains the page 2 annotation (${ink} dark pixels)`)

    check(pageErrors.length === 0, `no browser errors (${pageErrors.join(' | ')})`)
  })
})
