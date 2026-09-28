import crypto from 'node:crypto'
import forge from 'node-forge'

/**
 * Test certificates and an independent signature checker. The checker uses
 * Node's crypto (not the app's code) to verify every /ByteRange signature in
 * a file, so a passing test means another implementation agrees.
 */

function forgeKeys(type) {
  const { privateKey, publicKey } =
    type === 'ec'
      ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { privateKey, publicKey }
}

function certificate({ subject, issuer, publicKeyPem, signingKeyPem, serial, ca, days = 365 }) {
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.publicKeyFromPem(publicKeyPem)
  cert.serialNumber = serial
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000)
  cert.validity.notAfter = new Date(Date.now() + days * 24 * 3600 * 1000)
  cert.setSubject(subject)
  cert.setIssuer(issuer)
  cert.setExtensions(
    ca
      ? [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]
      : [{ name: 'keyUsage', digitalSignature: true, nonRepudiation: true }],
  )
  cert.sign(forge.pki.privateKeyFromPem(signingKeyPem), forge.md.sha256.create())
  return cert
}

/**
 * An RSA signer certificate issued by a test CA, packed with the CA
 * certificate into a password-protected PKCS#12 file.
 */
export function makeRsaPkcs12({ name = 'Ada Lovelace', password = 'secret', algorithm = '3des' } = {}) {
  const caKeys = forgeKeys('rsa')
  const caPem = caKeys.privateKey.export({ type: 'pkcs1', format: 'pem' })
  const caSubject = [
    { name: 'commonName', value: 'RealPDF Test CA' },
    { name: 'organizationName', value: 'RealPDF Tests' },
  ]
  const ca = certificate({
    subject: caSubject,
    issuer: caSubject,
    publicKeyPem: caKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    signingKeyPem: caPem,
    serial: '01',
    ca: true,
  })
  const keys = forgeKeys('rsa')
  const keyPem = keys.privateKey.export({ type: 'pkcs1', format: 'pem' })
  const leaf = certificate({
    subject: [
      { name: 'commonName', value: name },
      { name: 'organizationName', value: 'Analytical Engines' },
      { name: 'emailAddress', value: 'ada@example.com' },
    ],
    issuer: caSubject,
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    signingKeyPem: caPem,
    serial: '0a1b2c3d',
  })
  const p12 = forge.pkcs12.toPkcs12Asn1(forge.pki.privateKeyFromPem(keyPem), [leaf, ca], password, {
    algorithm,
    friendlyName: name,
  })
  return {
    bytes: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'),
    certificateDer: Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(leaf)).getBytes(), 'binary'),
    caDer: Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(ca)).getBytes(), 'binary'),
    password,
    name,
  }
}

/**
 * A forged chain: a CA issues an ordinary end-entity certificate (what anyone
 * can get from RealPDF by verifying their own email), and that certificate's
 * key then "issues" a leaf naming someone else. Verifiers must refuse it,
 * because an end-entity certificate is not allowed to issue certificates.
 */
export function makeForgedChainPkcs12({ password = 'secret' } = {}) {
  const caKeys = forgeKeys('rsa')
  const caPem = caKeys.privateKey.export({ type: 'pkcs1', format: 'pem' })
  const caSubject = [{ name: 'commonName', value: 'RealPDF Test CA' }]
  const ca = certificate({
    subject: caSubject,
    issuer: caSubject,
    publicKeyPem: caKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    signingKeyPem: caPem,
    serial: '01',
    ca: true,
  })
  const attackerKeys = forgeKeys('rsa')
  const attackerPem = attackerKeys.privateKey.export({ type: 'pkcs1', format: 'pem' })
  const attackerSubject = [
    { name: 'commonName', value: 'Mallory' },
    { name: 'emailAddress', value: 'mallory@example.com' },
  ]
  const attacker = certificate({
    subject: attackerSubject,
    issuer: caSubject,
    publicKeyPem: attackerKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    signingKeyPem: caPem,
    serial: '02',
  })
  const keys = forgeKeys('rsa')
  const keyPem = keys.privateKey.export({ type: 'pkcs1', format: 'pem' })
  const forged = certificate({
    subject: [
      { name: 'commonName', value: 'Ada Lovelace' },
      { name: 'emailAddress', value: 'ada@example.com' },
    ],
    issuer: attackerSubject,
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    signingKeyPem: attackerPem,
    serial: '03',
  })
  const p12 = forge.pkcs12.toPkcs12Asn1(forge.pki.privateKeyFromPem(keyPem), [forged, attacker, ca], password, {
    algorithm: '3des',
  })
  return {
    bytes: Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'),
    caDer: Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(ca)).getBytes(), 'binary'),
    password,
  }
}

const OID = {
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  signingTime: '1.2.840.113549.1.9.5',
}

function asn1OfBytes(bytes) {
  return forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(bytes).toString('binary')))
}

function derBytes(node) {
  return Buffer.from(forge.asn1.toDer(node).getBytes(), 'binary')
}

/**
 * Finds every signature in a PDF and verifies it the way a reader does: the
 * byte ranges hash to the signed message digest, and the signature over the
 * signed attributes verifies with the embedded signer certificate.
 */
export function verifyPdfSignatures(pdfBytes) {
  const bytes = Buffer.from(pdfBytes)
  const text = bytes.toString('latin1')
  const results = []
  const pattern = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g
  for (const match of text.matchAll(pattern)) {
    const [a, b, c, d] = match.slice(1).map(Number)
    const result = { byteRange: [a, b, c, d], coversFile: c + d === bytes.length && a === 0 }
    try {
      const hex = text.slice(b + 1, c - 1).replace(/(00)+$/, '')
      const cms = asn1OfBytes(Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex'))
      const signedData = cms.value[1].value[0]
      const parts = signedData.value
      const certificates = parts.find((node) => node.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && node.type === 0)
      const signerInfo = parts[parts.length - 1].value[0]
      const attrs = signerInfo.value.find((node) => node.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && node.type === 0)
      const signature = Buffer.from(signerInfo.value[signerInfo.value.length - 1].value, 'binary')
      const attributes = new Map(attrs.value.map((attr) => [forge.asn1.derToOid(attr.value[0].value), attr.value[1].value[0]]))
      const digest = crypto.createHash('sha256').update(bytes.subarray(a, a + b)).update(bytes.subarray(c, c + d)).digest()
      const signedDigest = Buffer.from(attributes.get(OID.messageDigest).value, 'binary')
      const certs = certificates.value.map((node) => new crypto.X509Certificate(derBytes(node)))
      const signer = certs[0]
      // Re-tag [0] IMPLICIT as a SET (0x31), which is what was signed.
      const signedAttrs = derBytes(attrs)
      signedAttrs[0] = 0x31
      result.digestMatches = digest.equals(signedDigest)
      result.signatureValid = crypto.verify('sha256', signedAttrs, signer.publicKey, signature)
      result.signer = signer.subject
      result.certificates = certs.map((cert) => cert.raw)
      result.hasSigningCertificateV2 = attributes.has(OID.signingCertificateV2)
      result.hasSigningTime = attributes.has(OID.signingTime)
      result.valid = result.digestMatches && result.signatureValid
    } catch (error) {
      result.valid = false
      result.error = String(error)
    }
    results.push(result)
  }
  return results
}
