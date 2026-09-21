/**
 * Editor suite: load the sample PDF, annotate with every tool, export through
 * the UI and verify the exported file by re-rendering it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  check,
  clickSavePdf,
  dragOnPage,
  gotoHome,
  isDark,
  isReddish,
  launchApp,
  openPdf,
  pageBox,
  pixelAt,
  pixelStats,
} from '../helpers/app.mjs'
import { OUT_DIR, SAMPLE_PDF, buildStandardFontPdf } from '../helpers/fixtures.mjs'

describe('editor', () => {
  let app

  beforeAll(async () => {
    app = await launchApp()
  })

  afterAll(async () => {
    await app?.browser.close()
  })

  it('annotates, exports and reopens the document', async () => {
    const { page, context, pageErrors } = app

    // ---------------------------------------------------------------- load
    await gotoHome(page)
    await openPdf(page, SAMPLE_PDF)
    check((await page.locator('.page').count()) >= 1, 'sample.pdf loaded and at least one page rendered')
    check((await page.locator('.thumb').count()) === 3, 'sidebar shows 3 thumbnails')

    // ------------------------------------------------------------ rectangle
    await page.click('.tool[title^="Rectangle"]')
    await dragOnPage(page, { x: 120, y: 620 }, { x: 330, y: 700 })
    check(
      (await page.locator('.page canvas.page-base').count()) > 0,
      'rectangle tool created an annotation without crashing',
    )
    const rectEdge = await pixelAt(page, { x: 120, y: 660 })
    check(isDark(rectEdge), `rectangle stroke visible on canvas (pixel ${rectEdge.join(',')})`)

    // --------------------------------------------------------------- text
    await page.click('.tool[title^="Text"]')
    const box = await pageBox(page)
    await page.mouse.click(box.x + 120, box.y + 470)
    await page.waitForTimeout(150)
    await page.keyboard.type('Reviewed by E2E')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(350)
    const textInk = (await pixelStats(page, { x: 112, y: 455, w: 200, h: 30 })).ink
    check(textInk > 5, `text annotation visible on canvas (${textInk} dark pixels)`)

    // --------------------------------------------------------- highlighter
    await page.click('.tool[title^="Highlight"]')
    await dragOnPage(page, { x: 60, y: 452 }, { x: 480, y: 470 })
    const highlightPixel = await pixelAt(page, { x: 240, y: 461 })
    check(
      highlightPixel[0] > 200 && highlightPixel[1] > 150 && highlightPixel[2] < 160,
      `highlighter paints a translucent yellow (pixel ${highlightPixel.join(',')})`,
    )
    await page.keyboard.press('Escape')

    // --------------------------------------------------------------- image
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 160
      canvas.height = 80
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#e11d48'
      ctx.fillRect(0, 0, 160, 80)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(40, 30, 80, 20)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
      const file = new File([blob], 'stamp.png', { type: 'image/png' })
      const transfer = new DataTransfer()
      transfer.items.add(file)
      const input = document.querySelector('input[accept*="image/"]')
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.waitForTimeout(600)
    const imagePixel = await pixelAt(page, { x: 237, y: 391 })
    check(isReddish(imagePixel), `image annotation visible on canvas (pixel ${imagePixel.join(',')})`)

    // ------------------------------------------------------- pen + eraser
    await page.click('.tool[title^="Draw"]')
    await dragOnPage(page, { x: 400, y: 545 }, { x: 520, y: 600 }, 0)
    const penInk = (await pixelStats(page, { x: 395, y: 535, w: 140, h: 80 })).ink
    check(penInk > 10, `pen stroke visible on canvas (${penInk} dark pixels)`)

    await page.click('.tool[title^="Erase annotation"]')
    const eraseBox = await pageBox(page)
    await page.mouse.click(eraseBox.x + 200, eraseBox.y + 660)
    await page.waitForTimeout(300)
    const erased = await pixelAt(page, { x: 120, y: 660 })
    check(!isDark(erased), 'eraser removed the rectangle annotation')
    await page.click('button[title^="Undo"]')
    await page.waitForTimeout(400)
    const restored = await pixelAt(page, { x: 120, y: 660 })
    check(isDark(restored), 'undo restored the erased rectangle')

    // -------------------------------------------------------- undo / redo
    await page.click('.tool[title^="Rectangle"]')
    await dragOnPage(page, { x: 150, y: 180 }, { x: 250, y: 230 }, 0)
    const drawn = await pixelAt(page, { x: 150, y: 205 })
    check(isDark(drawn), 'annotation drawn for undo/redo check')
    await page.click('button[title^="Undo"]')
    await page.waitForTimeout(450)
    const afterUndo = await pixelAt(page, { x: 150, y: 205 })
    check(!isDark(afterUndo), 'undo removes the annotation')
    await page.click('button[title^="Redo"]')
    await page.waitForTimeout(450)
    const afterRedo = await pixelAt(page, { x: 150, y: 205 })
    check(isDark(afterRedo), 'redo restores the annotation')

    // ----------------------------------------------------------- signature
    await page.click('.tool[title^="Signature"]')
    await page.waitForSelector('.signature-pad')
    const pad = await page.locator('.signature-pad').boundingBox()
    await page.mouse.move(pad.x + 90, pad.y + 120)
    await page.mouse.down()
    await page.mouse.move(pad.x + 160, pad.y + 70, { steps: 8 })
    await page.mouse.move(pad.x + 240, pad.y + 140, { steps: 8 })
    await page.mouse.move(pad.x + 330, pad.y + 80, { steps: 8 })
    await page.mouse.up()
    await page.click('button:has-text("Add signature")')
    await page.waitForTimeout(600)

    // ------------------------------------------------------------ undo/redo
    await page.click('button[title^="Undo"]')
    await page.waitForTimeout(300)
    await page.click('button[title^="Redo"]')
    await page.waitForTimeout(300)

    // ------------------------------------------- virtualization + page ops
    // Draw on page 2, scroll away, scroll back: the annotation must survive.
    await page.locator('.thumb').nth(1).click()
    await page.waitForTimeout(700)
    await page.click('.tool[title^="Ellipse"]')
    await dragOnPage(page, { x: 150, y: 400 }, { x: 300, y: 500 }, 1)
    const page2Ellipse = await pixelAt(page, { x: 150, y: 450 }, { index: 1 })
    check(isDark(page2Ellipse), `page 2 ellipse drawn (pixel ${page2Ellipse.join(',')})`)
    await page.locator('.thumb').nth(2).click()
    await page.waitForTimeout(700)
    await page.locator('.thumb').nth(1).click()
    await page.waitForTimeout(900)
    const page2AfterRemount = await pixelAt(page, { x: 150, y: 450 }, { index: 1 })
    check(isDark(page2AfterRemount), 'page 2 annotation survives remounting (virtualization)')

    // Move page 2 to the end and back, then add a blank page with text.
    await page.locator('.thumb').nth(1).dragTo(page.locator('.thumb').nth(2))
    await page.waitForTimeout(500)
    check((await page.locator('.thumb').count()) === 3, 'page reorder keeps 3 pages')
    await page.click('button[title^="Undo"]')
    await page.waitForTimeout(500)

    // ------------------------------------------------------- page add/delete
    await page.locator('.thumb').nth(2).click()
    await page.waitForTimeout(400)
    await page.click('.sidebar-head button[title^="Add a blank page"]')
    await page.waitForTimeout(400)
    check((await page.locator('.thumb').count()) === 4, 'adding a blank page updates the sidebar')
    await page.click('button[title^="Undo"]')
    await page.waitForTimeout(400)
    check((await page.locator('.thumb').count()) === 3, 'undo restores the page list')

    // Re-add a blank page and draw text on it so blank-page export is covered.
    await page.locator('.thumb').nth(2).click()
    await page.waitForTimeout(400)
    await page.click('.sidebar-head button[title^="Add a blank page"]')
    await page.waitForTimeout(600)
    await page.locator('.thumb').nth(3).click()
    await page.waitForTimeout(700)
    const blankBox = await pageBox(page, 3)
    await page.click('.tool[title^="Text"]')
    await page.mouse.click(blankBox.x + 80, blankBox.y + 100)
    await page.keyboard.type('Blank page text')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // --------------------------------------------------------------- export
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      clickSavePdf(page),
    ])
    const exportedPath = path.join(OUT_DIR, 'realpdf-exported.pdf')
    await download.saveAs(exportedPath)
    const exportedSize = fs.statSync(exportedPath).size
    check(exportedSize > 3000, `exported PDF written (${exportedSize} bytes)`)

    // ------------------------------------------------- verify exported file
    const page2 = await context.newPage()
    const page2Errors = []
    page2.on('pageerror', (error) => page2Errors.push(String(error)))
    await gotoHome(page2)
    await openPdf(page2, exportedPath)
    check((await page2.locator('.thumb').count()) === 4, 'exported PDF reopens with 4 pages')

    const exported = {
      rect: await pixelAt(page2, { x: 120, y: 660 }, { selector: 'canvas.page-base' }),
      text: await pixelStats(page2, { x: 112, y: 455, w: 200, h: 30 }, { selector: 'canvas.page-base' }),
      highlight: await pixelAt(page2, { x: 240, y: 461 }, { selector: 'canvas.page-base' }),
      image: await pixelAt(page2, { x: 237, y: 391 }, { selector: 'canvas.page-base' }),
      background: await pixelAt(page2, { x: 540, y: 40 }, { selector: 'canvas.page-base' }),
    }
    check(isDark(exported.rect), `exported PDF shows the rectangle (pixel ${exported.rect.join(',')})`)
    check(exported.text.ink > 5, `exported PDF shows the text (${exported.text.ink} dark pixels)`)
    check(
      exported.highlight[0] > 240 &&
        exported.highlight[1] > 215 &&
        exported.highlight[2] < 210 &&
        exported.highlight[2] < exported.highlight[1] - 40,
      `exported PDF shows a translucent yellow highlight (pixel ${exported.highlight.join(',')})`,
    )
    check(isReddish(exported.image), `exported PDF shows the image (pixel ${exported.image.join(',')})`)
    check(
      exported.background[0] > 240 && exported.background[1] > 240,
      'exported PDF page background is still white',
    )

    // Page 2 annotations after export.
    await page2.locator('.thumb').nth(1).click()
    await page2.waitForTimeout(900)
    await page2.click('button.zoom-label')
    await page2.waitForTimeout(300)
    const exportedEllipse = await pixelAt(page2, { x: 150, y: 450 }, { selector: 'canvas.page-base', index: 1 })
    check(isDark(exportedEllipse), `exported PDF shows page 2 ellipse (pixel ${exportedEllipse.join(',')})`)

    // Blank page 4 text after export.
    await page2.locator('.thumb').nth(3).click()
    await page2.waitForTimeout(900)
    const blankText = await pixelStats(page2, { x: 72, y: 88, w: 200, h: 30 }, { selector: 'canvas.page-base', index: 3 })
    const blankCorner = await pixelAt(page2, { x: 5, y: 5 }, { selector: 'canvas.page-base', index: 3 })
    check(blankText && blankText.ink > 5, `exported PDF shows text on the blank page (${blankText?.ink} dark pixels)`)
    check(
      blankCorner[0] > 240 && blankCorner[1] > 240 && blankCorner[2] > 240,
      'exported blank page has a white background',
    )

    check(page2Errors.length === 0, `no page errors while re-opening export (${page2Errors.join('; ')})`)

    // ------------------------------------------- standard (non-embedded) fonts
    const standardFontPath = buildStandardFontPdf(path.join(OUT_DIR, 'standard-font.pdf'))
    const page3 = await context.newPage()
    const fontWarnings = []
    page3.on('console', (message) => {
      const text = message.text()
      if (/standard font|standardFontData/i.test(text)) fontWarnings.push(text)
    })
    page3.on('pageerror', (error) => pageErrors.push(`standard-font: ${error}`))
    await gotoHome(page3)
    await openPdf(page3, standardFontPath)
    await page3.waitForTimeout(300)
    const fontPixels = await pixelStats(page3, { x: 35, y: 70, w: 330, h: 45 }, { selector: 'canvas.page-base' })
    check(fontPixels.ink > 20, `non-embedded standard font rendered (${fontPixels.ink} dark pixels)`)
    check(fontWarnings.length === 0, `no standard font asset warnings (${fontWarnings.join(' | ')})`)
    await page3.close()

    check(pageErrors.length === 0, `no browser page errors during the whole run (${pageErrors.join(' | ')})`)
  })
})
