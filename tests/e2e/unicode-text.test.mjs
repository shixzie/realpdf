/**
 * Unicode text suite: characters outside WinAnsi, in new text and in retyped
 * runs whose embedded subset lacks them, are drawn with the fallback fonts
 * instead of turning into question marks.
 */
import path from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  check,
  exportedPixelStats,
  gotoHome,
  launchApp,
  openPdf,
  pageBox,
  pageFonts,
  pdfText,
  savePdf,
} from '../helpers/app.mjs'
import { OUT_DIR, SAMPLE_PDF, buildSubsetFontPdf } from '../helpers/fixtures.mjs'

const fontNames = (fonts) => [...new Set(fonts.map((font) => font.base))].join(', ')

describe('unicode text', () => {
  let app

  beforeAll(async () => {
    app = await launchApp()
  })

  afterAll(async () => {
    await app?.browser.close()
  })

  it('exports added text outside WinAnsi with fallback fonts', async () => {
    const { page, context, pageErrors } = app
    await gotoHome(page)
    await openPdf(page, SAMPLE_PDF)

    await page.click('.tool[title^="Text"]')
    const box = await pageBox(page)
    await page.mouse.click(box.x + 120, box.y + 470)
    await page.waitForTimeout(150)
    await page.keyboard.insertText('Grüße Ωμέγα Привет 世界')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(350)

    const exported = path.join(OUT_DIR, 'unicode-added.pdf')
    await savePdf(page, exported)
    const layer = await pdfText(exported)
    check(layer.includes('Grüße'), `WinAnsi text keeps its characters (${layer})`)
    check(layer.includes('Ωμέγα') && layer.includes('Привет'), 'Greek and Cyrillic are real text')
    check(layer.includes('世界'), 'CJK is real text')
    check(!layer.includes('?'), 'no character was replaced with a question mark')

    const fonts = await pageFonts(exported)
    check(fonts.some((font) => /Helvetica/.test(font.base)), `the standard font draws the Latin text (${fontNames(fonts)})`)
    check(fonts.some((font) => /Liberation/i.test(font.base) && font.embedded), 'Liberation Sans draws Greek and Cyrillic')
    check(fonts.some((font) => /Noto/i.test(font.base) && font.embedded), 'Noto Sans SC draws the CJK text')

    const ink = await exportedPixelStats(context, exported, { x: 112, y: 455, w: 320, h: 30 })
    check(ink.dark > 40, `exported PDF shows the whole line (${ink.dark} dark pixels)`)

    check(pageErrors.length === 0, `no browser errors (${pageErrors.slice(0, 3).join(' | ')})`)
  })

  it('draws characters missing from an embedded subset with a fallback font', async () => {
    const { page, context, pageErrors } = app
    const subset = await buildSubsetFontPdf()
    await gotoHome(page)
    await openPdf(page, subset)

    await page.click('.tool[title^="Edit text"]')
    const first = await pageBox(page)
    await page.mouse.click(first.x + 80, first.y + 134)
    await page.waitForTimeout(700)
    await page.keyboard.insertText('Hello wörld Ω 世')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    await page.mouse.click(first.x + 520, first.y + 760)
    await page.waitForTimeout(400)

    const exported = path.join(OUT_DIR, 'unicode-subset-edit.pdf')
    await savePdf(page, exported)
    const layer = await pdfText(exported)
    check(layer.includes('wörld') && layer.includes('Ω') && layer.includes('世'), `missing glyphs are real text (${layer})`)
    check(!layer.includes('?'), 'no character was replaced with a question mark')
    check(!layer.includes('Hello world'), 'the original run is gone')

    const fonts = await pageFonts(exported)
    check(fonts.some((font) => /Noto/i.test(font.base) && font.embedded), `CJK comes from the fallback (${fontNames(fonts)})`)

    const ink = await exportedPixelStats(context, exported, { x: 56, y: 124, w: 170, h: 24 })
    check(ink.dark > 20, `exported PDF shows the replacement (${ink.dark} dark pixels)`)

    check(pageErrors.length === 0, `no browser errors (${pageErrors.slice(0, 3).join(' | ')})`)
  })
})
