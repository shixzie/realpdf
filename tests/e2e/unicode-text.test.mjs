/**
 * Unicode text suite: text added with the Text tool that the Standard-14 fonts
 * cannot encode (extended Latin, Greek, Cyrillic, CJK, Hangul, emoji) must
 * export with an embedded fallback font instead of turning into "?".
 */
import fs from 'node:fs'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
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
import { OUT_DIR } from '../helpers/fixtures.mjs'

const SAMPLES = [
  { text: 'Łódź Ελληνικά Привет', y: 120, font: /NotoSans-/ },
  { text: '中文字体 こんにちは', y: 200, font: /NotoSansSC/ },
  { text: '안녕하세요', y: 280, font: /NotoSansKR/ },
  { text: 'Party 🎉😀', y: 360, font: /NotoEmoji/ },
]

async function blankPdf(file) {
  const doc = await PDFDocument.create()
  doc.addPage([612, 792])
  doc.addPage([612, 792])
  fs.writeFileSync(file, await doc.save())
  return file
}

/** Text items of the first page with their baseline, as pdf.js reads them. */
async function textItems(file) {
  const document = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false }).promise
  const content = await (await document.getPage(1)).getTextContent()
  return content.items.filter((item) => item.str?.trim()).map((item) => ({ str: item.str, y: Math.round(item.transform[5]) }))
}

async function addText(page, x, y, text, index = 0) {
  const box = await pageBox(page, index)
  await page.click('.tool[title^="Text"]')
  await page.mouse.click(box.x + x, box.y + y)
  await page.waitForTimeout(150)
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) await page.keyboard.press('Enter')
    await page.keyboard.insertText(lines[i])
  }
  // The first Escape leaves editing, the second drops the selection so the
  // next click places a new box.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}

describe('unicode text export', () => {
  let app

  beforeAll(async () => {
    app = await launchApp()
  })

  afterAll(async () => {
    await app?.browser.close()
  })

  it('embeds fallback fonts for characters outside WinAnsi', async () => {
    const { page, context, pageErrors } = app
    const source = await blankPdf(path.join(OUT_DIR, 'unicode-blank.pdf'))

    await gotoHome(page)
    await openPdf(page, source)
    for (const sample of SAMPLES) await addText(page, 80, sample.y, sample.text)

    const exported = await savePdf(page, path.join(OUT_DIR, 'unicode-exported.pdf'))
    const text = await pdfText(exported, { pageSeparator: '\n' })
    for (const sample of SAMPLES) {
      check(text.replace(/\s+/g, '').includes(sample.text.replace(/\s+/g, '')), `exported text contains "${sample.text}" (got ${JSON.stringify(text)})`)
    }
    check(!text.includes('?'), `no characters were replaced with "?" (got ${JSON.stringify(text)})`)

    const fonts = await pageFonts(exported, 0)
    const names = fonts.map((font) => font.base).join(', ')
    for (const sample of SAMPLES) {
      check(
        fonts.some((font) => sample.font.test(font.base) && font.embedded),
        `an embedded ${sample.font} subset draws "${sample.text}" (fonts: ${names})`,
      )
    }
    // Text-tool boxes never wrap on export, even where the fallback glyphs are
    // wider than the fonts the browser showed them in.
    const items = await textItems(exported)
    const baseline = (str) => items.find((item) => item.str.includes(str))?.y
    check(baseline('Party') === baseline('🎉'), `emoji stay on the line they were typed on (${JSON.stringify(items)})`)
    check(baseline('Ελληνικά') === baseline('Привет'), `a single typed line stays one line (${JSON.stringify(items)})`)

    const size = fs.statSync(exported).size
    check(size < 150_000, `fallback fonts are embedded as small subsets (${size} bytes)`)

    // The glyphs render: each line leaves ink where it was placed.
    for (const sample of SAMPLES) {
      const stats = await exportedPixelStats(context, exported, { x: 80, y: sample.y, w: 160, h: 26 })
      check(stats.ink > 40, `exported "${sample.text}" renders (${stats.ink} dark pixels)`)
    }

    check(pageErrors.length === 0, `no page errors (${pageErrors.join('; ')})`)
  })

  it('keeps plain WinAnsi text on the standard fonts', async () => {
    const { page, pageErrors } = app
    const source = await blankPdf(path.join(OUT_DIR, 'unicode-plain.pdf'))

    await gotoHome(page)
    await openPdf(page, source)
    await addText(page, 80, 120, 'Café déjà vu – €5')
    await addText(page, 80, 200, 'First line\nSecond line')

    const exported = await savePdf(page, path.join(OUT_DIR, 'unicode-plain-exported.pdf'))
    const text = await pdfText(exported)
    check(text.includes('Café déjà vu – €5'), `WinAnsi text round-trips (got ${JSON.stringify(text)})`)
    const items = await textItems(exported)
    const first = items.find((item) => item.str.includes('First line'))
    const second = items.find((item) => item.str.includes('Second line'))
    check(first && second && second.y < first.y, `typed line breaks survive export (${JSON.stringify(items)})`)
    const fonts = await pageFonts(exported, 0)
    check(
      fonts.length > 0 && fonts.every((font) => !/Noto/.test(font.base)),
      `no fallback font is embedded for WinAnsi text (fonts: ${fonts.map((font) => font.base).join(', ')})`,
    )
    check(pageErrors.length === 0, `no page errors (${pageErrors.join('; ')})`)
  })
})
