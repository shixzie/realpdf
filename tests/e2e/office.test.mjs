/**
 * Office suite: Word/Excel/PowerPoint files convert into editable PDFs, and
 * the current PDF exports back to Word/Excel/PowerPoint packages.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { check, gotoHome, launchApp, openPdf, pdfText, savePdf } from '../helpers/app.mjs'
import { OUT_DIR, SAMPLE_PDF } from '../helpers/fixtures.mjs'
import { buildOfficeFixtures } from '../helpers/officeFixtures.mjs'
import { readZip, zipText } from '../../src/lib/zipRead.ts'

async function pageXObjectCount(file, pageIndex = 0) {
  const doc = await PDFDocument.load(fs.readFileSync(file), { ignoreEncryption: true })
  const resources = doc.getPage(pageIndex).node.Resources()
  const dictionary = resources?.lookup(PDFName.of('XObject'), PDFDict)
  return dictionary ? dictionary.keys().length : 0
}

async function firstTextBaseline(file) {
  const bytes = new Uint8Array(fs.readFileSync(file))
  const document = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise
  const page = await document.getPage(1)
  const content = await page.getTextContent()
  const item = content.items.find((entry) => 'transform' in entry && entry.str?.trim())
  return { y: item.transform[5], height: page.getViewport({ scale: 1 }).height }
}

describe('office formats', () => {
  let app

  beforeAll(async () => {
    app = await launchApp({ viewport: { width: 1500, height: 1000 } })
  })

  afterAll(async () => {
    await app?.browser.close()
  })

  it('converts Office documents to PDF and back', async () => {
    const { page, pageErrors } = app
    const fixtures = buildOfficeFixtures()

    const openTools = async (tab) => {
      const already = await page.locator('.modal-wide').count()
      if (!already) await page.click('button[title="Merge, split and convert PDFs and Office files"]')
      await page.click(`.tab:has-text("${tab}")`)
    }

    const importOffice = async (filePath) => {
      await openTools('Office')
      await page.setInputFiles('input[accept^=".docx"]', filePath)
      await page.waitForTimeout(300)
      await page.click('button:has-text("Convert & open")')
      await page.waitForSelector('.page canvas.page-base', { timeout: 30000 })
      await page.waitForTimeout(900)
    }

    await gotoHome(page)

    // ------------------------------------------------------ Word -> PDF
    await importOffice(fixtures.docx)
    check((await page.locator('.thumb').count()) === 1, 'Word file opens as a one-page PDF')
    check(
      (await page.locator('.file-name').innerText()).includes('office-fixture.pdf'),
      'the editor shows the converted PDF name',
    )
    const docxPdf = path.join(OUT_DIR, 'office-from-docx.pdf')
    await savePdf(page, docxPdf)
    const docxText = await pdfText(docxPdf, { itemSeparator: ' ' })
    check(docxText.includes('Quarterly Report'), 'Word paragraph text survives the conversion')
    check(docxText.includes('bold words'), 'Word bold run text survives the conversion')
    check(docxText.includes('Cell A') && docxText.includes('Cell B'), 'Word table cells survive')
    check(docxText.includes('Centered closing line'), 'Word trailing paragraphs survive')
    check((await pageXObjectCount(docxPdf)) >= 1, 'Word images are embedded in the converted PDF')

    // ----------------------------------------------------- Excel -> PDF
    await importOffice(fixtures.xlsx)
    check((await page.locator('.thumb').count()) === 1, 'Excel workbook opens as a one-page PDF')
    const xlsxPdf = path.join(OUT_DIR, 'office-from-xlsx.pdf')
    await savePdf(page, xlsxPdf)
    const xlsxText = await pdfText(xlsxPdf, { itemSeparator: ' ' })
    check(xlsxText.includes('Region'), 'Excel shared strings survive')
    check(xlsxText.includes('North'), 'Excel cell values survive')
    check(xlsxText.includes('1250.5'), 'Excel numbers survive')
    check(xlsxText.includes('Inline cell'), 'Excel inline strings survive')
    check(xlsxText.includes('Merged title'), 'Excel merged cells survive')

    // ------------------------------------------------ PowerPoint -> PDF
    await importOffice(fixtures.pptx)
    check((await page.locator('.thumb').count()) === 1, 'PowerPoint deck opens as a one-page PDF')
    const pptxPdf = path.join(OUT_DIR, 'office-from-pptx.pdf')
    await savePdf(page, pptxPdf)
    const pptxText = await pdfText(pptxPdf, { itemSeparator: ' ' })
    check(pptxText.includes('Deck overview'), 'PowerPoint slide text survives')
    check((await pageXObjectCount(pptxPdf)) >= 1, 'PowerPoint pictures are embedded in the converted PDF')
    const titleBaseline = await firstTextBaseline(pptxPdf)
    check(
      titleBaseline.y > titleBaseline.height * 0.6,
      `PowerPoint text keeps its slide position (baseline ${Math.round(titleBaseline.y)} of ${Math.round(titleBaseline.height)})`,
    )

    // ------------------------------------------------------ PDF -> Word
    await gotoHome(page)
    await openPdf(page, SAMPLE_PDF, { resetZoom: false })
    const downloadOffice = async (label, extension) => {
      await openTools('Office')
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        page.click(`button:has-text("${label}")`),
      ])
      const file = path.join(OUT_DIR, `exported.${extension}`)
      await download.saveAs(file)
      return file
    }

    const docxOut = await downloadOffice('Word (.docx)', 'docx')
    const docxArchive = readZip(new Uint8Array(fs.readFileSync(docxOut)))
    check(
      (zipText(docxArchive, 'word/document.xml') ?? '').includes('RealPDF sample document'),
      'PDF → Word writes the document text',
    )
    check(
      (zipText(docxArchive, 'word/document.xml') ?? '').includes('w:pageBreakBefore'),
      'PDF → Word inserts page breaks between pages',
    )

    const xlsxOut = await downloadOffice('Excel (.xlsx)', 'xlsx')
    const xlsxArchive = readZip(new Uint8Array(fs.readFileSync(xlsxOut)))
    check(
      (zipText(xlsxArchive, 'xl/worksheets/sheet1.xml') ?? '').includes('RealPDF sample document'),
      'PDF → Excel fills the first sheet with the page text',
    )
    check(
      [...xlsxArchive.keys()].filter((name) => name.startsWith('xl/worksheets/sheet')).length === 3,
      'PDF → Excel creates one sheet per page',
    )

    const pptxOut = await downloadOffice('PowerPoint (.pptx)', 'pptx')
    const pptxArchive = readZip(new Uint8Array(fs.readFileSync(pptxOut)))
    check(
      (zipText(pptxArchive, 'ppt/slides/slide1.xml') ?? '').includes('RealPDF sample document'),
      'PDF → PowerPoint puts the page text on the slide',
    )
    check(
      [...pptxArchive.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length === 3,
      'PDF → PowerPoint creates one slide per page',
    )

    check(pageErrors.length === 0, `no browser errors (${pageErrors.slice(0, 3).join(' | ')})`)
  })
})
