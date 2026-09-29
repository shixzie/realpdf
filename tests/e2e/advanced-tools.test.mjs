import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib'
import { check, gotoHome, launchApp, openFileTools, openPdf, pdfText, dragOnPage } from '../helpers/app.mjs'
import { OUT_DIR, SAMPLE_PDF } from '../helpers/fixtures.mjs'

async function chooseTool(page, title) {
  await openFileTools(page, 'More PDF tools')
  if (await page.locator('.tool-back').count()) await page.locator('.tool-back').click()
  await page.getByRole('button', { name: title, exact: false }).filter({ has: page.locator('strong') }).click()
}

async function createResult(page, name) {
  await page.getByRole('button', { name: 'Create result', exact: true }).click()
  await page.waitForSelector('.tool-result, .document-tool-panel [role="alert"]', { timeout: 60000 })
  const error = page.locator('.document-tool-panel [role="alert"]')
  if (await error.count()) throw new Error(await error.innerText())
  const downloaded = page.waitForEvent('download')
  await page.locator('.tool-result').getByRole('button', { name: 'Download', exact: true }).click()
  const output = path.join(OUT_DIR, name)
  await (await downloaded).saveAs(output)
  return output
}

async function extraDownload(page, name) {
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Create download', exact: true }).click()
  const output = path.join(OUT_DIR, name)
  await (await downloaded).saveAs(output)
  return output
}

describe('additional document tools through the UI', () => {
  let app
  beforeAll(async () => { app = await launchApp({ viewport: { width: 1440, height: 1000 } }) })
  afterAll(async () => { await app?.browser.close() })

  it('creates, marks, rotates, protects, unlocks, and converts HTML locally', async () => {
    const { page } = app
    await gotoHome(page)
    await chooseTool(page, 'Create PDF')
    await page.getByLabel('Number of pages').fill('2')
    const blank = await createResult(page, 'advanced-blank.pdf')
    check((await PDFDocument.load(fs.readFileSync(blank))).getPageCount() === 2, 'blank tool creates requested pages')
    await page.getByRole('button', { name: 'Open result in editor' }).click()
    await page.waitForSelector('.page canvas.page-base')
    await chooseTool(page, 'Add watermark')
    await page.getByLabel('Watermark text').fill('CONFIDENTIAL')
    await page.getByLabel('Pages, for example 1-3,5').fill('2')
    const marked = await createResult(page, 'advanced-watermark.pdf')
    const markText = await pdfText(marked, { pageSeparator: '\n' })
    check(markText.split('\n')[0] === '' && markText.includes('CONFIDENTIAL'), 'watermark appears only on selected second page')
    await chooseTool(page, 'Add page numbers')
    await page.getByLabel('Start number').fill('8')
    const numbered = await createResult(page, 'advanced-numbered.pdf')
    check((await pdfText(numbered)).includes('8') && (await pdfText(numbered)).includes('9'), 'numbered output contains sequence')
    await chooseTool(page, 'Rotate pages')
    await page.getByLabel('Pages, for example 1-3,5').fill('2')
    const rotated = await createResult(page, 'advanced-rotated.pdf')
    const rotation = await PDFDocument.load(fs.readFileSync(rotated))
    check(rotation.getPage(0).getRotation().angle === 0 && rotation.getPage(1).getRotation().angle === 90, 'rotation only affects selected pages')
    await chooseTool(page, 'Protect PDF')
    await page.getByLabel('Password', { exact: true }).fill('local-test-password')
    await page.getByLabel('Confirm password').fill('local-test-password')
    const protectedFile = await createResult(page, 'advanced-protected.pdf')
    check((await PDFDocument.load(fs.readFileSync(protectedFile), { ignoreEncryption: true })).isEncrypted, 'protected output uses actual PDF encryption')
    await chooseTool(page, 'Unlock PDF')
    await page.getByLabel('PDF file', { exact: true }).setInputFiles(protectedFile)
    await page.getByLabel('Password', { exact: true }).fill('local-test-password')
    const unlocked = await createResult(page, 'advanced-unlocked.pdf')
    check(!(await PDFDocument.load(fs.readFileSync(unlocked))).isEncrypted, 'unlocked output opens without a password')
    await chooseTool(page, 'Webpage to PDF')
    await page.getByLabel('HTML source').fill('<h1>Local webpage</h1><p>Visible content.</p><script>fetch("https://example.com/secret")</script><style>hidden CSS</style><p hidden>Hidden text</p>')
    const html = await createResult(page, 'advanced-webpage.pdf')
    const htmlText = await pdfText(html)
    check(htmlText.includes('Local webpage') && htmlText.includes('Visible content.') && !htmlText.includes('secret') && !htmlText.includes('Hidden text'), 'HTML exports visible text and ignores executable content')
  })

  it('keeps edits in tool outputs and removes covered content in redacted output', async () => {
    const { page } = app
    await gotoHome(page)
    await openPdf(page, SAMPLE_PDF)
    await page.getByRole('button', { name: 'Cover', exact: false }).first().click()
    await dragOnPage(page, { x: 45, y: 25 }, { x: 550, y: 160 })
    await chooseTool(page, 'Redact PDF')
    await page.getByRole('checkbox').check()
    const redacted = await createResult(page, 'advanced-redacted.pdf')
    check((await pdfText(redacted)).trim() === '', 'redacted file has no recoverable text layer')
    const doc = await PDFDocument.load(fs.readFileSync(redacted), { updateMetadata: false })
    check(doc.getPageCount() === 3 && doc.getForm().getFields().length === 0, 'redaction retains all pages and removes forms')
    check(!doc.context.trailerInfo.Info && !doc.catalog.has(PDFName.of('Metadata')), 'redaction output has no document metadata')
    const resource = doc.getPage(0).node.Resources().lookup(PDFName.of('XObject'), PDFDict)
    check(resource.keys().length === 1, 'redaction rebuilds page as a single image')
    await chooseTool(page, 'Compare PDFs')
    await page.getByLabel('PDF to compare').setInputFiles(SAMPLE_PDF)
    await createResult(page, 'advanced-compare.pdf')
    check((await page.locator('.tool-result').innerText()).includes('1 of 3'), 'comparison includes current cover edit')
  })

  it('creates fillable fields, metadata, bookmarks, and searches current content', async () => {
    const { page } = app
    await gotoHome(page)
    await openPdf(page, SAMPLE_PDF, { resetZoom: false })
    await chooseTool(page, 'Fillable fields')
    await page.getByLabel('Field name').fill('Customer')
    await page.getByLabel('Initial value', { exact: true }).fill('Ada')
    const fields = await extraDownload(page, 'advanced-fields.pdf')
    const form = (await PDFDocument.load(fs.readFileSync(fields))).getForm()
    check(form.getTextField('Customer').getText() === 'Ada', 'created form field stores its value')
    await chooseTool(page, 'Edit metadata')
    await page.getByLabel('Document title', { exact: true }).fill('Private title')
    const metadata = await extraDownload(page, 'advanced-metadata.pdf')
    check((await PDFDocument.load(fs.readFileSync(metadata))).getTitle() === 'Private title', 'metadata UI writes document title')
    await chooseTool(page, 'Create bookmarks')
    await page.getByLabel('Title and page lines').fill('Introduction | 1\nSecond | 2')
    const bookmarks = await extraDownload(page, 'advanced-bookmarks.pdf')
    const bookmarked = await PDFDocument.load(fs.readFileSync(bookmarks))
    check(bookmarked.catalog.has(PDFName.of('Outlines')), 'bookmark UI creates document outlines')
    await chooseTool(page, 'Search text')
    await page.getByLabel('Search phrase').fill('RealPDF sample')
    await page.getByRole('button', { name: 'Search text', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.tools-body')?.textContent?.includes('1:'))
    check((await page.locator('.tools-body').innerText()).includes('RealPDF sample document'), 'search finds the sample text on its page')
  })
})
