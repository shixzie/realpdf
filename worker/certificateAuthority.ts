import forge from 'node-forge'
import { children, der, encodeDer, fromBinary, oidOf, parseDer, toBinary, type Asn1 } from '../src/lib/signing/der.ts'
import { parseCertificate, type ParsedCertificate } from '../src/lib/signing/identity.ts'

/**
 * RealPDF's certificate authority: issues X.509 signing certificates for
 * email addresses the service has verified. Its key is a Worker secret
 * (PKCS#8 PEM) and never reaches the browser; the browser keeps the signer's
 * own private key and only sends the public half.
 */

const { asn1 } = forge
const { Class, Type } = asn1

const OID = {
  rsaEncryption: '1.2.840.113549.1.1.1',
  ecPublicKey: '1.2.840.10045.2.1',
  p256: '1.2.840.10045.3.1.7',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organizationalUnit: '2.5.4.11',
  emailAddress: '1.2.840.113549.1.9.1',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyIdentifier: '2.5.29.14',
  authorityKeyIdentifier: '2.5.29.35',
  emailProtection: '1.3.6.1.5.5.7.3.4',
  documentSigning: '1.3.6.1.5.5.7.3.36',
}

/** Issued certificates are valid for a year; people renew by verifying again. */
export const CERTIFICATE_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000

export interface CertificateAuthority {
  certificate: ParsedCertificate
  key: CryptoKey
  keyType: 'RSA' | 'EC'
}

export interface SubjectPublicKey {
  der: Uint8Array<ArrayBuffer>
  keyType: 'RSA' | 'EC'
  key: CryptoKey
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '')
  return fromBinary(atob(body))
}

export function derToPem(bytes: Uint8Array, label = 'CERTIFICATE'): string {
  const base64 = btoa(toBinary(bytes))
  return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END ${label}-----\n`
}

function algorithmFor(keyType: 'RSA' | 'EC'): RsaHashedImportParams | EcKeyImportParams {
  return keyType === 'RSA' ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } : { name: 'ECDSA', namedCurve: 'P-256' }
}

function signParams(keyType: 'RSA' | 'EC'): AlgorithmIdentifier | EcdsaParams {
  return keyType === 'RSA' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' }
}

/** Key type of a SubjectPublicKeyInfo or PrivateKeyInfo algorithm identifier. */
function keyTypeOf(algorithm: Asn1 | undefined): 'RSA' | 'EC' | null {
  const [id, params] = children(algorithm)
  const oid = oidOf(id)
  if (oid === OID.rsaEncryption) return 'RSA'
  if (oid === OID.ecPublicKey && oidOf(params) === OID.p256) return 'EC'
  return null
}

export async function loadCertificateAuthority(keyPem: string, certificatePem: string): Promise<CertificateAuthority> {
  const keyDer = pemToDer(keyPem)
  const keyType = keyTypeOf(children(parseDer(keyDer))[1])
  if (!keyType) throw new Error('The CA key must be RSA or ECDSA P-256 in PKCS#8 PEM')
  const key = await crypto.subtle.importKey('pkcs8', keyDer, algorithmFor(keyType), false, ['sign'])
  return { certificate: parseCertificate(pemToDer(certificatePem)), key, keyType }
}

/** Imports a SubjectPublicKeyInfo (RSA or ECDSA P-256) sent by a browser. */
export async function importSubjectPublicKey(spki: Uint8Array<ArrayBuffer>): Promise<SubjectPublicKey> {
  let keyType: 'RSA' | 'EC' | null = null
  try {
    keyType = keyTypeOf(children(parseDer(spki))[0])
  } catch {
    keyType = null
  }
  if (!keyType) throw new Error('unsupportedKey')
  const key = await crypto.subtle.importKey('spki', spki, algorithmFor(keyType), true, ['verify'])
  if (keyType === 'RSA') {
    const bits = (key.algorithm as RsaHashedKeyAlgorithm).modulusLength
    if (bits < 2048 || bits > 8192) throw new Error('unsupportedKey')
  }
  return { der: spki, keyType, key }
}

/** Checks a signature made with the subject's private key (proof of possession). */
export async function verifyWithSubjectKey(subject: SubjectPublicKey, signature: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>) {
  try {
    return await crypto.subtle.verify(signParams(subject.keyType), subject.key, signature, data)
  } catch {
    return false
  }
}

const utf8 = (text: string) => asn1.create(Class.UNIVERSAL, Type.UTF8, false, forge.util.encodeUtf8(text))
const ia5 = (text: string) => asn1.create(Class.UNIVERSAL, Type.IA5STRING, false, text)
const bitString = (bytes: Uint8Array, unusedBits = 0) =>
  asn1.create(Class.UNIVERSAL, Type.BITSTRING, false, String.fromCharCode(unusedBits) + toBinary(bytes))
const utcTime = (date: Date) => asn1.create(Class.UNIVERSAL, Type.UTCTIME, false, asn1.dateToUtcTime(date))
const boolTrue = () => asn1.create(Class.UNIVERSAL, Type.BOOLEAN, false, '\xff')

function rdn(oid: string, value: Asn1): Asn1 {
  return der.set([der.seq([der.oid(oid), value])])
}

function extension(oid: string, critical: boolean, value: Asn1): Asn1 {
  const parts = [der.oid(oid)]
  if (critical) parts.push(boolTrue())
  parts.push(der.octets(encodeDer(value)))
  return der.seq(parts)
}

/** SHA-1 of the subjectPublicKey bits, the usual key identifier (RFC 5280 4.2.1.2). */
async function keyIdentifier(spki: Uint8Array): Promise<Uint8Array> {
  const bits = children(parseDer(spki))[1] as (Asn1 & { bitStringContents?: string }) | undefined
  // forge decodes BIT STRINGs that look like DER (an RSA key does) and keeps
  // the original bytes in bitStringContents.
  const contents = typeof bits?.value === 'string' ? bits.value : (bits?.bitStringContents ?? '')
  const raw = fromBinary(contents.slice(1))
  return new Uint8Array(await crypto.subtle.digest('SHA-1', raw))
}

function signatureAlgorithm(keyType: 'RSA' | 'EC'): Asn1 {
  return keyType === 'RSA' ? der.seq([der.oid(OID.sha256WithRSA), der.null()]) : der.seq([der.oid(OID.ecdsaWithSHA256)])
}

/** WebCrypto returns ECDSA signatures as r||s; X.509 wants SEQUENCE { r, s }. */
function ecdsaToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2
  return encodeDer(der.seq([der.unsigned(raw.subarray(0, half)), der.unsigned(raw.subarray(half))]))
}

export interface IssueOptions {
  name: string
  email: string
  subjectKey: SubjectPublicKey
  now?: number
}

/**
 * Issues an end-entity certificate: CN is the name the person typed, the
 * email (verified) goes in the subject and subjectAltName, and the key usage
 * is limited to signing documents.
 */
export async function issueCertificate(ca: CertificateAuthority, options: IssueOptions): Promise<Uint8Array<ArrayBuffer>> {
  const now = options.now ?? Date.now()
  const serial = crypto.getRandomValues(new Uint8Array(16))
  serial[0] &= 0x7f
  serial[0] |= 0x40

  const subject = der.seq([
    rdn(OID.commonName, utf8(options.name)),
    rdn(OID.organizationalUnit, utf8('Email verified by RealPDF')),
    rdn(OID.emailAddress, ia5(options.email)),
  ])
  const spki = parseDer(options.subjectKey.der)
  const extensions = [
    extension(OID.basicConstraints, true, der.seq([])),
    // digitalSignature (bit 0) and nonRepudiation (bit 1).
    extension(OID.keyUsage, true, bitString(Uint8Array.of(0xc0), 6)),
    extension(OID.extKeyUsage, false, der.seq([der.oid(OID.documentSigning), der.oid(OID.emailProtection)])),
    extension(
      OID.subjectAltName,
      false,
      der.seq([asn1.create(Class.CONTEXT_SPECIFIC, 1, false, options.email)]),
    ),
    extension(OID.subjectKeyIdentifier, false, der.octets(await keyIdentifier(options.subjectKey.der))),
    extension(
      OID.authorityKeyIdentifier,
      false,
      der.seq([asn1.create(Class.CONTEXT_SPECIFIC, 0, false, toBinary(await keyIdentifier(ca.certificate.spki)))]),
    ),
  ]
  const tbs = der.seq([
    der.tagged(0, [der.int(2)]),
    der.unsigned(serial),
    signatureAlgorithm(ca.keyType),
    ca.certificate.subject,
    der.seq([utcTime(new Date(now - 5 * 60 * 1000)), utcTime(new Date(now + CERTIFICATE_LIFETIME_MS))]),
    subject,
    spki,
    der.tagged(3, [der.seq(extensions)]),
  ])
  const tbsDer = encodeDer(tbs)
  const raw = new Uint8Array(await crypto.subtle.sign(signParams(ca.keyType), ca.key, tbsDer))
  const signature = ca.keyType === 'EC' ? ecdsaToDer(raw) : raw
  return encodeDer(der.seq([parseDer(tbsDer), signatureAlgorithm(ca.keyType), bitString(signature)]))
}
