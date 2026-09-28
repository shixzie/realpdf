/**
 * Signing yourself through the top bar's Sign button: adopt a drawn
 * signature backed by a PKCS#12 file, place it on a page, review, download
 * and verify the file independently (Node crypto for the CMS signature,
 * pdf.js for the signature field). Then countersign the signed file with a
 * typed signature, which must keep the first signature valid, and check that
 * the device remembers the signer (key non-exportable) until it is forgotten.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { check, dragOnPage, exportedPixelStats, gotoHome, launchApp, openPdf, pageBox } from '../helpers/app.mjs'
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

/** Top bar Sign → Sign yourself. */
async function startSelfSign(page) {
  await page.click('.sign-trigger')
  await page.waitForSelector('.sign-menu-self')
  await page.click('.sign-menu-self')
}

/** Draws a squiggle on the adopt dialog's signature pad. */
async function drawSignature(page) {
  await page.click('.adopt-style-draw')
  const pad = await page.locator('.adopt-pad').boundingBox()
  await page.mouse.move(pad.x + 60, pad.y + 120)
  await page.mouse.down()
  for (let i = 1; i <= 24; i += 1) {
    await page.mouse.move(pad.x + 60 + i * 18, pad.y + 100 + Math.sin(i / 2) * 40)
  }
  await page.mouse.up()
}

async function clickOnPage(page, point, index = 0) {
  const box = await pageBox(page, index)
  await page.mouse.click(box.x + point.x, box.y + point.y)
  await page.waitForTimeout(150)
}

async function reviewAndSign(page, filePath) {
  await page.click('.sign-finish')
  await page.waitForSelector('.sign-review')
  await page.click('.sign-submit')
  await page.waitForSelector('.sign-done', { timeout: 30000 })
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('.sign-download')])
  await download.saveAs(filePath)
  await page.click('.sign-done-close')
  await page.waitForSelector('.sign-done', { state: 'detached' })
  return download
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

  it('adopts a drawn signature, places it and signs with a certificate file', async () => {
    const { page, context, pageErrors } = app
    await gotoHome(page)
    await openPdf(page, SAMPLE_PDF)
    check((await page.locator('.export-trigger').count()) === 1, 'export stays separate from signing')
    await startSelfSign(page)
    await page.waitForSelector('.adopt-signature')
    check((await page.locator('.adopt-signature h2').innerText()) === 'Create your signature', 'first-time signers adopt a signature')

    // A certificate file instead of an email; a wrong password is reported.
    await page.setInputFiles('.adopt-file-input', p12Path)
    await page.waitForSelector('input[name="certificate-password"]')
    await drawSignature(page)
    await page.fill('input[name="certificate-password"]', 'not-the-password')
    await page.click('.adopt-submit')
    await page.waitForSelector('.adopt-signature .cert-error')
    check((await page.locator('.adopt-signature .cert-error').innerText()).includes('Wrong password'), 'wrong password is reported')

    await page.fill('input[name="certificate-password"]', p12.password)
    await page.click('.adopt-submit')
    await page.waitForSelector('.sign-bar')
    check((await page.locator('.adopt-signature').count()) === 0, 'the dialog makes way for placing')
    check((await page.locator('.sign-as').innerText()).includes('Ada Lovelace'), 'the bar says who is signing')
    check(await page.locator('.sign-finish').isDisabled(), 'finishing needs a placed signature')

    // Drag a box, then remove and re-add it to exercise the controls.
    await dragOnPage(page, { x: 330, y: 640 }, { x: 540, y: 720 })
    check((await page.locator('.sign-spot').count()) === 1, 'a signature is placed')
    check((await page.locator('.sign-spot img').count()) === 1, 'the placed signature shows the drawn image')
    await page.click('.sign-spot-remove')
    check((await page.locator('.sign-spot').count()) === 0, 'a placed signature can be removed')
    await dragOnPage(page, { x: 330, y: 640 }, { x: 540, y: 720 })

    await page.click('.sign-finish')
    await page.waitForSelector('.sign-review')
    const review = await page.locator('.sign-review-card').innerText()
    check(review.includes('Ada Lovelace') && review.includes('page 1'), `review shows signer and page (${review})`)
    await page.click('.sign-more summary')
    await page.fill('input[name="signature-reason"]', 'I approve this document')
    await page.fill('input[name="signature-location"]', 'London')
    await page.click('.sign-submit')
    await page.waitForSelector('.sign-done', { timeout: 30000 })
    check((await page.locator('.sign-done').innerText()).includes('Signed by Ada Lovelace'), 'done step names the signer')

    const signedPath = path.join(OUT_DIR, 'digitally-signed.pdf')
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('.sign-download')])
    check(download.suggestedFilename().endsWith('-signed.pdf'), `signed file name (${download.suggestedFilename()})`)
    await download.saveAs(signedPath)
    await page.click('.sign-done-close')

    const signed = fs.readFileSync(signedPath)
    const original = fs.readFileSync(SAMPLE_PDF)
    check(signed.subarray(0, original.length).equals(original), 'an unchanged document is signed as an incremental update')
    const [result] = verifyPdfSignatures(signed)
    check(result?.valid === true, `signature verifies (${JSON.stringify({ ...result, certificates: undefined })})`)
    check(result?.coversFile === true, 'signature covers the whole file')
    check(result?.hasSigningCertificateV2 === true, 'PAdES signing-certificate-v2 attribute is present')
    check(result?.certificates?.[0]?.equals(p12.certificateDer), 'signer certificate is embedded')
    const update = signed.subarray(original.length).toString('latin1')
    check(update.includes('/SubFilter /ETSI.CAdES.detached'), 'PAdES sub-filter')
    check(update.includes('/Subtype /Image'), 'the handwritten signature is embedded in the appearance')
    check(update.includes('/Reason'), 'the reason is recorded')

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

  it('countersigns with a typed signature without breaking the first one', async () => {
    const { page, pageErrors } = app
    const firstPath = path.join(OUT_DIR, 'digitally-signed.pdf')
    await gotoHome(page)
    await openPdf(page, firstPath)
    // The remembered signer goes straight to placing; switch to another one.
    await startSelfSign(page)
    await page.waitForSelector('.sign-bar')
    check((await page.locator('.sign-as').innerText()).includes('Ada Lovelace'), 'the remembered signature is used')
    await page.click('.sign-change')
    await page.waitForSelector('.adopt-identity')
    await page.click('.adopt-switch')
    await page.waitForSelector('.saved-cert')
    await page.setInputFiles('.adopt-file-input', secondPath)
    await page.fill('input[name="signer-name"]', 'Charles Babbage')
    await page.fill('input[name="certificate-password"]', second.password)
    await page.click('.adopt-font:nth-child(2)')
    await page.click('.adopt-submit')
    await page.waitForSelector('.adopt-signature', { state: 'detached' })
    check((await page.locator('.sign-as').innerText()).includes('Charles Babbage'), 'the new signer is used')

    await clickOnPage(page, { x: 150, y: 700 })
    check((await page.locator('.sign-spot').count()) === 1, 'a click places a default-size signature')
    await page.click('.sign-finish')
    await page.waitForSelector('.sign-review')
    await page.click('.sign-more summary')
    check(await page.locator('input[name="signature-certify"]').isDisabled(), 'certifying is unavailable once signed')
    await page.click('.sign-review-back')

    const countersignedPath = path.join(OUT_DIR, 'digitally-countersigned.pdf')
    await reviewAndSign(page, countersignedPath)

    const results = verifyPdfSignatures(fs.readFileSync(countersignedPath))
    check(results.length === 2, `two signatures (${results.length})`)
    check(results.every((result) => result.valid), 'both signatures verify')
    check(results[1]?.coversFile === true && results[0]?.coversFile === false, 'the new signature covers the whole file')
    check(String(results[1]?.signer).includes('Charles Babbage'), 'the second signer is recorded')
    check((await signatureWidgets(countersignedPath)).length === 2, 'two visible signatures')
    check(pageErrors.length === 0, `no browser errors: ${pageErrors.join(' | ')}`)
  })

  it('remembers signers on this device with non-exportable keys until forgotten', async () => {
    const { page, pageErrors } = app
    const stored = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const request = indexedDB.open('realpdf-signing')
          request.onsuccess = () => {
            const read = request.result.transaction('identities').objectStore('identities').getAll()
            read.onsuccess = async () => {
              const entries = []
              for (const entry of read.result) {
                let exported = true
                try {
                  await crypto.subtle.exportKey('pkcs8', entry.key)
                } catch {
                  exported = false
                }
                entries.push({ name: entry.info.name, extractable: entry.key.extractable, exported })
              }
              resolve(entries)
            }
          }
          request.onerror = () => resolve(null)
        }),
    )
    check(stored?.length === 2, `both signers are remembered (${JSON.stringify(stored)})`)
    check(stored?.every((entry) => entry.extractable === false && entry.exported === false), 'remembered keys cannot be exported')

    // After a reload, Sign goes straight to placing with the latest signer.
    await page.reload()
    await page.waitForSelector('.empty-card')
    await openPdf(page, SAMPLE_PDF)
    await startSelfSign(page)
    await page.waitForSelector('.sign-bar')
    check((await page.locator('.sign-as').innerText()).includes('Charles Babbage'), 'the latest signer is picked')

    // Forget both from the adopt dialog.
    await page.click('.sign-change')
    await page.waitForSelector('.adopt-forget')
    await page.click('.adopt-forget')
    await page.waitForSelector('.saved-cert')
    check((await page.locator('.saved-cert').innerText()).includes('Ada Lovelace'), 'the other saved signer is listed')
    await page.click('.saved-cert-forget')
    await page.waitForSelector('.saved-cert', { state: 'detached' })
    // The list updates at once; wait for the keys to leave IndexedDB before reloading.
    await page.waitForFunction(
      () =>
        new Promise((resolve) => {
          const request = indexedDB.open('realpdf-signing')
          request.onsuccess = () => {
            const count = request.result.transaction('identities').objectStore('identities').count()
            count.onsuccess = () => resolve(count.result === 0)
          }
          request.onerror = () => resolve(false)
        }),
    )
    await page.reload()
    await page.waitForSelector('.empty-card')
    await openPdf(page, SAMPLE_PDF)
    await startSelfSign(page)
    await page.waitForSelector('.adopt-signature')
    await page.waitForTimeout(500)
    check((await page.locator('.adopt-identity, .saved-cert').count()) === 0, 'forgotten signers are gone after a reload')
    check((await page.locator('input[name="signer-email"]').count()) === 1, 'a new signer starts with name and email')
    check(pageErrors.length === 0, `no browser errors: ${pageErrors.join(' | ')}`)
  })
})
