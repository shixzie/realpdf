/**
 * Signing requests end to end: a sender creates an encrypted link, a signer
 * with no certificate opens it, creates a signing ID by email (the dev
 * server's outbox stands in for the mailbox), signs, and the sender gets the
 * signed copy back through the same link. Signatures are verified with
 * Node's crypto, independently of the app.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { appUrl, check, dragOnPage, gotoHome, launchApp, openPdf } from '../helpers/app.mjs'
import { OUT_DIR, SAMPLE_PDF } from '../helpers/fixtures.mjs'
import { verifyPdfSignatures } from '../helpers/signing.mjs'

async function latestCode(page, email) {
  const response = await page.request.get(new URL(`/api/dev/outbox?to=${encodeURIComponent(email)}`, appUrl()).href)
  const messages = await response.json()
  return messages.at(-1)?.text.match(/\b(\d{6})\b/)?.[1]
}

describe('signing requests', () => {
  let sender
  let signer
  let link
  const uploads = []
  // A wrong verification code is a 400 response, which Chromium logs.
  const errorsOf = (app) => app.pageErrors.filter((error) => !error.includes('Failed to load resource'))

  beforeAll(async () => {
    sender = await launchApp({ viewport: { width: 1500, height: 1000 } })
    signer = await launchApp({ viewport: { width: 1500, height: 1000 } })
    for (const app of [sender, signer]) {
      app.page.on('request', (request) => {
        if (request.url().includes('/api/sign-requests') && request.method() === 'POST') {
          uploads.push({ url: request.url(), body: request.postDataBuffer() })
        }
      })
    }
  })

  afterAll(async () => {
    await sender?.browser.close()
    await signer?.browser.close()
  })

  it('creates an encrypted signing link', async () => {
    const { page, pageErrors } = sender
    await gotoHome(page)
    await openPdf(page, SAMPLE_PDF)
    await page.click('.export-trigger')
    await page.waitForSelector('.export-menu-item-request')
    await page.click('.export-menu-item-request')
    await page.waitForSelector('.request-sign')
    await page.fill('input[name="request-from"]', 'Juan')
    await page.fill('input[name="request-message"]', 'Please sign the first page')
    await page.click('.request-create')
    await page.waitForSelector('.request-link')
    link = await page.inputValue('.request-link')
    check(/\/sign\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$/.test(link), `link has an id and a key fragment (${link})`)

    const [upload] = uploads
    const key = link.split('#')[1]
    check(upload && !upload.url.includes('#') && !upload.url.includes(key), 'the key is never sent to the server')
    check(upload?.body && !upload.body.includes(Buffer.from('%PDF')), 'the upload is not a readable PDF')
    check(upload?.body && !upload.body.includes(Buffer.from('Please sign')), 'the message is encrypted too')

    check((await page.locator('.request-sign .my-request').count()) === 1, 'the new request is listed')
    await page.click('.request-sign .modal-head .icon-button')
    check(pageErrors.length === 0, `no browser errors: ${pageErrors.join(' | ')}`)
  })

  it('lets someone without a certificate create a signing ID and sign', async () => {
    const { page } = signer
    await page.goto(link, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.sign-request-bar')
    await page.waitForSelector('.page canvas.page-base', { timeout: 20000 })
    const bar = await page.locator('.sign-request-bar').innerText()
    check(bar.includes('Juan asked you to sign'), `the bar says who asked (${bar})`)
    check(bar.includes('Please sign the first page'), 'the message is shown')
    await page.click('button.zoom-label')
    await page.waitForTimeout(300)

    await page.click('.sign-request-sign')
    await page.waitForSelector('.signing-id')
    await page.fill('input[name="signer-name"]', 'Grace Hopper')
    await page.fill('input[name="signer-email"]', 'Grace@Example.com')
    await page.click('.signing-id-send')
    await page.waitForSelector('input[name="signer-code"]')
    check((await page.locator('.signing-id-sent').innerText()).includes('grace@example.com'), 'the address the code went to is shown')

    const code = await latestCode(page, 'grace@example.com')
    check(/^\d{6}$/.test(code ?? ''), 'a code was emailed')
    await page.fill('input[name="signer-code"]', code === '000000' ? '111111' : '000000')
    await page.click('.signing-id-verify')
    await page.waitForSelector('.signing-id .cert-error')
    check((await page.locator('.signing-id .cert-error').innerText()).includes('not right'), 'a wrong code is reported')
    await page.fill('input[name="signer-code"]', code)
    await page.click('.signing-id-verify')
    await page.waitForSelector('.cert-summary')
    check((await page.locator('.cert-name').innerText()) === 'Grace Hopper', 'the new signing ID is selected')
    check((await page.locator('.cert-summary').innerText()).includes('RealPDF'), 'issued by RealPDF')
    check((await page.locator('.cert-remembered').count()) === 1, 'the signing ID is remembered on this device')

    await page.click('.digital-sign-submit')
    await page.waitForSelector('.sign-banner')
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      dragOnPage(page, { x: 330, y: 640 }, { x: 540, y: 720 }),
    ])
    const signedPath = path.join(OUT_DIR, 'request-signed-by-signer.pdf')
    await download.saveAs(signedPath)
    await page.waitForSelector('.sign-request-bar.is-done', { timeout: 30000 })

    const [result] = verifyPdfSignatures(fs.readFileSync(signedPath))
    check(result?.valid === true && result?.coversFile === true, 'the signer copy verifies')
    const certificate = result?.certificates?.[0] && new crypto.X509Certificate(result.certificates[0])
    check(certificate?.subject.includes('CN=Grace Hopper'), `certificate names the signer (${certificate?.subject})`)
    check(certificate?.subjectAltName === 'email:grace@example.com', 'certificate carries the verified email')
    const issuer = result?.certificates?.[1] && new crypto.X509Certificate(result.certificates[1])
    check(issuer && certificate?.verify(issuer.publicKey), 'the chain includes the issuing CA')

    const stored = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const request = indexedDB.open('realpdf-signing')
          request.onsuccess = () => {
            const read = request.result.transaction('identities').objectStore('identities').getAll()
            read.onsuccess = () => resolve(read.result.map((entry) => ({ name: entry.info.name, extractable: entry.key.extractable })))
          }
          request.onerror = () => resolve(null)
        }),
    )
    check(
      stored?.length === 1 && stored[0].name === 'Grace Hopper' && stored[0].extractable === false,
      `the private key is stored non-extractable (${JSON.stringify(stored)})`,
    )
    check(errorsOf(signer).length === 0, `no browser errors: ${errorsOf(signer).join(' | ')}`)
  })

  it('returns the signed copy to the sender through the same link', async () => {
    const { page, pageErrors } = sender
    await page.goto(link, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.sign-request-bar')
    const bar = await page.locator('.sign-request-bar').innerText()
    check(bar.includes('Your signing request'), `the sender sees their own request (${bar})`)
    check(bar.includes('Signed by Grace Hopper'), 'the sender sees who signed')

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('.sign-request-download')])
    const returnedPath = path.join(OUT_DIR, 'request-returned.pdf')
    await download.saveAs(returnedPath)
    const returned = fs.readFileSync(returnedPath)
    const [result] = verifyPdfSignatures(returned)
    check(result?.valid === true && result?.coversFile === true, 'the returned copy verifies')
    const original = fs.readFileSync(SAMPLE_PDF)
    check(returned.subarray(0, original.length).equals(original), 'the unchanged document was signed as an incremental update')

    // The home screen lists the request with its signed copy, and deleting it
    // makes the link stop working.
    await page.click('.brand-home')
    await page.waitForSelector('.home-requests .my-request')
    await page.waitForFunction(() => document.querySelector('.home-requests .my-request')?.textContent?.includes('1 signed copy'))
    await page.click('.home-requests .my-request-delete')
    await page.waitForSelector('.home-requests .my-request', { state: 'detached' })
    check(page.url() === new URL('/', appUrl()).href, `closing the request resets the address (${page.url()})`)
    check(pageErrors.length === 0, `no browser errors: ${pageErrors.join(' | ')}`)

    await signer.page.goto(link, { waitUntil: 'domcontentloaded' })
    await signer.page.waitForSelector('.toast')
    check((await signer.page.locator('.toast').innerText()).includes('does not exist'), 'a deleted link says so')
  })
})
