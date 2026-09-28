import { compareBytes, der, encodeDer, parseDer, type Asn1 } from './der'
import { parseCertificate, signatureParams, type SigningIdentity } from './identity'

/**
 * Builds a detached CMS SignedData (RFC 5652) over a precomputed SHA-256
 * digest, in the CAdES form PAdES baseline signatures use: the signed
 * attributes are content-type, message-digest and signing-certificate-v2, and
 * the signing time lives in the PDF signature dictionary (/M) instead of a
 * signing-time attribute. node-forge provides the ASN.1 encoding; hashing
 * and the private-key operation run in WebCrypto.
 */

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
}

export async function sha256(...parts: Uint8Array[]): Promise<Uint8Array<ArrayBuffer>> {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', joined))
}

function attribute(type: string, value: Asn1): Asn1 {
  return der.seq([der.oid(type), der.set([value])])
}

/** WebCrypto returns ECDSA signatures as r||s; CMS wants SEQUENCE { r, s }. */
function ecdsaToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2
  return encodeDer(der.seq([der.unsigned(raw.subarray(0, half)), der.unsigned(raw.subarray(half))]))
}

export async function createCmsSignature(identity: SigningIdentity, digest: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const signer = parseCertificate(identity.certificate)
  const certHash = await sha256(identity.certificate)
  const issuerSerial = der.seq([der.seq([der.tagged(4, [signer.issuer])]), signer.serial])

  const attributes = [
    attribute(OID.contentType, der.oid(OID.data)),
    attribute(OID.messageDigest, der.octets(digest)),
    // ESSCertIDv2 with the default (SHA-256) hash algorithm omitted.
    attribute(OID.signingCertificateV2, der.seq([der.seq([der.seq([der.octets(certHash), issuerSerial])])])),
  ]
    .map((node) => encodeDer(node))
    .sort(compareBytes) // DER orders SET OF members by their encodings.
    .map((bytes) => parseDer(bytes))

  // The signature covers the attributes encoded as a SET (tag 0x31), while
  // SignerInfo stores the same content under an implicit [0] tag.
  const signedAttributes = encodeDer(der.set(attributes))
  const raw = new Uint8Array(
    await crypto.subtle.sign(signatureParams(identity.keyType), identity.key, signedAttributes),
  )
  const signature = identity.keyType === 'EC' ? ecdsaToDer(raw) : raw
  const signatureAlgorithm =
    identity.keyType === 'EC' ? der.seq([der.oid(OID.ecdsaWithSHA256)]) : der.seq([der.oid(OID.sha256WithRSA), der.null()])
  const digestAlgorithm = der.seq([der.oid(OID.sha256)])

  const signerInfo = der.seq([
    der.int(1),
    der.seq([signer.issuer, signer.serial]),
    digestAlgorithm,
    der.tagged(0, attributes),
    signatureAlgorithm,
    der.octets(signature),
  ])
  const certificates = [identity.certificate, ...identity.chain].map((bytes) => parseDer(bytes))
  const signedData = der.seq([
    der.int(1),
    der.set([der.seq([der.oid(OID.sha256)])]),
    der.seq([der.oid(OID.data)]),
    der.tagged(0, certificates),
    der.set([signerInfo]),
  ])
  return encodeDer(der.seq([der.oid(OID.signedData), der.tagged(0, [signedData])]))
}

/** Hex for the signature dictionary's /Contents string. */
export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out.toUpperCase()
}
