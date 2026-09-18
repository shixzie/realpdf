/**
 * Text select suite: selecting a text annotation (or a replacement of existing
 * PDF text) activates the text tool, the options panel restyles the selection,
 * and the changes survive undo/redo and export.
 */
import path from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { check, exportedPixelStats, gotoHome, launchApp, openPdf, pixelStats, savePdf } from '../helpers/app.mjs'
import { OUT_DIR, buildBlankPdf, buildStandardFontPdf } from '../helpers/fixtures.mjs'

describe('text selection styling', () => {
  let app

  beforeAll(async () => {
    app = await launchApp()
  })

  afterAll(async () => {
    await app?.browser.close()
  })

  it('restyles annotations and in-place replacements', async () => {
    const { page, context, pageErrors } = app
    const blank = await buildBlankPdf()
    const standard = buildStandardFontPdf(path.join(OUT_DIR, 'textselect-standard.pdf'))

    const toolIsActive = (prefix) =>
      page.locator(`.tool[title^="${prefix}"]`).evaluate((element) => element.classList.contains('is-active'))

    // ------------------------------------------------ text annotations
    await gotoHome(page)
    await openPdf(page, blank)
    const box = await page.locator('.page[data-page-index="0"]').boundingBox()

    await page.click('.tool[title^="Text"]')
    await page.mouse.click(box.x + 120, box.y + 150)
    await page.waitForTimeout(200)
    await page.keyboard.type('Style me')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    check(await toolIsActive('Text'), 'the text tool stays active after typing')

    // Selecting the text with the select tool activates the text tool.
    await page.click('.tool[title^="Select"]')
    await page.mouse.click(box.x + 420, box.y + 420)
    await page.waitForTimeout(200)
    await page.mouse.click(box.x + 135, box.y + 155)
    await page.waitForTimeout(400)
    check(await toolIsActive('Text'), 'selecting a text annotation activates the text tool')
    check(
      (await page.locator('.options-title').innerText()).trim().toLowerCase() === 'text',
      'the options panel shows the text tool',
    )
    check((await page.locator('.options select').inputValue()) === 'Helvetica', 'the font picker shows the text font')
    check((await page.locator('.slider-size').inputValue()) === '16', 'the size slider shows the text size')
    check((await page.locator('.swatch.is-active').count()) >= 1, 'the colour swatches show the text colour')

    // Changes apply to the selected text, not just to the defaults.
    await page.locator('.slider-size').fill('40')
    await page.waitForTimeout(200)
    await page.locator('.swatch[title="#dc2626"]').click()
    await page.waitForTimeout(200)
    await page.locator('.options select').selectOption('Courier New')
    await page.waitForTimeout(300)
    const styled = await pixelStats(page, { x: 110, y: 140, w: 200, h: 60 })
    check(styled.red > 20, `the selected text turns red on the canvas (${styled.red} red pixels)`)
    check(styled.dark > 20, `the selected text grows with the size slider (${styled.dark} dark pixels)`)

    // Style changes go through the history.
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(500)
    const undone = await pixelStats(page, { x: 110, y: 140, w: 200, h: 60 })
    check(undone.red === 0, 'undo restores the original text style')
    await page.keyboard.press('Control+Shift+z')
    await page.waitForTimeout(500)
    const redone = await pixelStats(page, { x: 110, y: 140, w: 200, h: 60 })
    check(redone.red > 20, 'redo reapplies the text style')

    const annotationExport = path.join(OUT_DIR, 'textselect-annotation-exported.pdf')
    await savePdf(page, annotationExport)
    const exported = await exportedPixelStats(context, annotationExport, { x: 110, y: 140, w: 200, h: 60 })
    check(exported.red > 20, `the export keeps the selected colour (${exported.red} red pixels)`)
    check(exported.dark > 20, `the export keeps the selected size (${exported.dark} dark pixels)`)

    // -------------------------------------- replacements of existing PDF text
    await gotoHome(page)
    await openPdf(page, standard)
    const standardBox = await page.locator('.page[data-page-index="0"]').boundingBox()

    await page.click('.tool[title^="Edit text"]')
    await page.mouse.click(standardBox.x + 100, standardBox.y + 92)
    await page.waitForTimeout(800)
    check(await toolIsActive('Text'), 'editing existing PDF text activates the text tool')
    check((await page.locator('.slider-size').inputValue()) === '28', 'the size slider shows the matched size')

    await page.locator('.slider-size').fill('40')
    await page.waitForTimeout(200)
    await page.locator('.swatch[title="#2563eb"]').click()
    await page.waitForTimeout(200)
    const edited = await pixelStats(page, { x: 35, y: 55, w: 360, h: 80 })
    check(edited.blue > 20, `the replacement turns blue on the canvas (${edited.blue} blue pixels)`)

    // Clicking away keeps the restyled replacement (even without new text).
    await page.mouse.click(standardBox.x + 350, standardBox.y + 180)
    await page.waitForTimeout(500)
    check(await toolIsActive('Edit text'), 'finishing an in-place edit returns to the edit-text tool')
    const persisted = await pixelStats(page, { x: 35, y: 55, w: 360, h: 80 })
    check(persisted.blue > 20, `the restyled replacement survives deselecting (${persisted.blue} blue pixels)`)

    const standardExport = path.join(OUT_DIR, 'textselect-standard-exported.pdf')
    await savePdf(page, standardExport)
    const exportedStandard = await exportedPixelStats(context, standardExport, { x: 35, y: 55, w: 360, h: 80 })
    check(
      exportedStandard.blue > 20,
      `the exported replacement keeps the new colour (${exportedStandard.blue} blue pixels)`,
    )

    check(pageErrors.length === 0, `no browser page errors during the whole run (${pageErrors.join(' | ')})`)
  })
})
