/**
 * Certificate signing suite: unlock a PKCS#12 file, draw the signature box on
 * a page, download the signed PDF and verify it independently (Node crypto for
 * the CMS signature, pdf.js for the signature field). Then open the signed
 * file and countersign it, which must keep the first signature valid, and
 * remember a certificate on the device, reuse it after a reload and forget it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { check, dragOnPage, exportedPixelStats, gotoHome, launchApp, openPdf } from '../helpers/app.mjs'
import { OUT_DIR, SAMPLE_PDF } from '../helpers/fixtures.mjs'
import { makeRsaPkcs12, verifyPdfSignatures } from '../helpers/signing.mjs'

async function signatureWidgets(filePath) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(filePath)), isEvalSupported: false })
    .promise
  const widgets = []
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index)
    const view = page.view
    for (const annotation of await page.getAnnotations()) {
      if (annotation.fieldType === 'Sig') widgets.push({ ...annotation, pageNumber: index, pageHeight: view[3] })
    }
  }
  return widgets
}

async function openSignDialog(page) {
  await page.click('.export-trigger')
  await page.waitForSelector('.export-menu-item-sign')
  await page.click('.export-menu-item-sign')
  await page.waitForSelector('.digital-sign')
}

async function unlock(page, p12Path, password) {
  await page.setInputFiles('.digital-sign-file-input', p12Path)
  await page.waitForSelector('input[name="certificate-password"]')
  await page.fill('input[name="certificate-password"]', password)
  await page.click('.digital-sign-unlock button[type="submit"]')
}

describe('digital signatures', () => {
  let app
  const p12 = makeRsaPkcs12({ name: 'Ada Lovelace' })
  const second = makeRsaPkcs12({ name: 'Charles Babbage', password: 'engine' })
  const p12Path = path.join(OUT_DIR, 'ada.p12')
  const secondPath = path.join(OUT_DIR, 'babbage.pfx')

  beforeAll(async () => {
    fs.writeFileSync(p12Path, p12.bytes)
    fs.writeFileSync(secondPath, second.bytes)
    app = await launchApp({ viewport: { width: 1500, height: 1000 } })
  })

  afterAll(async () => {
    await app?.browser.close()
  })

  it('signs with a certificate and a visible signature placed on the page', async () => {
    const { page, context, pageErrors } = app
    await gotoHome(page)
    await openPdf(page, SAMPLE_PDF)
    await openSignDialog(page)

    // A wrong password is reported and nothing is unlocked.
    await unlock(page, p12Path, 'not-the-password')
    await page.waitForSelector('.cert-error')
    check((await page.locator('.cert-error').innerText()).includes('Wrong password'), 'wrong password is reported')
    check(await page.locator('.digital-sign-submit').isDisabled(), 'signing stays disabled until unlocked')

    await page.fill('input[name="certificate-password"]', p12.password)
    await page.click('.digital-sign-unlock button[type="submit"]')
    await page.waitForSelector('.cert-summary')
    check((await page.locator('.cert-name').innerText()) === 'Ada Lovelace', 'certificate owner is shown')
    check((await page.locator('.cert-summary').innerText()).includes('RealPDF Test CA'), 'issuer is shown')

    await page.fill('input[name="signature-reason"]', 'I approve this document')
    await page.fill('input[name="signature-location"]', 'London')
    await page.click('.digital-sign-submit')
    await page.waitForSelector('.sign-banner')
    check((await page.locator('.digital-sign').count()) === 0, 'dialog makes way for placing the box')

    const signedPath = path.join(OUT_DIR, 'digitally-signed.pdf')
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      dragOnPage(page, { x: 330, y: 640 }, { x: 540, y: 720 }),
    ])
    check(download.suggestedFilename().endsWith('-signed.pdf'), `signed file name (${download.suggestedFilename()})`)
    await download.saveAs(signedPath)
    await page.waitForSelector('.digital-sign', { state: 'detached' })

    const signed = fs.readFileSync(signedPath)
    const original = fs.readFileSync(SAMPLE_PDF)
    check(signed.subarray(0, original.length).equals(original), 'an unchanged document is signed as an incremental update')
    const [result] = verifyPdfSignatures(signed)
    check(result?.valid === true, `signature verifies (${JSON.stringify({ ...result, certificates: undefined })})`)
    check(result?.coversFile === true, 'signature covers the whole file')
    check(result?.hasSigningCertificateV2 === true, 'PAdES signing-certificate-v2 attribute is present')
    check(result?.certificates?.[0]?.equals(p12.certificateDer), 'signer certificate is embedded')
    const text = signed.toString('latin1')
    check(text.includes('/SubFilter /ETSI.CAdES.detached'), 'PAdES sub-filter')

    const [widget] = await signatureWidgets(signedPath)
    check(widget?.pageNumber === 1, 'signature field is on the first page')
    const [x1, y1, x2, y2] = widget?.rect ?? []
    const height = widget?.pageHeight ?? 0
    check(
      Math.abs(x1 - 330) < 2 && Math.abs(x2 - 540) < 2 && Math.abs(y1 - (height - 720)) < 2 && Math.abs(y2 - (height - 640)) < 2,
      `signature rectangle matches the drawn box (${widget?.rect})`,
    )

    // The appearance is drawn where the box was placed.
    const inside = await exportedPixelStats(context, signedPath, { x: 335, y: 645, w: 200, h: 70 })
    check(inside.dark > 40, `visible signature renders (${inside.dark} dark pixels)`)

    check(pageErrors.length === 0, `no browser errors: ${pageErrors.join(' | ')}`)
  })

  it('countersigns an already signed PDF without breaking the first signature', async () => {
    const { page, pageErrors } = app
    const firstPath = path.join(OUT_DIR, 'digitally-signed.pdf')
    await gotoHome(page)
    await openPdf(page, firstPath)
    await openSignDialog(page)
    await unlock(page, secondPath, second.password)
    await page.waitForSelector('.cert-summary')
    check(await page.locator('input[name="signature-certify"]').isDisabled(), 'certifying is unavailable once signed')
    await page.selectOption('select[name="signature-placement"]', 'invisible')

    const countersignedPath = path.join(OUT_DIR, 'digitally-countersigned.pdf')
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('.digital-sign-submit'),
    ])
    await download.saveAs(countersignedPath)

    const results = verifyPdfSignatures(fs.readFileSync(countersignedPath))
    check(results.length === 2, `two signatures (${results.length})`)
    check(results.every((result) => result.valid), 'both signatures verify')
    check(results[1]?.coversFile === true && results[0]?.coversFile === false, 'the new signature covers the whole file')
    check(String(results[1]?.signer).includes('Charles Babbage'), 'the second signer is recorded')
    check(pageErrors.length === 0, `no browser errors: ${pageErrors.join(' | ')}`)
  })

  it('remembers a certificate on this device as a non-exportable key', async () => {
    const { page, pageErrors } = app
    await gotoHome(page)
    await openPdf(page, SAMPLE_PDF)
    await openSignDialog(page)
    await page.setInputFiles('.digital-sign-file-input', secondPath)
    await page.check('input[name="certificate-remember"]')
    await page.fill('input[name="certificate-password"]', second.password)
    await page.click('.digital-sign-unlock button[type="submit"]')
    await page.waitForSelector('.cert-remembered')
    await page.click('.modal-head .icon-button')

    // The stored key is the CryptoKey itself and cannot be exported.
    const stored = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const request = indexedDB.open('realpdf-signing')
          request.onsuccess = () => {
            const read = request.result.transaction('identities').objectStore('identities').getAll()
            read.onsuccess = async () => {
              const [entry] = read.result
              let exported = true
              try {
                await crypto.subtle.exportKey('pkcs8', entry.key)
              } catch {
                exported = false
              }
              resolve({ count: read.result.length, extractable: entry.key.extractable, exported, name: entry.info.name })
            }
          }
          request.onerror = () => resolve(null)
        }),
    )
    check(stored?.count === 1 && stored?.name === 'Charles Babbage', `one identity is remembered (${JSON.stringify(stored)})`)
    check(stored?.extractable === false && stored?.exported === false, 'the remembered key cannot be exported')

    // After a reload the certificate is offered without the file or password.
    await page.reload()
    await page.waitForSelector('.empty-card')
    await openPdf(page, SAMPLE_PDF)
    await openSignDialog(page)
    await page.waitForSelector('.saved-cert')
    check((await page.locator('.saved-cert').innerText()).includes('Charles Babbage'), 'saved certificate is listed')
    await page.click('.saved-cert-use')
    await page.waitForSelector('.cert-summary')
    await page.selectOption('select[name="signature-placement"]', 'invisible')
    const savedPath = path.join(OUT_DIR, 'digitally-signed-saved.pdf')
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('.digital-sign-submit'),
    ])
    await download.saveAs(savedPath)
    const [result] = verifyPdfSignatures(fs.readFileSync(savedPath))
    check(result?.valid === true && String(result?.signer).includes('Charles Babbage'), 'signs with the remembered key')

    // Forgetting removes it.
    await openSignDialog(page)
    await page.waitForSelector('.saved-cert')
    await page.click('.saved-cert-forget')
    await page.waitForSelector('.saved-cert', { state: 'detached' })
    await page.reload()
    await page.waitForSelector('.empty-card')
    await openPdf(page, SAMPLE_PDF)
    await openSignDialog(page)
    await page.waitForTimeout(500)
    check((await page.locator('.saved-cert').count()) === 0, 'forgotten certificate is gone after a reload')
    check(pageErrors.length === 0, `no browser errors: ${pageErrors.join(' | ')}`)
  })
})
