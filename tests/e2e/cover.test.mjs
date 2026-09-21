/**
 * Cover tool suite: the colour picked in the toolbar is used for the drawn
 * cover and survives the export.
 */
import path from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  check,
  dragOnPage,
  gotoHome,
  launchApp,
  openPdf,
  pixelAt,
  savePdf,
} from '../helpers/app.mjs'
import { OUT_DIR, SAMPLE_PDF } from '../helpers/fixtures.mjs'

describe('cover colour', () => {
  let app

  beforeAll(async () => {
    app = await launchApp()
  })

  afterAll(async () => {
    await app?.browser.close()
  })

  it('draws and exports a cover in the selected colour', async () => {
    const { page, context, pageErrors } = app

    await gotoHome(page)
    await openPdf(page, SAMPLE_PDF)

    // ------------------------------------------------------- pick a colour
    await page.click('.tool[title^="Cover"]')
    await page.waitForSelector('.options .swatches')
    const defaultSwatch = await page.locator('.options .swatch.is-active').getAttribute('title')
    check(defaultSwatch === '#ffffff', `the cover defaults to white (active swatch ${defaultSwatch})`)
    check((await page.locator('.options input[type="color"]').count()) === 1, 'a custom cover colour is offered')
    await page.click('.options button.swatch[title="#2563eb"]')

    // ----------------------------------------------------------- draw it
    await dragOnPage(page, { x: 400, y: 100 }, { x: 520, y: 160 })
    const painted = await pixelAt(page, { x: 460, y: 130 })
    check(
      painted[2] > 150 && painted[0] < 130,
      `the cover is painted in the selected blue (pixel ${painted.join(',')})`,
    )

    // --------------------------------------------------- colour persists
    await page.click('.tool[title^="Cover"]')
    await page.waitForSelector('.options .swatches')
    const active = await page.locator('.options .swatch.is-active').getAttribute('title')
    check(active === '#2563eb', `the chosen colour stays selected (active swatch ${active})`)

    // --------------------------------------------------------- export
    const exportedPath = path.join(OUT_DIR, 'cover-colour.pdf')
    await savePdf(page, exportedPath)

    const reopened = await context.newPage()
    reopened.on('pageerror', (error) => pageErrors.push(`cover export: ${error}`))
    await gotoHome(reopened)
    await openPdf(reopened, exportedPath)
    const exported = await pixelAt(reopened, { x: 460, y: 130 }, { selector: 'canvas.page-base' })
    check(
      exported[2] > 150 && exported[0] < 130,
      `the exported PDF keeps the cover colour (pixel ${exported.join(',')})`,
    )
    await reopened.close()

    check(pageErrors.length === 0, `no browser errors (${pageErrors.join(' | ')})`)
  })
})
