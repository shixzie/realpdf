import forge from 'node-forge'
import {
  asn1Date,
  asn1String,
  bytesEqual,
  children,
  encodeDer,
  oidOf,
  parseDer,
  toBinary,
  type Asn1,
} from './der'

/**
 * A signing identity read from a PKCS#12 (.p12/.pfx) file. The private key is
 * imported into WebCrypto as non-extractable and only lives in this tab.
 */
export interface SigningIdentity {
  /** DER of the signer's certificate. */
  certificate: Uint8Array<ArrayBuffer>
  /** DER of the other certificates in the file, issuer first. */
  chain: Uint8Array<ArrayBuffer>[]
  key: CryptoKey
  keyType: 'RSA' | 'EC'
  info: CertificateInfo
}

export interface CertificateInfo {
  /** Common name, or the whole subject when it has none. */
  name: string
  email: string | null
  organization: string | null
  issuer: string
  notBefore: Date | null
  notAfter: Date | null
  selfSigned: boolean
}

export type CertificateErrorCode = 'invalidFile' | 'password' | 'noKey' | 'unsupportedKey' | 'noCertificate'

export class CertificateError extends Error {
  readonly code: CertificateErrorCode
  constructor(code: CertificateErrorCode, message?: string) {
    super(message ?? code)
    this.code = code
  }
}

const OID = {
  rsaEncryption: '1.2.840.113549.1.1.1',
  ecPublicKey: '1.2.840.10045.2.1',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  email: '1.2.840.113549.1.9.1',
}

const CURVES: Record<string, string> = {
  '1.2.840.10045.3.1.7': 'P-256',
  '1.3.132.0.34': 'P-384',
  '1.3.132.0.35': 'P-521',
}

const SHORT_NAMES: Record<string, string> = {
  [OID.commonName]: 'CN',
  '2.5.4.11': 'OU',
  [OID.organization]: 'O',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.6': 'C',
  [OID.email]: 'E',
}

/** The parts of an X.509 certificate the signer needs, read from its DER. */
export interface ParsedCertificate {
  der: Uint8Array<ArrayBuffer>
  serial: Asn1
  issuer: Asn1
  subject: Asn1
  issuerDer: Uint8Array
  subjectDer: Uint8Array
  spki: Uint8Array<ArrayBuffer>
  notBefore: Date | null
  notAfter: Date | null
}

export function parseCertificate(der: Uint8Array<ArrayBuffer>): ParsedCertificate {
  const tbs = children(parseDer(der))[0]
  const fields = children(tbs)
  // `version` is an optional explicit [0] tag in front of the serial number.
  const offset = fields[0]?.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC ? 1 : 0
  const serial = fields[offset]
  const issuer = fields[offset + 2]
  const validity = children(fields[offset + 3])
  const subject = fields[offset + 4]
  const spki = fields[offset + 5]
  if (!serial || !issuer || !subject || !spki) throw new CertificateError('noCertificate')
  return {
    der,
    serial,
    issuer,
    subject,
    issuerDer: encodeDer(issuer),
    subjectDer: encodeDer(subject),
    spki: encodeDer(spki),
    notBefore: asn1Date(validity[0]),
    notAfter: asn1Date(validity[1]),
  }
}

function nameAttributes(name: Asn1): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const rdn of children(name)) {
    for (const attribute of children(rdn)) {
      const [type, value] = children(attribute)
      const oid = oidOf(type)
      if (oid) out.push([oid, asn1String(value)])
    }
  }
  return out
}

function describeName(name: Asn1): string {
  return nameAttributes(name)
    .map(([oid, value]) => `${SHORT_NAMES[oid] ?? oid}=${value}`)
    .reverse()
    .join(', ')
}

function nameValue(name: Asn1, oid: string): string | null {
  const hit = nameAttributes(name).filter(([type]) => type === oid)
  return hit.length ? hit[hit.length - 1][1] : null
}

export function certificateInfo(cert: ParsedCertificate): CertificateInfo {
  return {
    name: nameValue(cert.subject, OID.commonName) ?? describeName(cert.subject),
    email: nameValue(cert.subject, OID.email),
    organization: nameValue(cert.subject, OID.organization),
    issuer: nameValue(cert.issuer, OID.commonName) ?? describeName(cert.issuer),
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
    selfSigned: bytesEqual(cert.issuerDer, cert.subjectDer),
  }
}

interface KeyImport {
  type: 'RSA' | 'EC'
  algorithm: RsaHashedImportParams | EcKeyImportParams
}

/** Picks the WebCrypto algorithm from a PKCS#8 PrivateKeyInfo. */
function keyImportFor(privateKeyInfo: Asn1): KeyImport {
  const algorithm = children(children(privateKeyInfo)[1])
  const oid = oidOf(algorithm[0])
  if (oid === OID.rsaEncryption) {
    return { type: 'RSA', algorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } }
  }
  if (oid === OID.ecPublicKey) {
    const curve = CURVES[oidOf(algorithm[1]) ?? '']
    if (curve) return { type: 'EC', algorithm: { name: 'ECDSA', namedCurve: curve } }
  }
  throw new CertificateError('unsupportedKey')
}

export function signatureParams(keyType: SigningIdentity['keyType']): AlgorithmIdentifier | EcdsaParams {
  return keyType === 'RSA' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' }
}

function readPkcs12(bytes: Uint8Array, password: string): forge.pkcs12.Pkcs12Pfx {
  let parsed: Asn1
  try {
    parsed = forge.asn1.fromDer(forge.util.createBuffer(toBinary(bytes)), false)
  } catch {
    throw new CertificateError('invalidFile')
  }
  // An empty password is encoded differently by different tools; try both.
  const attempts: Array<string | null> = password ? [password] : ['', null]
  let lastError: unknown = null
  for (const attempt of attempts) {
    try {
      return forge.pkcs12.pkcs12FromAsn1(parsed, false, attempt as string)
    } catch (error) {
      lastError = error
    }
  }
  const message = String((lastError as Error)?.message ?? '')
  if (/not an? PKCS#12|unsupported|only x\.509/i.test(message)) throw new CertificateError('invalidFile', message)
  throw new CertificateError('password', message)
}

/**
 * Opens a PKCS#12 file: decrypts it with the password, imports the private key
 * into WebCrypto and finds the certificate that belongs to it (by signing a
 * probe and verifying it against each certificate's public key).
 */
export async function loadSigningIdentity(bytes: Uint8Array, password: string): Promise<SigningIdentity> {
  const p12 = readPkcs12(bytes, password)
  const { oids } = forge.pki
  const keyBags = [
    ...(p12.getBags({ bagType: oids.pkcs8ShroudedKeyBag })[oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: oids.keyBag })[oids.keyBag] ?? []),
  ]
  const certBags = p12.getBags({ bagType: oids.certBag })[oids.certBag] ?? []
  if (!keyBags.length) throw new CertificateError('noKey')

  const certificates: ParsedCertificate[] = []
  for (const bag of certBags) {
    const node = bag.cert ? forge.pki.certificateToAsn1(bag.cert) : (bag as { asn1?: Asn1 }).asn1
    if (!node) continue
    try {
      certificates.push(parseCertificate(encodeDer(node)))
    } catch {
      // Skip certificates we cannot read; the signer's own one is checked below.
    }
  }
  if (!certificates.length) throw new CertificateError('noCertificate')

  const probe = crypto.getRandomValues(new Uint8Array(32))
  for (const bag of keyBags) {
    const keyInfo = bag.key
      ? forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(bag.key))
      : (bag as { asn1?: Asn1 }).asn1
    if (!keyInfo) continue
    const { type, algorithm } = keyImportFor(keyInfo)
    const der = encodeDer(keyInfo)
    const key = await crypto.subtle.importKey('pkcs8', der, algorithm, false, ['sign'])
    der.fill(0)
    const signature = await crypto.subtle.sign(signatureParams(type), key, probe)
    for (const cert of certificates) {
      let matches = false
      try {
        const publicKey = await crypto.subtle.importKey('spki', cert.spki, algorithm, false, ['verify'])
        matches = await crypto.subtle.verify(signatureParams(type), publicKey, signature, probe)
      } catch {
        matches = false
      }
      if (!matches) continue
      return {
        certificate: cert.der,
        chain: orderChain(cert, certificates),
        key,
        keyType: type,
        info: certificateInfo(cert),
      }
    }
  }
  throw new CertificateError('noCertificate')
}

/** The other certificates in the file, walking up from the signer's issuer. */
function orderChain(leaf: ParsedCertificate, all: ParsedCertificate[]): Uint8Array<ArrayBuffer>[] {
  const rest = all.filter((cert) => cert !== leaf && !bytesEqual(cert.der, leaf.der))
  const ordered: ParsedCertificate[] = []
  let current = leaf
  while (true) {
    if (bytesEqual(current.issuerDer, current.subjectDer)) break
    const issuer = rest.find((cert) => !ordered.includes(cert) && bytesEqual(cert.subjectDer, current.issuerDer))
    if (!issuer) break
    ordered.push(issuer)
    current = issuer
  }
  for (const cert of rest) if (!ordered.includes(cert)) ordered.push(cert)
  return ordered.map((cert) => cert.der)
}
