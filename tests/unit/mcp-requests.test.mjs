/**
 * Signing requests through the MCP tools, mixed with the browser's own client
 * (src/lib/signRequests.ts) on one in-memory store: an agent creates a request,
 * a person opens and signs it the way the app does, and the agent checks the
 * status and downloads the signed PDF. The browser client runs here with
 * `fetch`, `window` and `localStorage` pointed at the same handlers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { handleMcp } from '../../worker/mcp/index.ts'
import { handleApi } from '../../worker/api.ts'
import { memoryStore } from '../../worker/store.ts'
import { makeDevCertificateAuthority } from '../../worker/devServer.ts'
import { enrollmentProofMessage } from '../../worker/signingIdentity.ts'
import { certificateInfo, parseCertificate, loadSigningIdentity } from '../../src/lib/signing/identity.ts'
import { signPdf } from '../../src/lib/signing/pdfSign.ts'
import { parseRequestLink } from '../../src/lib/signing/requestEnvelope.ts'
import { makeRsaPkcs12 } from '../helpers/signing.mjs'

const ORIGIN = 'https://realpdf.app'
const outbox = []
let ca
const deps = {
  store: memoryStore(),
  certificateAuthority: () => (ca ??= makeDevCertificateAuthority()),
  sendEmail: async (message) => {
    outbox.push(message)
  },
}

// The browser client calls relative /api/ URLs and keeps its list in localStorage.
const saved = { fetch: globalThis.fetch, window: globalThis.window, localStorage: globalThis.localStorage }
let browser
beforeAll(async () => {
  const items = new Map()
  globalThis.localStorage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  }
  globalThis.window = { location: new URL(ORIGIN) }
  globalThis.fetch = async (input, init) => handleApi(new Request(new URL(String(input), ORIGIN), init), deps)
  browser = await import('../../src/lib/signRequests.ts')
})
afterAll(() => Object.assign(globalThis, saved))

let nextId = 1
async function tool(name, args) {
  const response = await handleMcp(
    new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
    }),
    deps,
  )
  const body = await response.json()
  if (body.error) throw new Error(body.error.message)
  return body.result
}

async function contract(pages = 1) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i += 1) doc.addPage([595, 842]).drawText(`Contract page ${i + 1}`, { x: 72, y: 760, size: 18, font })
  return Buffer.from(await doc.save())
}

/** Enrolls an email-verified certificate through /api/identity, as the app does. */
async function verifiedIdentity(email, name) {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  const post = async (path, body) =>
    (await handleApi(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), deps)).json()
  const { challengeId } = await post('/api/identity/verify-email', { email })
  const code = /\b(\d{6})\b/.exec(outbox.filter((message) => message.to === email).at(-1).text)[1]
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey))
  const proof = Buffer.from(
    await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, keys.privateKey, new TextEncoder().encode(enrollmentProofMessage(challengeId))),
  )
  const issued = await post('/api/identity/certificate', {
    challengeId,
    code,
    name,
    publicKey: spki.toString('base64'),
    proof: proof.toString('base64'),
  })
  const certificate = new Uint8Array(Buffer.from(issued.certificate, 'base64'))
  return {
    certificate,
    chain: issued.chain.map((der) => new Uint8Array(Buffer.from(der, 'base64'))),
    key: keys.privateKey,
    keyType: 'RSA',
    info: certificateInfo(parseCertificate(certificate)),
  }
}

describe('signing requests over MCP', () => {
  it('lets an agent send a PDF, a person sign it in the app, and the agent collect it', async () => {
    const created = await tool('create_signing_request', {
      pdf_base64: (await contract()).toString('base64'),
      file_name: 'Contract.pdf',
      from: 'Acme Legal',
      message: 'Please sign by Friday.',
      signature_fields: [
        { name: 'Client', page: 1, x: 60, y: 60, width: 200, height: 60 },
        { name: 'Vendor', page: 1, x: 330, y: 60, width: 200, height: 60 },
      ],
    })
    expect(created.isError).toBeUndefined()
    const { link, owner_token: ownerToken, request_id: id } = created.structuredContent
    expect(link).toMatch(new RegExp(`^${ORIGIN}/sign/${id}#[A-Za-z0-9_-]{43}$`))
    expect(created.structuredContent.signature_fields).toEqual(['Client', 'Vendor'])
    expect(created.content[0].text).toContain(link)

    // Nothing is signed yet; both fields are pending.
    const before = await tool('get_signing_request', { link })
    expect(before.structuredContent).toMatchObject({
      request_id: id,
      file_name: 'Contract.pdf',
      from: 'Acme Legal',
      message: 'Please sign by Friday.',
      signed_versions: 0,
      signatures: [],
      pending_fields: ['Client', 'Vendor'],
      complete: false,
    })

    // The signer opens the link in the app (browser client) and signs the Client field
    // with an email-verified certificate RealPDF issued.
    const { key } = parseRequestLink(link)
    const opened = await browser.openRequest(id, key)
    expect(opened.header).toMatchObject({ fileName: 'Contract.pdf', from: 'Acme Legal', message: 'Please sign by Friday.', signers: [] })
    const client = await verifiedIdentity('grace@example.com', 'Grace Hopper')
    const signedOnce = await signPdf(opened.bytes, { identity: client, placement: { kind: 'field', name: 'Client' } })
    await browser.addSignedVersion(opened, signedOnce, 'Grace Hopper')

    const middle = await tool('get_signing_request', { link })
    expect(middle.structuredContent.signed_versions).toBe(1)
    expect(middle.structuredContent.pending_fields).toEqual(['Vendor'])
    expect(middle.structuredContent.signatures).toMatchObject([
      { field: 'Client', signer: 'Grace Hopper', email: 'grace@example.com', email_verified_by_realpdf: true, intact: true },
    ])
    expect(middle.content[0].text).toContain('Still waiting on: "Vendor"')

    // A second signer with their own .p12 fills the Vendor field.
    const vendorP12 = makeRsaPkcs12({ name: 'Vendor Person' })
    const vendor = await loadSigningIdentity(vendorP12.bytes, vendorP12.password)
    const reopened = await browser.openRequest(id, key)
    await browser.addSignedVersion(
      reopened,
      await signPdf(reopened.bytes, { identity: vendor, placement: { kind: 'field', name: 'Vendor' } }),
      'Vendor Person',
    )

    const done = await tool('get_signing_request', { link })
    expect(done.structuredContent.complete).toBe(true)
    expect(done.structuredContent.pending_fields).toEqual([])
    expect(done.structuredContent.signatures.map((signature) => [signature.signer, signature.email_verified_by_realpdf])).toEqual([
      ['Grace Hopper', true],
      ['Vendor Person', false],
    ])

    const download = await tool('download_signed_pdf', { link })
    const resource = download.content.find((block) => block.type === 'resource').resource
    expect(resource.mimeType).toBe('application/pdf')
    expect(download.structuredContent).toMatchObject({ file_name: 'Contract-signed.pdf', version: 'latest' })
    expect(download.structuredContent.verification.valid).toBe(true)
    const verified = await tool('verify_pdf', { pdf_base64: resource.blob })
    expect(verified.structuredContent.signatures.map((signature) => signature.intact)).toEqual([true, true])

    const original = await tool('download_signed_pdf', { link, version: 0 })
    expect(original.structuredContent.file_name).toBe('Contract.pdf')

    // Only the owner token cancels, and then the link is dead for everyone.
    const wrong = await tool('cancel_signing_request', { link, owner_token: 'x'.repeat(43) })
    expect(wrong.isError).toBe(true)
    const cancelled = await tool('cancel_signing_request', { link, owner_token: ownerToken })
    expect(cancelled.isError).toBeUndefined()
    const gone = await tool('get_signing_request', { link })
    expect(gone.isError).toBe(true)
    expect(gone.content[0].text).toContain('No signing request exists')
  })

  it('reads requests the app created', async () => {
    const created = await browser.createRequest({
      bytes: await contract(),
      fileName: 'Lease.pdf',
      from: 'Landlord',
      message: '',
    })
    const status = await tool('get_signing_request', { link: created.link })
    expect(status.structuredContent).toMatchObject({ file_name: 'Lease.pdf', from: 'Landlord', signatures: [], pending_fields: [] })
  })

  it('explains broken links and bad input', async () => {
    const created = await tool('create_signing_request', { pdf_base64: (await contract()).toString('base64') })
    const { link } = created.structuredContent
    const noKey = await tool('get_signing_request', { link: link.split('#')[0] })
    expect(noKey.isError).toBe(true)
    expect(noKey.content[0].text).toContain('part after #')

    const otherKey = `${link.split('#')[0]}#${'A'.repeat(43)}`
    const wrongKey = await tool('get_signing_request', { link: otherKey })
    expect(wrongKey.content[0].text).toContain('does not decrypt')

    const badPage = await tool('create_signing_request', {
      pdf_base64: (await contract()).toString('base64'),
      signature_fields: [{ name: 'Client', page: 3, x: 0, y: 0, width: 10, height: 10 }],
    })
    expect(badPage.isError).toBe(true)
    expect(badPage.content[0].text).toContain('Page 3 does not exist')

    const p12 = makeRsaPkcs12()
    const signed = await signPdf(await contract(), {
      identity: await loadSigningIdentity(p12.bytes, p12.password),
      placement: { kind: 'invisible' },
    })
    const refused = await tool('create_signing_request', {
      pdf_base64: Buffer.from(signed).toString('base64'),
      signature_fields: [{ name: 'Client', page: 1, x: 0, y: 0, width: 10, height: 10 }],
    })
    expect(refused.content[0].text).toContain('already signed')
  })

  it('rate-limits request creation per caller', async () => {
    const limited = { ...deps, allow: async () => false }
    const response = await handleMcp(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'create_signing_request', arguments: { pdf_base64: (await contract()).toString('base64') } },
        }),
      }),
      limited,
    )
    const body = await response.json()
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('Too many')
  })
})
