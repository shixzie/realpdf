/**
 * Text edit suite: retyping text that already lives in a PDF, verified through
 * the exported files — pixels, text layer and embedded font programs.
 */
import fs from 'node:fs'
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
  pixelStats,
  savePdf,
} from '../helpers/app.mjs'
import {
  OUT_DIR,
  buildEmbeddedFontPdf,
  buildStandardFontPdf,
  buildStripedPdf,
  buildStyledFontPdf,
} from '../helpers/fixtures.mjs'

describe('text editing', () => {
  let app

  beforeAll(async () => {
    app = await launchApp()
  })

  afterAll(async () => {
    await app?.browser.close()
  })

  it('deletes the original glyphs and embeds the replacement', async () => {
    const { page, context, pageErrors } = app
    const embedded = await buildEmbeddedFontPdf()
    const standard = buildStandardFontPdf(path.join(OUT_DIR, 'textedit-standard.pdf'))

    // ------------------------------------------------------- embedded fonts
    await gotoHome(page)
    await openPdf(page, embedded)
    check((await page.locator('.tool[title^="Edit text"]').count()) === 1, 'the Edit text tool is in the rail')

    await page.click('.tool[title^="Edit text"]')
    const first = await pageBox(page)
    // The page's text runs load in the background after the tool is picked, and
    // a pointer move that lands before they arrive draws nothing; nudge the
    // pointer until the highlight appears.
    let hover = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.mouse.move(first.x + 150 + (attempt % 2), first.y + 134)
      await page.waitForTimeout(250)
      hover = await pixelStats(page, { x: 148, y: 128, w: 4, h: 4 })
      if (hover.alpha > 20) break
    }
    check(hover.alpha > 20, `hovering existing text shows a highlight (alpha ${hover.alpha})`)
    // Untouched text is the reference for the preview's font fidelity.
    const secondLineRegion = { x: 56, y: 156, w: 110, h: 20 }
    const secondLineBefore = await pixelStats(page, secondLineRegion, { selector: 'canvas.page-base' })

    // Edit the first line: original is "The quick brown fox" in red 18pt.
    await page.mouse.click(first.x + 150, first.y + 134)
    await page.waitForTimeout(700)
    await page.keyboard.type('Ship it')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    // Deselect without leaving the tool, so selection controls are not sampled.
    await page.mouse.click(first.x + 520, first.y + 760)
    await page.waitForTimeout(400)
    const editedText = await pixelStats(page, { x: 56, y: 124, w: 60, h: 24 })
    check(editedText.dark > 5, `replacement text renders on the overlay (${editedText.dark} dark pixels)`)
    // The live preview is the final page: the original glyphs are deleted from
    // the rendered page and no cover rectangle stands in for them.
    const editedBase = await pixelStats(page, { x: 140, y: 124, w: 62, h: 24 }, { selector: 'canvas.page-base' })
    check(
      editedBase.dark === 0,
      `the live preview deletes the original glyphs (${editedBase.dark} dark pixels)`,
    )
    const editedCover = await pixelStats(page, { x: 140, y: 130, w: 40, h: 8 })
    check(editedCover.alpha === 0, `no cover rectangle remains on the overlay (alpha ${editedCover.alpha})`)
    // Re-rendering the patched page must keep every other run in its original
    // font program, not substitute it.
    const secondLineAfter = await pixelStats(page, secondLineRegion, { selector: 'canvas.page-base' })
    check(
      Math.abs(secondLineAfter.dark - secondLineBefore.dark) <= 2 &&
        Math.abs(secondLineAfter.ink - secondLineBefore.ink) <= 2,
      `the preview keeps untouched text in the original font (dark ${secondLineBefore.dark} -> ${secondLineAfter.dark})`,
    )

    // Undo/redo around the edit (typing may add extra history steps).
    let undos = 0
    for (; undos < 4; undos += 1) {
      await page.keyboard.press('Control+z')
      await page.waitForTimeout(450)
      const undone = await pixelStats(page, { x: 56, y: 124, w: 160, h: 24 })
      if (undone.dark === 0 && undone.alpha === 0) break
    }
    check(undos > 0 && undos < 4, `undo removes the text replacement (${undos} step(s))`)
    const undidBase = await pixelStats(page, { x: 140, y: 124, w: 62, h: 24 }, { selector: 'canvas.page-base' })
    check(undidBase.dark > 5, `undo brings the original glyphs back to the preview (${undidBase.dark} dark pixels)`)
    for (let i = 0; i < undos; i += 1) {
      await page.keyboard.press('Control+Shift+z')
      await page.waitForTimeout(350)
    }
    const redone = await pixelStats(page, { x: 56, y: 124, w: 60, h: 24 })
    check(redone.dark > 5, 'redo restores the text replacement')
    const redoneBase = await pixelStats(page, { x: 140, y: 124, w: 62, h: 24 }, { selector: 'canvas.page-base' })
    check(redoneBase.dark === 0, `redo deletes the original glyphs again (${redoneBase.dark} dark pixels)`)

    // Re-edit the replacement: clicking it edits in place.
    await page.mouse.click(first.x + 70, first.y + 134)
    await page.waitForTimeout(600)
    await page.keyboard.type('Ship it now')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    const reedited = await pixelStats(page, { x: 56, y: 124, w: 100, h: 24 })
    check(reedited.dark > 5, `a replacement can be edited again (${reedited.dark} dark pixels)`)

    // Second line: the replacement is longer and must grow along the baseline
    // rather than wrap inside the original run's width.
    await page.mouse.click(first.x + 90, first.y + 176)
    await page.waitForTimeout(600)
    await page.keyboard.type('Second line changed')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    // Deselect so the selection controls are not sampled.
    await page.mouse.click(first.x + 520, first.y + 760)
    await page.waitForTimeout(400)
    const grownStart = await pixelStats(page, { x: 56, y: 162, w: 90, h: 22 })
    const grownEnd = await pixelStats(page, { x: 130, y: 162, w: 80, h: 22 })
    const grownBelow = await pixelStats(page, { x: 56, y: 190, w: 150, h: 22 })
    check(grownStart.ink > 5, `the longer replacement starts on the original line (${grownStart.ink} ink pixels)`)
    check(grownEnd.ink > 3, `the box grows as the text gets longer (${grownEnd.ink} ink pixels past the original width)`)
    check(grownBelow.ink === 0, `the longer replacement does not wrap (${grownBelow.ink} ink pixels below the line)`)

    // --------------------------------------------------------------- export
    const exported = path.join(OUT_DIR, 'textedit-exported.pdf')
    await savePdf(page, exported)
    check(fs.statSync(exported).size > 3000, `exported PDF written (${fs.statSync(exported).size} bytes)`)

    const fonts = await pageFonts(exported)
    const uniqueFonts = [...new Map(fonts.map((font) => [font.ref, font])).values()]
    check(
      uniqueFonts.filter((font) => font.embedded).length === 2,
      `export embeds the original font plus one replacement subset (${uniqueFonts.length} fonts)`,
    )
    check(
      uniqueFonts.length === 2,
      `replacement text shares a single font subset (${uniqueFonts.map((font) => font.key).join(', ')})`,
    )
    check(
      uniqueFonts.every((font) => /liberation/i.test(font.base)),
      `the replacement reuses the original font program (${uniqueFonts.map((font) => font.base).join(', ')})`,
    )

    const replacement = await exportedPixelStats(context, exported, { x: 56, y: 124, w: 95, h: 24 })
    check(replacement.dark > 5, `exported PDF shows the replacement text (${replacement.dark} dark pixels)`)
    check(
      replacement.red > 5,
      `replacement keeps the original colour (${replacement.red} red pixels)`,
    )
    const covered = await exportedPixelStats(context, exported, { x: 152, y: 124, w: 62, h: 24 })
    check(covered.dark === 0, 'the original text is gone from the export')
    const secondLine = await exportedPixelStats(context, exported, { x: 56, y: 162, w: 130, h: 22 })
    const secondLineBelow = await exportedPixelStats(context, exported, { x: 56, y: 190, w: 130, h: 22 })
    check(secondLine.dark > 8, `exported PDF shows the grown replacement (${secondLine.dark} dark pixels)`)
    check(secondLineBelow.dark === 0, 'the exported replacement did not wrap either')

    // The old text must be deleted from the text layer, not just covered.
    const exportedLayer = await pdfText(exported)
    check(
      !exportedLayer.includes('The quick brown fox'),
      `the text layer no longer contains the original run (${exportedLayer})`,
    )
    check(!exportedLayer.includes('Second line stays'), 'the text layer no longer contains the second run')
    check(exportedLayer.includes('Ship it now'), 'the replacement is real text in the exported layer')
    check(
      exportedLayer.includes('Second line') && exportedLayer.includes('changed'),
      'the wrapped replacement is real text too',
    )

    // --------------------------------------------------- local library round trip
    await page.click('button:has-text("Library")')
    await page.waitForSelector('.library-item', { timeout: 15000 })
    const [libraryDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('.library-item .library-actions button:has-text("PDF")'),
    ])
    const rebuilt = path.join(OUT_DIR, 'textedit-library.pdf')
    await libraryDownload.saveAs(rebuilt)
    const rebuiltFonts = await pageFonts(rebuilt)
    const rebuiltUnique = [...new Map(rebuiltFonts.map((font) => [font.ref, font])).values()]
    check(
      rebuiltUnique.filter((font) => font.embedded).length === 2,
      `the library keeps the original font program (${rebuiltUnique.length} fonts)`,
    )
    const rebuiltLayer = await pdfText(rebuilt)
    check(
      !rebuiltLayer.includes('The quick brown fox') && rebuiltLayer.includes('Ship it now'),
      `library rebuild also deletes the original glyphs (${rebuiltLayer})`,
    )

    // Reopen from browser storage: the font asset must be restored.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.empty-card')
    await page.locator('.recent-card').first().click()
    await page.waitForSelector('.page canvas.page-base', { timeout: 20000 })
    await page.waitForTimeout(1200)
    await page.click('button.zoom-label')
    await page.waitForTimeout(300)
    const restored = await pixelStats(page, { x: 56, y: 124, w: 95, h: 24 })
    check(restored.dark > 5, `restored document renders the replacement (${restored.dark} dark pixels)`)
    const restoredBase = await pixelStats(page, { x: 152, y: 124, w: 62, h: 24 }, { selector: 'canvas.page-base' })
    check(
      restoredBase.dark === 0,
      `restored document previews the deleted original (${restoredBase.dark} dark pixels)`,
    )

    // ------------------------------------------------------- standard fonts
    await gotoHome(page)
    await openPdf(page, standard)
    await page.click('.tool[title^="Edit text"]')
    const standardBox = await pageBox(page)
    await page.mouse.click(standardBox.x + 100, standardBox.y + 92)
    await page.waitForTimeout(800)
    await page.keyboard.type('Standard edited')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    const standardExported = path.join(OUT_DIR, 'textedit-standard-exported.pdf')
    await savePdf(page, standardExported)
    const standardFonts = await pageFonts(standardExported)
    check(
      standardFonts.length > 0 && standardFonts.every((font) => !font.embedded),
      `standard text stays non-embedded (${standardFonts.map((font) => font.base).join(', ')})`,
    )
    check(
      standardFonts.some((font) => /helvetica/i.test(font.base)),
      'standard text keeps a Helvetica base font',
    )
    const standardText = await exportedPixelStats(context, standardExported, { x: 35, y: 70, w: 220, h: 40 })
    check(standardText.dark > 10, `standard-font replacement renders (${standardText.dark} dark pixels)`)
    const standardCovered = await exportedPixelStats(context, standardExported, { x: 242, y: 70, w: 22, h: 40 })
    check(standardCovered.dark === 0, 'standard-font original is gone from the export')
    const standardLayer = await pdfText(standardExported)
    check(
      !standardLayer.includes('Standard font test'),
      `the standard-font original is deleted, not covered (${standardLayer})`,
    )
    check(standardLayer.includes('Standard edited'), 'the standard-font replacement is real text in the layer')

    // ------------------------------------- bold / italic runs keep their face
    // Retyping a styled run must keep its weight, slant and size: the same
    // font program is reused for the canvas and embedded in the export.
    const styled = await buildStyledFontPdf()
    await gotoHome(page)
    await openPdf(page, styled)
    const styledBox = await pageBox(page)
    const boldRegion = { x: 38, y: 38, w: 205, h: 30 }
    const italicRegion = { x: 38, y: 98, w: 195, h: 30 }
    const boldBefore = await pixelStats(page, boldRegion, { selector: 'canvas.page-base' })
    const italicBefore = await pixelStats(page, italicRegion, { selector: 'canvas.page-base' })

    const fontFaces = async () =>
      page.evaluate(() => {
        const faces = []
        document.fonts.forEach((face) => {
          if (face.family.includes('realpdf-pdftext')) {
            faces.push({ family: face.family, weight: face.weight, style: face.style })
          }
        })
        return faces
      })

    // Bold run: same text (+ trailing space, so the edit is kept).
    await page.click('.tool[title^="Edit text"]')
    await page.mouse.click(styledBox.x + 40 + 187 / 2, styledBox.y + 53)
    await page.waitForTimeout(700)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('Embedded bold run ')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(350)
    await page.mouse.click(styledBox.x + 300, styledBox.y + 270)
    await page.waitForTimeout(300)
    const boldFaces = await fontFaces()
    check(
      boldFaces.some((face) => face.weight === '700'),
      `editing a bold run loads its program as a bold face (${JSON.stringify(boldFaces)})`,
    )

    // Italic run.
    await page.click('.tool[title^="Edit text"]')
    await page.mouse.click(styledBox.x + 40 + 176 / 2, styledBox.y + 113)
    await page.waitForTimeout(700)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('Embedded italic run ')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(350)
    await page.mouse.click(styledBox.x + 300, styledBox.y + 270)
    await page.waitForTimeout(300)
    const italicFaces = await fontFaces()
    check(
      italicFaces.some((face) => face.style === 'italic'),
      `editing an italic run loads its program as an italic face (${JSON.stringify(italicFaces)})`,
    )

    // The export keeps the same weight/slant: re-rendering the saved file must
    // produce about as much ink as the original run did.
    const styledExported = path.join(OUT_DIR, 'textedit-styled-exported.pdf')
    await savePdf(page, styledExported)
    const boldAfter = await exportedPixelStats(context, styledExported, boldRegion)
    const italicAfter = await exportedPixelStats(context, styledExported, italicRegion)
    const ratio = (after, before) => after / Math.max(1, before)
    check(
      ratio(boldAfter.ink, boldBefore.ink) > 0.8 && ratio(boldAfter.ink, boldBefore.ink) < 1.25,
      `the bold replacement keeps its weight (ink ${boldBefore.ink} -> ${boldAfter.ink})`,
    )
    check(
      ratio(italicAfter.ink, italicBefore.ink) > 0.8 && ratio(italicAfter.ink, italicBefore.ink) < 1.25,
      `the italic replacement keeps its slant (ink ${italicBefore.ink} -> ${italicAfter.ink})`,
    )
    const styledLayer = await pdfText(styledExported)
    check(styledLayer.includes('Embedded bold run'), 'the bold replacement is real text in the layer')
    check(styledLayer.includes('Embedded italic run'), 'the italic replacement is real text in the layer')
    const styledFonts = [...new Map((await pageFonts(styledExported)).map((font) => [font.ref, font])).values()]
    check(
      styledFonts.filter((font) => font.embedded).length >= 2 &&
        styledFonts.every((font) => /liberation/i.test(font.base)),
      `the export reuses the embedded bold and italic programs (${styledFonts.map((font) => font.base).join(', ')})`,
    )

    // --------------------------------------------- no background cover
    // Text over coloured stripes: if the exporter painted a sampled background
    // rectangle over the original run, the stripes would be flattened.
    const striped = await buildStripedPdf()
    await gotoHome(page)
    await openPdf(page, striped)
    await page.click('.tool[title^="Edit text"]')
    const stripedBox = await pageBox(page)
    await page.mouse.click(stripedBox.x + 60, stripedBox.y + 84)
    await page.waitForTimeout(700)
    await page.keyboard.type('Go')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
    await page.mouse.click(stripedBox.x + 350, stripedBox.y + 180)
    await page.waitForTimeout(300)

    // The live preview must already show the final result: the original glyphs
    // are gone from the rendered page and the stripes are not covered.
    const stripesPreview = await pixelStats(page, { x: 60, y: 74, w: 55, h: 24 }, { selector: 'canvas.page-base' })
    check(stripesPreview.black === 0, `the live preview deletes the striped original (${stripesPreview.black} black pixels)`)
    check(
      stripesPreview.saturatedBins >= 3,
      `the live preview keeps the stripes — no cover (${stripesPreview.saturatedBins} colours)`,
    )
    const stripesOverlay = await pixelStats(page, { x: 60, y: 74, w: 55, h: 24 })
    check(stripesOverlay.alpha === 0, `no cover rectangle on the striped run (alpha ${stripesOverlay.alpha})`)

    const stripedExported = path.join(OUT_DIR, 'textedit-striped-exported.pdf')
    await savePdf(page, stripedExported)
    const stripedLayer = await pdfText(stripedExported)
    check(!stripedLayer.includes('Replace this'), `striped original is deleted (${stripedLayer})`)
    check(stripedLayer.includes('Go'), 'striped replacement is real text')
    const stripes = await exportedPixelStats(context, stripedExported, { x: 60, y: 74, w: 55, h: 24 })
    check(stripes.black === 0, 'no original glyphs remain over the stripes')
    check(
      stripes.saturatedBins >= 3,
      `the striped background is intact — no cover rectangle (${stripes.saturatedBins} colours)`,
    )

    check(pageErrors.length === 0, `no browser page errors during the whole run (${pageErrors.join(' | ')})`)
  })
})
