/**
 * Creates the certificate authority that issues RealPDF's email-verified
 * signing certificates: an RSA-3072 key and a 10-year self-signed CA
 * certificate. Run once, then store both as Worker secrets:
 *
 *   node scripts/make-signing-ca.mjs
 *   npx wrangler secret put SIGNING_CA_KEY < .signing-ca/ca-key.pem
 *   npx wrangler secret put SIGNING_CA_CERT < .signing-ca/ca-cert.pem
 *
 * Keep .signing-ca/ca-key.pem offline (a password manager) and delete it from
 * disk; anyone with it can issue RealPDF certificates.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import forge from 'node-forge'

const outDir = path.resolve(process.argv[2] ?? '.signing-ca')
const name = process.env.SIGNING_CA_NAME ?? 'RealPDF Email Verification CA'

if (fs.existsSync(path.join(outDir, 'ca-key.pem'))) {
  console.error(`${outDir}/ca-key.pem already exists; refusing to overwrite it.`)
  process.exit(1)
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 })
const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const cert = forge.pki.createCertificate()
cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }))
cert.serialNumber = `01${crypto.randomBytes(15).toString('hex')}`
cert.validity.notBefore = new Date(Date.now() - 60 * 60 * 1000)
cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000)
const subject = [
  { name: 'commonName', value: name },
  { name: 'organizationName', value: 'RealPDF' },
]
cert.setSubject(subject)
cert.setIssuer(subject)
cert.setExtensions([
  { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
  { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
  { name: 'subjectKeyIdentifier' },
])
cert.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create())

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'ca-key.pem'), keyPem, { mode: 0o600 })
fs.writeFileSync(path.join(outDir, 'ca-cert.pem'), forge.pki.certificateToPem(cert))
console.log(`Wrote ${outDir}/ca-key.pem and ${outDir}/ca-cert.pem`)
console.log('Next:')
console.log(`  npx wrangler secret put SIGNING_CA_KEY < ${path.relative(process.cwd(), outDir)}/ca-key.pem`)
console.log(`  npx wrangler secret put SIGNING_CA_CERT < ${path.relative(process.cwd(), outDir)}/ca-cert.pem`)
