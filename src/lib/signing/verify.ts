import forge from 'node-forge'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFObject,
} from 'pdf-lib'
import { asn1Date, bytesEqual, children, oidOf, parseDer, type Asn1 } from './der'
import { certificateInfo, parseCertificate, type ParsedCertificate } from './identity'
import { laterChanges } from './revisions'

/**
 * Verifies the digital signatures in a PDF the way a reader does: each
 * signature's /ByteRange must hash to the digest in its CMS signed attributes,
 * the signature over those attributes must verify with the embedded signer
 * certificate, and the certificate chain is checked link by link. Only
 * WebCrypto and pdf-lib are used, so this runs in the browser and in the
 * Worker alike. Revocation (OCSP/CRL) and timestamps are not checked.
 */

export interface SignerDetails {
  name: string
  email: string | null
  organization: string | null
  issuer: string
  selfSigned: boolean
  notBefore: string | null
  notAfter: string | null
}

export interface VerifiedSignature {
  /** Fully qualified field name. */
  field: string
  signer: SignerDetails | null
  /** ISO time from the signing-time attribute, else the dictionary's /M. */
  signedAt: string | null
  reason: string | null
  location: string | null
  contactInfo: string | null
  subFilter: string | null
  /** The signed bytes are unchanged and the signature verifies with the signer's key. */
  intact: boolean
  /** The signature covers the whole file, so nothing was appended after it. */
  coversWholeFile: boolean
  /** DocMDP permissions (1 no changes, 2 form filling and signing, 3 also annotations) when this signature certifies the document. */
  certifies: 1 | 2 | 3 | null
  /**
   * Changes made after this signature that it does not allow: anything beyond
   * adding signatures (and, for a certification, beyond what its permissions allow).
   */
  unauthorizedChanges: string[]
  /** Every certificate in the chain carries a valid signature from the next one. */
  chainVerified: boolean
  /** The chain ends at one of the trust anchors passed in; null when none were given. */
  trusted: boolean | null
  /** Subject names from the signer up to the last certificate found. */
  chain: string[]
  /** The signing time falls within the signer certificate's validity period; null when unknown. */
  certificateValidAtSigning: boolean | null
  problems: string[]
}

export interface EmptySignatureField {
  field: string
  /** Zero-based page index. */
  pageIndex: number
  rect: [number, number, number, number]
}

export interface VerificationReport {
  signatures: VerifiedSignature[]
  emptyFields: EmptySignatureField[]
  encrypted: boolean
  /** At least one signature, all intact, no unauthorized changes after any of them, and the last one covers the whole file. */
  valid: boolean
}

export interface VerifyOptions {
  /** DER certificates to treat as trusted roots. */
  trustAnchors?: Uint8Array<ArrayBuffer>[]
}

export class VerifyError extends Error {
  readonly code: 'unreadable'
  constructor(code: VerifyError['code'], message?: string) {
    super(message ?? code)
    this.code = code
  }
}

const OID = {
  signedData: '1.2.840.113549.1.7.2',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsaPss: '1.2.840.113549.1.1.10',
  ecPublicKey: '1.2.840.10045.2.1',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
}

const DIGESTS: Record<string, string> = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
}

/** Signature algorithms that name their own hash. */
const SIGNATURE_HASHES: Record<string, { family: 'RSA' | 'EC'; hash: string }> = {
  '1.2.840.113549.1.1.5': { family: 'RSA', hash: 'SHA-1' },
  '1.2.840.113549.1.1.11': { family: 'RSA', hash: 'SHA-256' },
  '1.2.840.113549.1.1.12': { family: 'RSA', hash: 'SHA-384' },
  '1.2.840.113549.1.1.13': { family: 'RSA', hash: 'SHA-512' },
  '1.2.840.10045.4.1': { family: 'EC', hash: 'SHA-1' },
  '1.2.840.10045.4.3.2': { family: 'EC', hash: 'SHA-256' },
  '1.2.840.10045.4.3.3': { family: 'EC', hash: 'SHA-384' },
  '1.2.840.10045.4.3.4': { family: 'EC', hash: 'SHA-512' },
}

const CURVES: Record<string, { name: string; size: number }> = {
  '1.2.840.10045.3.1.7': { name: 'P-256', size: 32 },
  '1.3.132.0.34': { name: 'P-384', size: 48 },
  '1.3.132.0.35': { name: 'P-521', size: 66 },
}

/* ------------------------------------------------------------------------ */
/* Raw DER walking, for the byte-exact slices a signature covers.           */
/* ------------------------------------------------------------------------ */

interface Tlv {
  tag: number
  /** Offset of the tag byte. */
  start: number
  /** Offset of the first content byte. */
  contentStart: number
  end: number
}

function readTlv(bytes: Uint8Array, offset: number): Tlv {
  const tag = bytes[offset]
  let cursor = offset + 1
  let length = bytes[cursor++]
  if (length & 0x80) {
    const count = length & 0x7f
    if (count === 0 || count > 4) throw new Error('Unsupported DER length')
    length = 0
    for (let i = 0; i < count; i += 1) length = length * 256 + bytes[cursor++]
  }
  const end = cursor + length
  if (tag === undefined || end > bytes.length) throw new Error('Truncated DER')
  return { tag, start: offset, contentStart: cursor, end }
}

function rawChildren(bytes: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = []
  let offset = parent.contentStart
  while (offset < parent.end) {
    const child = readTlv(bytes, offset)
    out.push(child)
    offset = child.end
  }
  return out
}

function slice(bytes: Uint8Array, tlv: Tlv): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes.subarray(tlv.start, tlv.end))
}

/* ------------------------------------------------------------------------ */
/* Crypto helpers.                                                           */
/* ------------------------------------------------------------------------ */

async function digest(hash: string, parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return new Uint8Array(await crypto.subtle.digest(hash, joined))
}

function binaryBytes(value: unknown): Uint8Array<ArrayBuffer> {
  const text = typeof value === 'string' ? value : ''
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff
  return out
}

/** CMS/X.509 ECDSA signatures are SEQUENCE { r, s }; WebCrypto wants r||s. */
function ecdsaToRaw(der: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  const sequence = readTlv(der, 0)
  const [r, s] = rawChildren(der, sequence)
  const out = new Uint8Array(size * 2)
  for (const [index, part] of [r, s].entries()) {
    let value = der.subarray(part.contentStart, part.end)
    while (value.length > size && value[0] === 0) value = value.subarray(1)
    if (value.length > size) throw new Error('ECDSA integer too long')
    out.set(value, index * size + (size - value.length))
  }
  return out
}

interface KeyAlgorithm {
  family: 'RSA' | 'EC'
  curve?: { name: string; size: number }
}

function keyAlgorithmOf(cert: ParsedCertificate): KeyAlgorithm | null {
  const spki = children(parseDer(cert.spki))
  const algorithm = children(spki[0])
  const oid = oidOf(algorithm[0])
  if (oid === OID.rsaEncryption || oid === OID.rsaPss) return { family: 'RSA' }
  if (oid === OID.ecPublicKey) {
    const curve = CURVES[oidOf(algorithm[1]) ?? '']
    return curve ? { family: 'EC', curve } : null
  }
  return null
}

/** Reads RSASSA-PSS-params: hash (default SHA-1) and salt length (default 20). */
function pssParams(params: Asn1 | undefined): { hash: string; saltLength: number } {
  let hash = 'SHA-1'
  let saltLength = 20
  for (const field of children(params)) {
    const inner = children(field)[0]
    if (field.type === 0) hash = DIGESTS[oidOf(children(inner)[0]) ?? ''] ?? hash
    if (field.type === 2 && typeof inner?.value === 'string') {
      saltLength = binaryBytes(inner.value).reduce((sum, byte) => sum * 256 + byte, 0)
    }
  }
  return { hash, saltLength }
}

/**
 * Verifies `signature` over `data` with the certificate's public key.
 * `algorithm` is the AlgorithmIdentifier node; `fallbackHash` is used when it
 * names only the key type (rsaEncryption / ecPublicKey in CMS SignerInfo).
 */
async function verifyWith(
  cert: ParsedCertificate,
  algorithm: Asn1 | undefined,
  fallbackHash: string | null,
  signature: Uint8Array,
  data: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const key = keyAlgorithmOf(cert)
  if (!key) throw new Error('Unsupported public key')
  const parts = children(algorithm)
  const oid = oidOf(parts[0]) ?? ''
  if (oid === OID.rsaPss) {
    const { hash, saltLength } = pssParams(parts[1])
    const publicKey = await crypto.subtle.importKey('spki', cert.spki, { name: 'RSA-PSS', hash }, false, ['verify'])
    return crypto.subtle.verify({ name: 'RSA-PSS', saltLength }, publicKey, new Uint8Array(signature), data)
  }
  const named = SIGNATURE_HASHES[oid]
  const hash = named?.hash ?? fallbackHash
  if (!hash) throw new Error(`Unsupported signature algorithm ${oid}`)
  if (named && named.family !== key.family) throw new Error('Signature algorithm does not match the key')
  if (key.family === 'RSA') {
    const publicKey = await crypto.subtle.importKey('spki', cert.spki, { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify'])
    return crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, publicKey, new Uint8Array(signature), data)
  }
  const curve = key.curve as { name: string; size: number }
  const publicKey = await crypto.subtle.importKey('spki', cert.spki, { name: 'ECDSA', namedCurve: curve.name }, false, ['verify'])
  return crypto.subtle.verify({ name: 'ECDSA', hash }, publicKey, ecdsaToRaw(signature, curve.size), data)
}

/* ------------------------------------------------------------------------ */
/* Certificates.                                                             */
/* ------------------------------------------------------------------------ */

interface CertificateEntry {
  parsed: ParsedCertificate
  /** TBSCertificate bytes, exactly as signed. */
  tbs: Uint8Array<ArrayBuffer>
  signatureAlgorithm: Asn1 | undefined
  signature: Uint8Array
  /** basicConstraints says cA and keyUsage (when present) allows keyCertSign. */
  isCa: boolean
}

/** The value of each extension in a TBSCertificate, by OID. */
function extensionsOf(tbs: Asn1 | undefined): Map<string, Asn1 | null> {
  const out = new Map<string, Asn1 | null>()
  const wrapper = children(tbs).find((field) => field.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && field.type === 3)
  for (const extension of children(children(wrapper)[0])) {
    const parts = children(extension)
    const oid = oidOf(parts[0])
    const value = parts[parts.length - 1]
    if (!oid || typeof value?.value !== 'string') continue
    try {
      out.set(oid, parseDer(binaryBytes(value.value)))
    } catch {
      out.set(oid, null)
    }
  }
  return out
}

/** Whether a certificate may issue others (RFC 5280 4.2.1.3 and 4.2.1.9). */
function isCaCertificate(tbs: Asn1 | undefined): boolean {
  const extensions = extensionsOf(tbs)
  const cA = children(extensions.get(OID.basicConstraints) ?? undefined)[0]
  if (cA?.type !== forge.asn1.Type.BOOLEAN || !cA.value || cA.value === '\x00') return false
  if (!extensions.has(OID.keyUsage)) return true
  const usage = extensions.get(OID.keyUsage) as (Asn1 & { bitStringContents?: string }) | null
  // forge decodes BIT STRINGs that look like DER and keeps the raw bytes in bitStringContents.
  const raw = binaryBytes(typeof usage?.value === 'string' ? usage.value : usage?.bitStringContents)
  // Byte 0 is the unused-bits count; keyCertSign is bit 5, 0x04 of the first byte.
  return raw.length > 1 && (raw[1] & 0x04) !== 0
}

function readCertificate(der: Uint8Array<ArrayBuffer>): CertificateEntry {
  const outer = readTlv(der, 0)
  const [tbs, , signatureValue] = rawChildren(der, outer)
  const node = children(parseDer(der))
  // BIT STRING content starts with the unused-bits count.
  const signature = der.subarray(signatureValue.contentStart + 1, signatureValue.end)
  return {
    parsed: parseCertificate(der),
    tbs: slice(der, tbs),
    signatureAlgorithm: node[1],
    signature,
    isCa: isCaCertificate(node[0]),
  }
}

function tryReadCertificate(der: Uint8Array<ArrayBuffer>): CertificateEntry | null {
  try {
    return readCertificate(der)
  } catch {
    return null
  }
}

async function issuedBy(child: CertificateEntry, issuer: CertificateEntry): Promise<boolean> {
  if (!bytesEqual(child.parsed.issuerDer, issuer.parsed.subjectDer)) return false
  // Only a CA may issue certificates; a self-signed end-entity certificate may still vouch for itself.
  if (!issuer.isCa && !bytesEqual(issuer.parsed.der, child.parsed.der)) return false
  try {
    return await verifyWith(issuer.parsed, child.signatureAlgorithm, null, child.signature, child.tbs)
  } catch {
    return false
  }
}

interface ChainResult {
  verified: boolean
  trusted: boolean | null
  names: string[]
}

async function checkChain(
  leaf: CertificateEntry,
  pool: CertificateEntry[],
  anchors: CertificateEntry[],
): Promise<ChainResult> {
  const names = [certificateInfo(leaf.parsed).name]
  let current = leaf
  const seen = new Set<CertificateEntry>([leaf])
  for (let depth = 0; depth < 10; depth += 1) {
    const anchor = await firstIssuer(current, anchors)
    if (anchor) {
      if (!bytesEqual(anchor.parsed.der, current.parsed.der)) names.push(certificateInfo(anchor.parsed).name)
      return { verified: true, trusted: true, names }
    }
    if (bytesEqual(current.parsed.issuerDer, current.parsed.subjectDer)) {
      const selfSigned = await issuedBy(current, current)
      return { verified: selfSigned, trusted: anchors.length ? false : null, names }
    }
    const next = await firstIssuer(
      current,
      pool.filter((cert) => !seen.has(cert)),
    )
    if (!next) {
      // The issuer is not in the file: the links present verified, but the chain stops short.
      return { verified: false, trusted: anchors.length ? false : null, names }
    }
    seen.add(next)
    names.push(certificateInfo(next.parsed).name)
    current = next
  }
  return { verified: false, trusted: anchors.length ? false : null, names }
}

async function firstIssuer(child: CertificateEntry, candidates: CertificateEntry[]): Promise<CertificateEntry | null> {
  for (const candidate of candidates) {
    if (await issuedBy(child, candidate)) return candidate
  }
  return null
}

/* ------------------------------------------------------------------------ */
/* CMS SignedData.                                                           */
/* ------------------------------------------------------------------------ */

interface CmsCheck {
  intact: boolean
  signer: CertificateEntry | null
  certificates: CertificateEntry[]
  signingTime: Date | null
  problems: string[]
}

async function checkCms(cms: Uint8Array<ArrayBuffer>, ranges: Uint8Array[]): Promise<CmsCheck> {
  const problems: string[] = []
  const contentInfo = readTlv(cms, 0)
  const [typeTlv, explicit] = rawChildren(cms, contentInfo)
  if (oidOf(parseDer(slice(cms, typeTlv))) !== OID.signedData || !explicit) {
    return { intact: false, signer: null, certificates: [], signingTime: null, problems: ['Not a CMS SignedData signature'] }
  }
  const signedData = rawChildren(cms, explicit)[0]
  const parts = rawChildren(cms, signedData)
  const certificateSet = parts.find((part) => part.tag === 0xa0)
  const signerInfos = parts[parts.length - 1]
  const certificates = certificateSet
    ? rawChildren(cms, certificateSet)
        .filter((part) => part.tag === 0x30)
        .map((part) => tryReadCertificate(slice(cms, part)))
        .filter((entry): entry is CertificateEntry => entry !== null)
    : []

  const infos = rawChildren(cms, signerInfos)
  if (infos.length !== 1) problems.push(`Expected one signer, found ${infos.length}`)
  const info = infos[0]
  if (!info) return { intact: false, signer: null, certificates, signingTime: null, problems }
  const fields = rawChildren(cms, info)
  const node = children(parseDer(slice(cms, info)))

  // sid: IssuerAndSerialNumber, or [0] SubjectKeyIdentifier.
  const sidTlv = fields[1]
  let signer: CertificateEntry | null = null
  if (sidTlv.tag === 0x30) {
    const [issuer, serial] = rawChildren(cms, sidTlv)
    const issuerBytes = slice(cms, issuer)
    const serialBytes = cms.subarray(serial.contentStart, serial.end)
    signer =
      certificates.find(
        (cert) =>
          bytesEqual(cert.parsed.issuerDer, issuerBytes) &&
          bytesEqual(binaryBytes(cert.parsed.serial.value), serialBytes),
      ) ?? null
  }
  // Fall back to the first certificate (what most readers do when sid is a key id).
  signer ??= certificates[0] ?? null
  if (!signer) problems.push('The signer certificate is not embedded')

  const digestAlgorithm = DIGESTS[oidOf(children(node[2])[0]) ?? '']
  if (!digestAlgorithm) problems.push('Unsupported digest algorithm')
  const signedAttrsIndex = fields.findIndex((field) => field.tag === 0xa0)
  const signatureIndex = fields.findIndex((field, index) => index > 2 && field.tag === 0x04)
  const signatureAlgorithm = node[signatureIndex - 1]
  const signature = cms.subarray(fields[signatureIndex]?.contentStart ?? 0, fields[signatureIndex]?.end ?? 0)

  let signingTime: Date | null = null
  let intact = false
  if (signer && digestAlgorithm && signatureIndex > 0) {
    try {
      const contentDigest = await digest(digestAlgorithm, ranges)
      let signedBytes: Uint8Array<ArrayBuffer>
      if (signedAttrsIndex > 0) {
        const attributes = new Map<string, Asn1>()
        for (const attribute of children(node[signedAttrsIndex])) {
          const [type, values] = children(attribute)
          const oid = oidOf(type)
          if (oid) attributes.set(oid, children(values)[0])
        }
        const messageDigest = binaryBytes(attributes.get(OID.messageDigest)?.value)
        if (!bytesEqual(messageDigest, contentDigest)) problems.push('The document was changed after it was signed')
        signingTime = asn1Date(attributes.get(OID.signingTime))
        // The signature covers the attributes re-tagged as a SET (0x31).
        signedBytes = slice(cms, fields[signedAttrsIndex])
        signedBytes[0] = 0x31
        const valid = await verifyWith(signer.parsed, signatureAlgorithm, digestAlgorithm, signature, signedBytes)
        if (!valid) problems.push('The signature does not match the signer certificate')
        intact = valid && bytesEqual(messageDigest, contentDigest)
      } else {
        const joined = new Uint8Array(ranges.reduce((sum, part) => sum + part.length, 0))
        let offset = 0
        for (const part of ranges) {
          joined.set(part, offset)
          offset += part.length
        }
        intact = await verifyWith(signer.parsed, signatureAlgorithm, digestAlgorithm, signature, joined)
        if (!intact) problems.push('The signature does not match the document')
      }
    } catch (error) {
      problems.push(`Could not check the signature: ${(error as Error).message}`)
    }
  }
  return { intact, signer, certificates, signingTime, problems }
}

/* ------------------------------------------------------------------------ */
/* PDF structure.                                                            */
/* ------------------------------------------------------------------------ */

interface SignatureField {
  name: string
  ref: PDFRef | null
  dict: PDFDict
  value: PDFDict | null
  valueRef: PDFRef | null
}

function textOf(object: PDFObject | undefined): string | null {
  if (object instanceof PDFString || object instanceof PDFHexString) return object.decodeText()
  if (object instanceof PDFName) return object.decodeText()
  return null
}

function signatureFields(doc: PDFDocument): SignatureField[] {
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)
  const out: SignatureField[] = []
  const visit = (array: PDFArray | undefined, prefix: string, inheritedType: string | null, depth: number) => {
    if (!array || depth > 32) return
    for (let i = 0; i < array.size(); i += 1) {
      const dict = array.lookupMaybe(i, PDFDict)
      if (!dict) continue
      const own = textOf(dict.lookup(PDFName.of('T')))
      const name = own ? (prefix ? `${prefix}.${own}` : own) : prefix
      const type = textOf(dict.get(PDFName.of('FT'))) ?? inheritedType
      if (own && type === 'Sig') {
        const entry = array.get(i)
        const rawValue = dict.get(PDFName.of('V'))
        out.push({
          name,
          ref: entry instanceof PDFRef ? entry : null,
          dict,
          value: dict.lookupMaybe(PDFName.of('V'), PDFDict) ?? null,
          valueRef: rawValue instanceof PDFRef ? rawValue : null,
        })
      }
      visit(dict.lookupMaybe(PDFName.of('Kids'), PDFArray), name, type, depth + 1)
    }
  }
  visit(acroForm?.lookupMaybe(PDFName.of('Fields'), PDFArray), '', null, 0)
  return out
}

function widgetOf(field: SignatureField): { ref: PDFRef | null; dict: PDFDict } {
  if (textOf(field.dict.get(PDFName.of('Subtype'))) === 'Widget') return { ref: field.ref, dict: field.dict }
  const kids = field.dict.lookupMaybe(PDFName.of('Kids'), PDFArray)
  for (let i = 0; i < (kids?.size() ?? 0); i += 1) {
    const kid = kids?.lookupMaybe(i, PDFDict)
    if (kid && textOf(kid.get(PDFName.of('Subtype'))) === 'Widget') {
      const ref = kids?.get(i)
      return { ref: ref instanceof PDFRef ? ref : null, dict: kid }
    }
  }
  return { ref: field.ref, dict: field.dict }
}

function pageIndexOf(doc: PDFDocument, widget: { ref: PDFRef | null; dict: PDFDict }): number {
  const pages = doc.getPages()
  if (widget.ref) {
    const index = pages.findIndex((page) =>
      Boolean(page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.asArray().some((entry) => entry === widget.ref)),
    )
    if (index >= 0) return index
  }
  const owner = widget.dict.get(PDFName.of('P'))
  return Math.max(0, pages.findIndex((page) => page.ref === owner))
}

function rectOf(dict: PDFDict): [number, number, number, number] {
  const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray)
  const values = [0, 1, 2, 3].map((index) => {
    const value = rect?.lookup(index)
    return value instanceof PDFNumber ? value.asNumber() : 0
  })
  return [
    Math.min(values[0], values[2]),
    Math.min(values[1], values[3]),
    Math.max(values[0], values[2]),
    Math.max(values[1], values[3]),
  ]
}

/** Parses a PDF date (`D:YYYYMMDDHHmmSSOHH'mm'`). */
export function parsePdfDate(text: string | null): Date | null {
  const match = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/.exec(text ?? '')
  if (!match) return null
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00', zone, zoneHours = '00', zoneMinutes = '00'] =
    match
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  const offset = (Number(zoneHours) * 60 + Number(zoneMinutes)) * 60_000
  const time = zone === '+' ? utc - offset : zone === '-' ? utc + offset : utc
  return Number.isFinite(time) ? new Date(time) : null
}

function certificationLevel(doc: PDFDocument, field: SignatureField): 1 | 2 | 3 | null {
  const perms = doc.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict)
  const docMdp = perms?.get(PDFName.of('DocMDP'))
  if (!docMdp || !field.value) return null
  const same = docMdp instanceof PDFRef ? docMdp === field.valueRef : docMdp === field.value
  if (!same) return null
  const references = field.value.lookupMaybe(PDFName.of('Reference'), PDFArray)
  for (let i = 0; i < (references?.size() ?? 0); i += 1) {
    const reference = references?.lookupMaybe(i, PDFDict)
    if (textOf(reference?.get(PDFName.of('TransformMethod'))) !== 'DocMDP') continue
    const p = reference?.lookupMaybe(PDFName.of('TransformParams'), PDFDict)?.lookup(PDFName.of('P'))
    const level = p instanceof PDFNumber ? p.asNumber() : 2
    return level === 1 || level === 3 ? level : 2
  }
  return 2
}

function signerDetails(entry: CertificateEntry): SignerDetails {
  const info = certificateInfo(entry.parsed)
  return {
    name: info.name,
    email: info.email,
    organization: info.organization,
    issuer: info.issuer,
    selfSigned: info.selfSigned,
    notBefore: info.notBefore?.toISOString() ?? null,
    notAfter: info.notAfter?.toISOString() ?? null,
  }
}

async function verifySignature(
  bytes: Uint8Array,
  doc: PDFDocument,
  field: SignatureField,
  anchors: CertificateEntry[],
): Promise<VerifiedSignature> {
  const value = field.value as PDFDict
  const problems: string[] = []
  const subFilter = textOf(value.get(PDFName.of('SubFilter')))
  const result: VerifiedSignature = {
    field: field.name,
    signer: null,
    signedAt: null,
    reason: textOf(value.lookup(PDFName.of('Reason'))),
    location: textOf(value.lookup(PDFName.of('Location'))),
    contactInfo: textOf(value.lookup(PDFName.of('ContactInfo'))),
    subFilter,
    intact: false,
    coversWholeFile: false,
    certifies: certificationLevel(doc, field),
    unauthorizedChanges: [],
    chainVerified: false,
    trusted: anchors.length ? false : null,
    chain: [],
    certificateValidAtSigning: null,
    problems,
  }
  const pdfTime = parsePdfDate(textOf(value.lookup(PDFName.of('M'))))

  const rangeArray = value.lookupMaybe(PDFName.of('ByteRange'), PDFArray)
  const range = (rangeArray?.asArray() ?? []).map((entry) => (entry instanceof PDFNumber ? entry.asNumber() : NaN))
  const [a, b, c, d] = range
  const rangeOk =
    range.length === 4 &&
    range.every((n) => Number.isInteger(n) && n >= 0) &&
    a === 0 &&
    b > 0 &&
    c > b &&
    c + d <= bytes.length
  if (!rangeOk) {
    problems.push('The signature has no valid byte range')
    result.signedAt = pdfTime?.toISOString() ?? null
    return result
  }
  result.coversWholeFile = c + d === bytes.length

  // The gap must hold exactly the /Contents hex string.
  const gap = bytes.subarray(b, c)
  const contents = value.get(PDFName.of('Contents'))
  if (gap[0] !== 0x3c || gap[gap.length - 1] !== 0x3e || !(contents instanceof PDFHexString || contents instanceof PDFString)) {
    problems.push('The signed byte range does not exclude exactly the signature value')
    return result
  }
  let cms = new Uint8Array(contents.asBytes())
  try {
    // /Contents is zero-padded; trim to the outer DER length.
    const outer = readTlv(cms, 0)
    cms = cms.slice(0, outer.end)
  } catch {
    problems.push('The signature value is not valid DER')
    return result
  }

  if (subFilter === 'adbe.pkcs7.sha1' || subFilter === 'adbe.x509.rsa_sha1') {
    problems.push(`${subFilter} signatures are not supported`)
    return result
  }

  let check: CmsCheck
  try {
    check = await checkCms(cms, [bytes.subarray(a, a + b), bytes.subarray(c, c + d)])
  } catch (error) {
    problems.push(`Could not read the signature: ${(error as Error).message}`)
    return result
  }
  problems.push(...check.problems)
  result.intact = check.intact
  const signedAt = check.signingTime ?? pdfTime
  result.signedAt = signedAt?.toISOString() ?? null
  if (check.signer) {
    result.signer = signerDetails(check.signer)
    const chain = await checkChain(check.signer, check.certificates, anchors)
    result.chainVerified = chain.verified
    result.trusted = chain.trusted
    result.chain = chain.names
    if (!chain.verified) problems.push('The certificate chain is incomplete or does not verify')
    if (signedAt) {
      const { notBefore, notAfter } = check.signer.parsed
      result.certificateValidAtSigning =
        (!notBefore || signedAt >= notBefore) && (!notAfter || signedAt <= notAfter)
      if (!result.certificateValidAtSigning) problems.push('The certificate was not valid at the signing time')
    }
  }
  return result
}

/** Verifies every signature in `bytes` and lists the empty signature fields. */
export async function verifyPdf(bytes: Uint8Array, options: VerifyOptions = {}): Promise<VerificationReport> {
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
  } catch (error) {
    throw new VerifyError('unreadable', (error as Error)?.message)
  }
  const anchors = (options.trustAnchors ?? [])
    .map((der) => tryReadCertificate(der))
    .filter((entry): entry is CertificateEntry => entry !== null)
  const fields = signatureFields(doc)
  const signed: Array<{ signature: VerifiedSignature; end: number }> = []
  const emptyFields: EmptySignatureField[] = []
  for (const field of fields) {
    if (field.value) {
      const range = field.value.lookupMaybe(PDFName.of('ByteRange'), PDFArray)?.asArray() ?? []
      const end = range.reduce<number>((sum, entry, index) => (index >= 2 && entry instanceof PDFNumber ? sum + entry.asNumber() : sum), 0)
      signed.push({ signature: await verifySignature(bytes, doc, field, anchors), end })
    } else {
      const widget = widgetOf(field)
      emptyFields.push({ field: field.name, pageIndex: pageIndexOf(doc, widget), rect: rectOf(widget.dict) })
    }
  }
  // Oldest first: a signature that covers less of the file was made earlier.
  signed.sort((x, y) => x.end - y.end)
  const signatures = signed.map((entry) => entry.signature)
  const last = signatures[signatures.length - 1]
  if (last && !last.coversWholeFile) last.problems.push('The file was changed after the last signature')
  for (const { signature, end } of signed) {
    if (signature.coversWholeFile || !signature.intact) continue
    const changes = await laterChanges(bytes, end, doc)
    const unauthorized = [...changes.other]
    if (changes.addedAnnotations && signature.certifies !== 3) unauthorized.push('annotations were added')
    if (signature.certifies === 1) unauthorized.push('this certification allows no changes at all')
    if (signature.certifies === 2 && changes.addedSignatureFields) {
      unauthorized.push('signature fields were added, which this certification does not allow')
    }
    signature.unauthorizedChanges = unauthorized
    if (unauthorized.length) {
      signature.problems.push(`The document was changed after this signature in ways it does not allow: ${unauthorized.join('; ')}`)
    }
  }
  return {
    signatures,
    emptyFields,
    encrypted: doc.isEncrypted,
    valid:
      signatures.length > 0 &&
      signatures.every((signature) => signature.intact && !signature.unauthorizedChanges.length) &&
      Boolean(last?.coversWholeFile),
  }
}
