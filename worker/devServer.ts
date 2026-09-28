import crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import forge from 'node-forge'
import { handleApi } from './api'
import { loadCertificateAuthority, type CertificateAuthority } from './certificateAuthority'
import { memoryStore } from './store'
import type { EmailMessage } from './signingIdentity'

/**
 * The /api/ routes for `npm run dev`, `npm run preview` and the test suite,
 * served by Vite's Node server with the same handler the Worker uses. Storage
 * is in memory, the CA is generated at startup, and emails are kept in an
 * outbox that `/api/dev/outbox?to=` reads (so tests can fetch the code).
 * Nothing here is part of the Worker bundle.
 */

export function makeDevCertificateAuthority(): Promise<CertificateAuthority> {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const cert = forge.pki.createCertificate()
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }) as string)
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000)
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000)
  const subject = [
    { name: 'commonName', value: 'RealPDF Development CA' },
    { name: 'organizationName', value: 'RealPDF' },
  ]
  cert.setSubject(subject)
  cert.setIssuer(subject)
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ])
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  cert.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create())
  return loadCertificateAuthority(keyPem, forge.pki.certificateToPem(cert))
}

async function readRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) headers.set(name, value.join(', '))
  }
  const method = req.method ?? 'GET'
  const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks)
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, { method, headers, body })
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status
  response.headers.forEach((value, name) => res.setHeader(name, value))
  res.end(Buffer.from(await response.arrayBuffer()))
}

export function signingApiMiddleware() {
  const store = memoryStore()
  const outbox: EmailMessage[] = []
  let ca: Promise<CertificateAuthority> | null = null
  const deps = {
    store,
    certificateAuthority: () => (ca ??= makeDevCertificateAuthority()),
    sendEmail: async (message: EmailMessage) => {
      outbox.push(message)
      console.info(`[realpdf dev] email to ${message.to}: ${message.subject}`)
    },
  }
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api/')) return next()
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname === '/api/dev/outbox') {
          const to = url.searchParams.get('to')?.toLowerCase()
          const messages = outbox.filter((message) => !to || message.to === to)
          await writeResponse(res, Response.json(messages.slice(-10)))
          return
        }
        await writeResponse(res, await handleApi(await readRequest(req), deps))
      } catch (error) {
        console.error(error)
        res.statusCode = 500
        res.end('Internal Server Error')
      }
    })()
  }
}
