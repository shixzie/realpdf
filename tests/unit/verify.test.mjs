/**
 * Unit coverage for PDF signature verification (src/lib/signing/verify.ts),
 * the check behind the MCP `verify_pdf` tool. Files are signed with the app's
 * signer and test certificates from tests/helpers/signing.mjs.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { loadSigningIdentity } from '../../src/lib/signing/identity.ts'
import { addSignatureFields, signPdf } from '../../src/lib/signing/pdfSign.ts'
import { parsePdfDate, verifyPdf, VerifyError } from '../../src/lib/signing/verify.ts'
import { makeForgedChainPkcs12, makeRsaPkcs12 } from '../helpers/signing.mjs'
import { OUT_DIR, ensureOutDir } from '../helpers/fixtures.mjs'

async function samplePdf({ objectStreams = false } = {}) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([595, 842])
  page.drawText('Contract', { x: 72, y: 760, size: 18, font })
  return await doc.save({ useObjectStreams: objectStreams })
}

const box = { kind: 'box', pageIndex: 0, rect: [360, 60, 540, 120] }

/** Appends an incremental update with the given objects (number, dictionary text or full body). */
function appendObjects(bytes, objects) {
  const text = Buffer.from(bytes).toString('latin1')
  const prev = Number(/startxref\s+(\d+)\s*%%EOF\s*$/.exec(text)[1])
  const root = /\/Root\s+(\d+\s+\d+\s+R)/.exec(text.slice(text.lastIndexOf('trailer')))?.[1] ?? /\/Root\s+(\d+\s+\d+\s+R)/.exec(text)[1]
  let body = '\n'
  const offsets = []
  for (const [number, content] of objects) {
    offsets.push([number, bytes.length + Buffer.byteLength(body, 'latin1')])
    body += `${number} 0 obj\n${content}\nendobj\n`
  }
  const xrefAt = bytes.length + Buffer.byteLength(body, 'latin1')
  const size = Math.max(...objects.map(([number]) => number)) + 1
  body += 'xref\n' + offsets.map(([number, offset]) => `${number} 1\n${String(offset).padStart(10, '0')} 00000 n\r\n`).join('')
  body += `trailer\n<< /Size ${size + 100} /Root ${root} /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return new Uint8Array([...bytes, ...Buffer.from(body, 'latin1')])
}

/** Draws extra text on page 1 through an incremental update, the way an editor would. */
async function appendContent(bytes, text) {
  const doc = await PDFDocument.load(bytes)
  const page = doc.getPage(0)
  const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`
  const number = doc.context.largestObjectNumber + 1
  const contents = page.node.get(PDFName.of('Contents'))
  const pageText = page.node.toString().replace(/\/Contents\s+(\[[^\]]*\]|\d+\s+\d+\s+R)/, `/Contents [${contents.toString().replace(/^\[|\]$/g, '')} ${number} 0 R]`)
  return appendObjects(bytes, [
    [number, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`],
    [page.ref.objectNumber, pageText],
  ])
}

async function identityFor(name) {
  const p12 = makeRsaPkcs12({ name })
  return { p12, identity: await loadSigningIdentity(p12.bytes, p12.password) }
}

function hasOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('signature verification', () => {
  it('reports an unsigned PDF with its empty signature fields', async () => {
    const doc = await PDFDocument.load(await samplePdf())
    const page = doc.getPage(0)
    const field = doc.context.register(
      doc.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Client'), F: 4, P: page.ref, Rect: [300, 100, 500, 160] }),
    )
    page.node.set(PDFName.of('Annots'), doc.context.obj([field]))
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [field] }))
    const report = await verifyPdf(await doc.save())
    expect(report).toEqual({
      signatures: [],
      emptyFields: [{ field: 'Client', pageIndex: 0, rect: [300, 100, 500, 160] }],
      encrypted: false,
      valid: false,
    })
  })

  it('verifies a signature, its signer and its chain', async () => {
    const { p12, identity } = await identityFor('Ada Lovelace')
    const signed = await signPdf(await samplePdf(), {
      identity,
      placement: box,
      reason: 'Approval',
      location: 'London',
      date: new Date('2026-09-28T12:00:00Z'),
    })
    const report = await verifyPdf(signed)
    expect(report.valid).toBe(true)
    expect(report.signatures).toHaveLength(1)
    const [signature] = report.signatures
    expect(signature).toMatchObject({
      field: 'Signature1',
      intact: true,
      coversWholeFile: true,
      certifies: null,
      chainVerified: true,
      trusted: null,
      chain: ['Ada Lovelace', 'RealPDF Test CA'],
      reason: 'Approval',
      location: 'London',
      subFilter: 'ETSI.CAdES.detached',
      certificateValidAtSigning: true,
      problems: [],
    })
    expect(signature.signer).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com', issuer: 'RealPDF Test CA', selfSigned: false })
    expect(new Date(signature.signedAt).getTime()).toBe(Date.parse('2026-09-28T12:00:00Z'))

    // Trust anchors: the test CA is trusted; an unrelated root is not.
    expect((await verifyPdf(signed, { trustAnchors: [new Uint8Array(p12.caDer)] })).signatures[0].trusted).toBe(true)
    const other = makeRsaPkcs12({ name: 'Someone Else' })
    expect((await verifyPdf(signed, { trustAnchors: [new Uint8Array(other.caDer)] })).signatures[0].trusted).toBe(false)
  })

  it('does not let an end-entity certificate issue a trusted one', async () => {
    const forged = makeForgedChainPkcs12()
    const identity = await loadSigningIdentity(forged.bytes, forged.password)
    const signed = await signPdf(await samplePdf(), { identity, placement: box })
    const report = await verifyPdf(signed, { trustAnchors: [new Uint8Array(forged.caDer)] })
    const [signature] = report.signatures
    expect(signature.intact).toBe(true)
    expect(signature.signer.email).toBe('ada@example.com')
    expect(signature.trusted).toBe(false)
    expect(signature.chainVerified).toBe(false)
    expect(signature.problems).toContain('The certificate chain is incomplete or does not verify')
  })

  it('detects a changed byte inside the signed range', async () => {
    const { identity } = await identityFor('Ada Lovelace')
    const signed = await signPdf(await samplePdf(), { identity, placement: box })
    const tampered = new Uint8Array(signed)
    // %PDF-1.7 -> %PDF-1.6: one byte in the header, well inside the signed range.
    expect(tampered[7]).not.toBe(0x36)
    tampered[7] = 0x36
    const report = await verifyPdf(tampered)
    expect(report.valid).toBe(false)
    expect(report.signatures[0].intact).toBe(false)
    expect(report.signatures[0].problems).toContain('The document was changed after it was signed')
  })

  it('flags content appended after the last signature', async () => {
    const { identity } = await identityFor('Ada Lovelace')
    const signed = await signPdf(await samplePdf(), { identity, placement: box })
    const doc = await PDFDocument.load(signed)
    doc.getPage(0).drawText('Added later', { x: 72, y: 700, size: 12 })
    const edited = await doc.save({ useObjectStreams: false })
    const appended = new Uint8Array([...signed, ...Buffer.from('\n% trailing edit\n')])
    const report = await verifyPdf(appended)
    expect(report.valid).toBe(false)
    expect(report.signatures[0]).toMatchObject({ intact: true, coversWholeFile: false })
    expect(report.signatures[0].problems).toContain('The file was changed after the last signature')
    // pdf-lib rewrites the whole file, so the old signature no longer lines up.
    expect((await verifyPdf(edited)).valid).toBe(false)
  })

  it('orders countersignatures and reports certification', async () => {
    const first = await identityFor('First Signer')
    const second = await identityFor('Second Signer')
    const prepared = await addSignatureFields(await samplePdf({ objectStreams: true }), [
      { pageIndex: 0, rect: [360, 60, 540, 120], label: 'Second Signer' },
    ])
    const once = await signPdf(prepared, {
      identity: first.identity,
      placement: { kind: 'invisible' },
      certify: true,
    })
    const twice = await signPdf(once, { identity: second.identity, placement: { kind: 'field', name: 'Signature1' } })
    const report = await verifyPdf(twice)
    expect(report.valid).toBe(true)
    expect(report.signatures.map((signature) => signature.signer?.name)).toEqual(['First Signer', 'Second Signer'])
    expect(report.signatures.map((signature) => signature.coversWholeFile)).toEqual([false, true])
    expect(report.signatures.map((signature) => signature.intact)).toEqual([true, true])
    expect(report.signatures.map((signature) => signature.certifies)).toEqual([2, null])
    expect(report.signatures.map((signature) => signature.unauthorizedChanges)).toEqual([[], []])
    expect(report.signatures.map((signature) => signature.problems)).toEqual([[], []])
  })

  it('accepts a countersignature in a new box after an approval signature', async () => {
    const first = await identityFor('First Signer')
    const second = await identityFor('Second Signer')
    const once = await signPdf(await samplePdf(), { identity: first.identity, placement: box })
    const twice = await signPdf(once, { identity: second.identity, placement: { ...box, rect: [60, 60, 240, 120] } })
    const report = await verifyPdf(twice)
    expect(report.valid).toBe(true)
    expect(report.signatures[0].unauthorizedChanges).toEqual([])
  })

  it('flags new page content appended after a signature, even when someone signs on top', async () => {
    const first = await identityFor('First Signer')
    const second = await identityFor('Second Signer')
    const once = await signPdf(await samplePdf(), { identity: first.identity, placement: box })
    const edited = await appendContent(once, 'Amount due: 1,000,000')
    const twice = await signPdf(edited, { identity: second.identity, placement: { ...box, rect: [60, 60, 240, 120] } })
    const report = await verifyPdf(twice)
    expect(report.signatures.map((signature) => signature.intact)).toEqual([true, true])
    expect(report.signatures[1].coversWholeFile).toBe(true)
    expect(report.valid).toBe(false)
    expect(report.signatures[0].unauthorizedChanges).toContain("a page's /Contents changed")
    expect(report.signatures[0].problems.join(' ')).toMatch(/changed after this signature/)
  })

  it('flags an update that defines an object twice', async () => {
    const { identity } = await identityFor('First Signer')
    const once = await signPdf(await samplePdf(), { identity, placement: box })
    const doc = await PDFDocument.load(once)
    const page = doc.getPage(0)
    const pageText = page.node.toString()
    const twice = appendObjects(once, [
      [page.ref.objectNumber, pageText.replace('/Contents', '/Rotate 90 /Contents')],
      [page.ref.objectNumber, pageText],
    ])
    const report = await verifyPdf(twice)
    expect(report.valid).toBe(false)
    expect(report.signatures[0].unauthorizedChanges).toContain(`object ${page.ref.objectNumber} is defined twice in one update`)
  })

  it.skipIf(!hasOpenssl())('verifies ECDSA signatures from self-signed certificates', async () => {
    ensureOutDir()
    const dir = fs.mkdtempSync(path.join(OUT_DIR, 'verify-ec-'))
    const key = path.join(dir, 'key.pem')
    const cert = path.join(dir, 'cert.pem')
    const p12 = path.join(dir, 'identity.p12')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=EC Signer'], { stdio: 'ignore' })
    execFileSync('openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12, '-passout', 'pass:hunter2'], { stdio: 'ignore' })
    const identity = await loadSigningIdentity(fs.readFileSync(p12), 'hunter2')
    const report = await verifyPdf(await signPdf(await samplePdf(), { identity, placement: box }))
    expect(report.valid).toBe(true)
    expect(report.signatures[0]).toMatchObject({ intact: true, chainVerified: true, chain: ['EC Signer'] })
    expect(report.signatures[0].signer.selfSigned).toBe(true)
  })

  it('rejects files that are not PDFs', async () => {
    const error = await verifyPdf(new Uint8Array([1, 2, 3])).catch((caught) => caught)
    expect(error).toBeInstanceOf(VerifyError)
  })

  it('parses PDF dates with time zones', () => {
    expect(parsePdfDate("D:20260928140000+02'00'")?.toISOString()).toBe('2026-09-28T12:00:00.000Z')
    expect(parsePdfDate('D:20260928120000Z')?.toISOString()).toBe('2026-09-28T12:00:00.000Z')
    expect(parsePdfDate('nonsense')).toBeNull()
  })
})
