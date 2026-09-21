/**
 * Selection options suite: selecting any tool result shows that tool's options
 * pre-filled with the object's own values, restyles the selection in place
 * (cover, shapes, arrow head, highlight, drawing), and the restyling goes
 * through undo/redo and export. Text selections are covered by
 * text-select.test.mjs.
 */
import path from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  check,
  dragOnPage,
  gotoHome,
  launchApp,
  openPdf,
  pageBox,
  pixelAt,
  pixelStats,
  savePdf,
} from '../helpers/app.mjs'
import { OUT_DIR, SAMPLE_PDF } from '../helpers/fixtures.mjs'

describe('selection options', () => {
  let app

  beforeAll(async () => {
    app = await launchApp()
  })

  afterAll(async () => {
    await app?.browser.close()
  })

  it('shows the producing tool options for a selected result and restyles it', async () => {
    const { page, context, pageErrors } = app
    const title = () => page.locator('.options-title').innerText()

    await gotoHome(page)
    await openPdf(page, SAMPLE_PDF)
    const box = await pageBox(page)

    // ------------------------------------------------------------ rectangle
    await page.click('.tool[title^="Rectangle"]')
    await dragOnPage(page, { x: 120, y: 620 }, { x: 330, y: 700 })
    await page.waitForTimeout(250)
    check((await title()).trim().toLowerCase() === 'rectangle', 'selecting the rectangle shows the rectangle options')
    check((await page.locator('.slider').inputValue()) === '2', 'the width slider reflects the drawn stroke')
    await page.locator('.slider').fill('12')
    await page.locator('.swatch[title="#dc2626"]').click()
    await page.waitForTimeout(250)
    const rectEdge = await pixelAt(page, { x: 120, y: 660 })
    check(rectEdge[0] > 150 && rectEdge[1] < 110, `the selected rectangle turns red (pixel ${rectEdge.join(',')})`)

    // ---------------------------------------------------------------- arrow
    await page.click('.tool[title^="Arrow"]')
    await dragOnPage(page, { x: 400, y: 650 }, { x: 520, y: 700 })
    await page.waitForTimeout(250)
    check((await title()).trim().toLowerCase() === 'arrow', 'selecting the arrow shows the arrow options')
    await page.waitForTimeout(500)
    await page.locator('.swatch[title="#16a34a"]').click()
    await page.waitForTimeout(250)
    const head = await pixelAt(page, { x: 520, y: 700 })
    check(head[1] > 120 && head[0] < 120, `the arrow head follows the line colour (pixel ${head.join(',')})`)

    // ------------------------------------------------------- undo and redo
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(600)
    const undone = await pixelAt(page, { x: 520, y: 700 })
    check(undone[0] > 120 && undone[1] < 120, `undo restores the old arrow colour (pixel ${undone.join(',')})`)
    await page.keyboard.press('Control+Shift+z')
    await page.waitForTimeout(600)
    const redone = await pixelAt(page, { x: 520, y: 700 })
    check(redone[1] > 120 && redone[0] < 120, `redo re-applies the arrow colour (pixel ${redone.join(',')})`)

    // ---------------------------------------------------------------- cover
    await page.click('.tool[title^="Cover"]')
    await dragOnPage(page, { x: 400, y: 100 }, { x: 520, y: 160 })
    await page.waitForTimeout(250)
    check((await title()).trim().toLowerCase() === 'cover', 'selecting the cover shows the cover options')
    await page.locator('.swatch[title="#2563eb"]').click()
    await page.waitForTimeout(250)
    const cover = await pixelAt(page, { x: 460, y: 130 })
    check(cover[2] > 150 && cover[0] < 130, `the selected cover turns blue (pixel ${cover.join(',')})`)

    // ------------------------------------------------------------ highlight
    await page.click('.tool[title^="Highlight"]')
    await dragOnPage(page, { x: 60, y: 420 }, { x: 480, y: 438 })
    await page.click('.tool[title^="Select"]')
    await page.mouse.click(box.x + 270, box.y + 429)
    await page.waitForTimeout(300)
    check((await title()).trim().toLowerCase() === 'highlight', 'selecting the highlight shows the highlighter options')
    const activeSwatch = await page.locator('.options .swatch.is-active').getAttribute('title')
    check(activeSwatch === '#facc15', `the swatches show the highlight colour (active ${activeSwatch})`)
    await page.locator('.swatch[title="#60a5fa"]').click()
    await page.waitForTimeout(250)
    const highlight = await pixelAt(page, { x: 270, y: 429 })
    check(highlight[2] > 150 && highlight[0] < 170, `the selected highlight turns blue (pixel ${highlight.join(',')})`)

    // ----------------------------------------------------------- pen stroke
    await page.click('.tool[title^="Draw"]')
    await dragOnPage(page, { x: 150, y: 540 }, { x: 250, y: 580 })
    await page.click('.tool[title^="Select"]')
    await page.mouse.click(box.x + 200, box.y + 560)
    await page.waitForTimeout(300)
    check((await title()).trim().toLowerCase() === 'draw', 'selecting a pen stroke shows the draw options')
    check(
      (await page.locator('.options button.button-ghost').count()) >= 1,
      'a delete action is offered for the selected result',
    )
    await page.locator('.swatch[title="#7c3aed"]').click()
    await page.waitForTimeout(250)
    const pen = await pixelAt(page, { x: 200, y: 560 })
    check(pen[2] > 150 && pen[0] < 170 && pen[1] < 120, `the selected stroke turns purple (pixel ${pen.join(',')})`)

    // --------------------------------------------------------- export check
    const exportedPath = path.join(OUT_DIR, 'selection-options-exported.pdf')
    await savePdf(page, exportedPath)

    const reopened = await context.newPage()
    reopened.on('pageerror', (error) => pageErrors.push(`selection export: ${error}`))
    await gotoHome(reopened)
    await openPdf(reopened, exportedPath)
    const base = { selector: 'canvas.page-base' }
    const exportedRect = await pixelStats(reopened, { x: 110, y: 645, w: 30, h: 30 }, base)
    check(exportedRect.red > 20, `the exported rectangle keeps the new colour and width (${exportedRect.red} red pixels)`)
    const exportedHead = await pixelAt(reopened, { x: 520, y: 700 }, base)
    check(exportedHead[1] > 120 && exportedHead[0] < 120, `the exported arrow is still green (pixel ${exportedHead.join(',')})`)
    const exportedCover = await pixelAt(reopened, { x: 460, y: 130 }, base)
    check(exportedCover[2] > 150 && exportedCover[0] < 130, `the exported cover is still blue (pixel ${exportedCover.join(',')})`)
    const exportedPen = await pixelAt(reopened, { x: 200, y: 560 }, base)
    check(exportedPen[2] > 150 && exportedPen[0] < 170, `the exported stroke is still purple (pixel ${exportedPen.join(',')})`)
    const exportedHighlight = await pixelAt(reopened, { x: 270, y: 429 }, base)
    check(
      exportedHighlight[2] > 200 && exportedHighlight[0] < 230,
      `the exported highlight is still blue (pixel ${exportedHighlight.join(',')})`,
    )
    await reopened.close()

    check(pageErrors.length === 0, `no browser errors during the run (${pageErrors.join(' | ')})`)
  })
})
