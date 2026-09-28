/**
 * Unit coverage for certificate-based signing: PKCS#12 loading, the CMS
 * signature and the incremental update that carries it. Signatures are
 * checked with Node's crypto (tests/helpers/signing.mjs), not the app's code.
 */
import { execFileSync } from 'node:child_process'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { CertificateError, loadSigningIdentity } from '../../src/lib/signing/identity.ts'
import { addSignatureFields, readSignatureSummary, SignError, signPdf } from '../../src/lib/signing/pdfSign.ts'
import { makeRsaPkcs12, verifyPdfSignatures } from '../helpers/signing.mjs'
import { OUT_DIR, ensureOutDir } from '../helpers/fixtures.mjs'

async function samplePdf({ objectStreams = false, pages = 2 } = {}) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([595, 842])
    page.drawText(`Contract page ${i + 1}`, { x: 72, y: 760, size: 18, font })
  }
  return await doc.save({ useObjectStreams: objectStreams })
}

async function widgetsOf(bytes, pageNumber = 1) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise
  const page = await pdf.getPage(pageNumber)
  return (await page.getAnnotations()).filter((annotation) => annotation.fieldType === 'Sig')
}

const box = { kind: 'box', pageIndex: 0, rect: [360, 60, 540, 120] }
const lines = [
  { text: 'Digitally signed by', scale: 0.8 },
  { text: 'Ada Lovelace', bold: true, scale: 1.3 },
  { text: 'Date: 2026-09-28 12:00:00 +00:00', scale: 0.8 },
]

/** A small RGBA PNG: a dark stroke on a transparent background, like an adopted signature. */
function signaturePng(width = 60, height = 20) {
  const rows = []
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4)
    for (let x = 0; x < width; x += 1) {
      const ink = Math.abs(y - height / 2 - Math.sin(x / 6) * 5) < 2
      row.set([17, 24, 39, ink ? 255 : 0], 1 + x * 4)
    }
    rows.push(row)
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

function hasOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** A PKCS#12 written by the openssl CLI (AES-256 + PBKDF2 on OpenSSL 3). */
function opensslPkcs12(kind) {
  ensureOutDir()
  const dir = fs.mkdtempSync(path.join(OUT_DIR, `p12-${kind}-`))
  const key = path.join(dir, 'key.pem')
  const cert = path.join(dir, 'cert.pem')
  const p12 = path.join(dir, 'identity.p12')
  const keyArgs = kind === 'ec' ? ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256'] : ['-newkey', 'rsa:2048']
  execFileSync('openssl', ['req', '-x509', ...keyArgs, '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', `/CN=OpenSSL ${kind} signer/O=RealPDF Tests`], { stdio: 'ignore' })
  execFileSync('openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12, '-passout', 'pass:hunter2'], { stdio: 'ignore' })
  return fs.readFileSync(p12)
}

describe('certificate signing', () => {
  it('opens a PKCS#12 file and finds the signer certificate and its chain', async () => {
    const p12 = makeRsaPkcs12()
    const identity = await loadSigningIdentity(p12.bytes, p12.password)
    expect(identity.keyType).toBe('RSA')
    expect(identity.info.name).toBe('Ada Lovelace')
    expect(identity.info.issuer).toBe('RealPDF Test CA')
    expect(identity.info.email).toBe('ada@example.com')
    expect(identity.info.selfSigned).toBe(false)
    expect(Buffer.from(identity.certificate).equals(p12.certificateDer)).toBe(true)
    expect(identity.chain.map((der) => Buffer.from(der).equals(p12.caDer))).toEqual([true])
  })

  it('rejects a wrong password and a file that is not PKCS#12', async () => {
    const p12 = makeRsaPkcs12()
    await expect(loadSigningIdentity(p12.bytes, 'wrong')).rejects.toMatchObject({ code: 'password' })
    const error = await loadSigningIdentity(new Uint8Array([1, 2, 3, 4]), 'x').catch((caught) => caught)
    expect(error).toBeInstanceOf(CertificateError)
    expect(error.code).toBe('invalidFile')
  })

  it('reads AES-encrypted PKCS#12 files', async () => {
    const p12 = makeRsaPkcs12({ algorithm: 'aes256' })
    const identity = await loadSigningIdentity(p12.bytes, p12.password)
    expect(identity.info.name).toBe('Ada Lovelace')
  })

  it('signs with a visible PAdES signature as an incremental update', async () => {
    const p12 = makeRsaPkcs12()
    const identity = await loadSigningIdentity(p12.bytes, p12.password)
    const original = await samplePdf()
    const signed = await signPdf(original, { identity, placement: box, lines, reason: 'Approval', location: 'London' })

    // The original bytes are untouched and the signature covers the whole file.
    expect(Buffer.from(signed.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true)
    const [result] = verifyPdfSignatures(signed)
    expect(result).toMatchObject({ valid: true, coversFile: true, hasSigningCertificateV2: true, hasSigningTime: false })
    expect(result.signer).toContain('CN=Ada Lovelace')
    expect(result.certificates.map((raw) => raw.equals(p12.certificateDer) || raw.equals(p12.caDer))).toEqual([true, true])

    const text = Buffer.from(signed).toString('latin1')
    expect(text).toContain('/SubFilter /ETSI.CAdES.detached')
    expect(text).toContain('/Filter /Adobe.PPKLite')

    const [widget] = await widgetsOf(signed)
    expect(widget?.fieldName).toBe('Signature1')
    expect(widget?.rect.map(Math.round)).toEqual([360, 60, 540, 120])
    expect(await readSignatureSummary(signed)).toEqual({ signed: 1, empty: [], certified: false, encrypted: false })

    const reloaded = await PDFDocument.load(signed)
    const acroForm = reloaded.catalog.lookup(PDFName.of('AcroForm'))
    expect(acroForm.get(PDFName.of('SigFlags')).asNumber()).toBe(3)
    expect(reloaded.getPageCount()).toBe(2)
  })

  it('extends files that use cross-reference streams', async () => {
    const p12 = makeRsaPkcs12()
    const identity = await loadSigningIdentity(p12.bytes, p12.password)
    const original = await samplePdf({ objectStreams: true })
    const signed = await signPdf(original, { identity, placement: { ...box, pageIndex: 1 }, lines })
    expect(verifyPdfSignatures(signed)).toMatchObject([{ valid: true, coversFile: true }])
    expect(Buffer.from(signed).toString('latin1').slice(original.length)).toContain('/Type /XRef')
    expect(await widgetsOf(signed, 2)).toHaveLength(1)
    expect(await widgetsOf(signed, 1)).toHaveLength(0)
  })

  it('keeps earlier signatures valid when countersigning', async () => {
    const first = makeRsaPkcs12({ name: 'First Signer' })
    const second = makeRsaPkcs12({ name: 'Second Signer' })
    const once = await signPdf(await samplePdf(), {
      identity: await loadSigningIdentity(first.bytes, first.password),
      placement: box,
      lines,
    })
    const twice = await signPdf(once, {
      identity: await loadSigningIdentity(second.bytes, second.password),
      placement: { ...box, rect: [60, 60, 240, 120] },
      lines,
    })
    const results = verifyPdfSignatures(twice)
    expect(results.map((result) => result.valid)).toEqual([true, true])
    expect(results.map((result) => result.coversFile)).toEqual([false, true])
    expect(results[1].signer).toContain('CN=Second Signer')
    expect((await widgetsOf(twice)).map((widget) => widget.fieldName)).toEqual(['Signature1', 'Signature2'])
    expect((await readSignatureSummary(twice)).signed).toBe(2)
  })

  it('fills in an empty signature field prepared by another tool', async () => {
    const doc = await PDFDocument.load(await samplePdf())
    const page = doc.getPage(1)
    const field = doc.context.register(
      doc.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Client'), F: 4, P: page.ref, Rect: [300, 100, 500, 160] }),
    )
    page.node.set(PDFName.of('Annots'), doc.context.obj([field]))
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [field] }))
    const prepared = await doc.save({ useObjectStreams: false })
    expect(await readSignatureSummary(prepared)).toEqual({
      signed: 0,
      empty: [{ name: 'Client', pageIndex: 1, rect: [300, 100, 500, 160] }],
      certified: false,
      encrypted: false,
    })

    const p12 = makeRsaPkcs12()
    const identity = await loadSigningIdentity(p12.bytes, p12.password)
    const signed = await signPdf(prepared, { identity, placement: { kind: 'field', name: 'Client' }, lines })
    expect(verifyPdfSignatures(signed)).toMatchObject([{ valid: true, coversFile: true }])
    expect(await readSignatureSummary(signed)).toEqual({ signed: 1, empty: [], certified: false, encrypted: false })
    const [widget] = await widgetsOf(signed, 2)
    expect(widget?.fieldName).toBe('Client')
    const missing = await signPdf(signed, { identity, placement: { kind: 'field', name: 'Client' } }).catch((caught) => caught)
    expect(missing.code).toBe('noField')
  })

  it('adds labelled "sign here" fields incrementally, then fills one with a handwritten signature', async () => {
    const p12 = makeRsaPkcs12()
    const identity = await loadSigningIdentity(p12.bytes, p12.password)
    // An earlier signature must survive both the new fields and the next signature.
    const first = await signPdf(await samplePdf(), { identity, placement: { kind: 'invisible' } })
    const prepared = await addSignatureFields(first, [
      { pageIndex: 0, rect: [72, 80, 252, 136], label: 'Grace Hopper' },
      { pageIndex: 1, rect: [300, 80, 480, 136], label: 'Alan Turing' },
    ])
    expect(Buffer.from(prepared.subarray(0, first.length)).equals(Buffer.from(first))).toBe(true)
    expect(verifyPdfSignatures(prepared)).toMatchObject([{ valid: true, coversFile: false }])
    const summary = await readSignatureSummary(prepared)
    expect(summary.signed).toBe(1)
    expect(summary.empty).toEqual([
      { name: 'Signature2', label: 'Grace Hopper', pageIndex: 0, rect: [72, 80, 252, 136] },
      { name: 'Signature3', label: 'Alan Turing', pageIndex: 1, rect: [300, 80, 480, 136] },
    ])

    const signed = await signPdf(prepared, {
      identity,
      placement: { kind: 'field', name: 'Signature2' },
      lines,
      image: signaturePng(),
    })
    expect(verifyPdfSignatures(signed)).toMatchObject([{ valid: true }, { valid: true, coversFile: true }])
    const update = Buffer.from(signed.subarray(prepared.length)).toString('latin1')
    expect(update).toMatch(/\/Subtype \/Image/)
    expect(update).toMatch(/\/XObject <<\s*\/Im1 \d+ 0 R/)
    const after = await readSignatureSummary(signed)
    expect(after.signed).toBe(2)
    expect(after.empty.map((field) => field.label)).toEqual(['Alan Turing'])
  })

  it('certifies a document with DocMDP, and only as the first signature', async () => {
    const p12 = makeRsaPkcs12()
    const identity = await loadSigningIdentity(p12.bytes, p12.password)
    const certified = await signPdf(await samplePdf(), { identity, placement: { kind: 'invisible' }, certify: true })
    expect(verifyPdfSignatures(certified)).toMatchObject([{ valid: true, coversFile: true }])
    const text = Buffer.from(certified).toString('latin1')
    expect(text).toMatch(/\/Perms\s*<<\s*\/DocMDP \d+ 0 R/)
    expect(text).toMatch(/\/TransformMethod \/DocMDP/)
    expect((await readSignatureSummary(certified)).certified).toBe(true)
    const error = await signPdf(certified, { identity, placement: { kind: 'invisible' }, certify: true }).catch((caught) => caught)
    expect(error).toBeInstanceOf(SignError)
    expect(error.code).toBe('alreadyCertified')

    // A new signature field would break the certification, so only existing fields can be signed.
    for (const attempt of [
      signPdf(certified, { identity, placement: box }),
      signPdf(certified, { identity, placement: { kind: 'invisible' } }),
      addSignatureFields(certified, [{ pageIndex: 0, rect: [60, 60, 240, 120] }]),
    ]) {
      const refused = await attempt.catch((caught) => caught)
      expect(refused).toBeInstanceOf(SignError)
      expect(refused.code).toBe('certified')
    }
    const prepared = await addSignatureFields(await samplePdf(), [{ pageIndex: 0, rect: [60, 60, 240, 120] }])
    const certifiedWithField = await signPdf(prepared, { identity, placement: { kind: 'invisible' }, certify: true })
    const countersigned = await signPdf(certifiedWithField, { identity, placement: { kind: 'field', name: 'Signature1' } })
    expect(verifyPdfSignatures(countersigned)).toMatchObject([{ valid: true }, { valid: true, coversFile: true }])
  })

  it.skipIf(!hasOpenssl())('signs with OpenSSL-made RSA and ECDSA identities', async () => {
    for (const kind of ['rsa', 'ec']) {
      const identity = await loadSigningIdentity(opensslPkcs12(kind), 'hunter2')
      expect(identity.keyType).toBe(kind === 'ec' ? 'EC' : 'RSA')
      expect(identity.info.selfSigned).toBe(true)
      const signed = await signPdf(await samplePdf(), { identity, placement: box, lines })
      expect(verifyPdfSignatures(signed), kind).toMatchObject([{ valid: true, coversFile: true }])
    }
  })
})
