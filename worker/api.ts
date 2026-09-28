import type { BlobStore } from './store.ts'
import { toBase64 } from './encoding.ts'
import { derToPem, type CertificateAuthority } from './certificateAuthority.ts'
import {
  addSignRequestVersion,
  createSignRequest,
  deleteSignRequest,
  getSignRequest,
  MAX_VERSION_BYTES,
  readSignRequestVersion,
  SignRequestError,
} from './signRequests.ts'
import { IdentityError, issueVerifiedCertificate, startEmailVerification, type SendEmail } from './signingIdentity.ts'

/**
 * HTTP routes under /api/ for signing requests and email-verified
 * certificates. The logic lives in signRequests.ts and signingIdentity.ts;
 * this file only maps requests and errors. The Worker and the Vite dev
 * server both call `handleApi`.
 *
 *   POST   /api/sign-requests                       create (body: ciphertext)
 *   GET    /api/sign-requests/:id                   status
 *   GET    /api/sign-requests/:id/versions/:n|latest ciphertext of one version
 *   POST   /api/sign-requests/:id/versions          add a signed copy
 *   DELETE /api/sign-requests/:id                   delete (owner only)
 *   POST   /api/identity/verify-email               { email } -> emails a code
 *   POST   /api/identity/certificate                { challengeId, code, name, publicKey, proof }
 *   GET    /api/identity/ca.pem                     RealPDF's CA certificate
 */

export interface ApiDeps {
  store: BlobStore
  /** Null when the CA secrets are not configured. */
  certificateAuthority: () => Promise<CertificateAuthority | null>
  /** Null when email sending is not configured. */
  sendEmail: SendEmail | null
  /** Resolves false when the caller is over a rate limit. */
  allow?: (bucket: 'write' | 'email', key: string) => Promise<boolean>
  now?: () => number
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function error(code: string, status: number): Response {
  return json({ error: code }, status)
}

async function readBody(request: Request): Promise<Uint8Array | Response> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_VERSION_BYTES) return error('tooLarge', 413)
  // Stop reading once the limit is passed, whatever Content-Length said (or when it is missing).
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_VERSION_BYTES) {
      await reader.cancel()
      return error('tooLarge', 413)
    }
    chunks.push(value)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.length
  }
  return body
}

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  if (Number(request.headers.get('content-length') ?? 0) > 64 * 1024) return error('tooLarge', 413)
  try {
    const value = await request.json()
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : error('badRequest', 400)
  } catch {
    return error('badRequest', 400)
  }
}

function clientKey(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
}

export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
  const url = new URL(request.url)
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean)
  const method = request.method.toUpperCase()
  const now = deps.now?.() ?? Date.now()
  const allow = async (bucket: 'write' | 'email', key: string) => (deps.allow ? deps.allow(bucket, key) : true)

  try {
    if (parts[0] === 'sign-requests') {
      const [, id, sub, index] = parts
      if (!id && method === 'POST') {
        if (!(await allow('write', clientKey(request)))) return error('rateLimited', 429)
        const body = await readBody(request)
        if (body instanceof Response) return body
        const status = await createSignRequest(deps.store, {
          ciphertext: body,
          writeToken: request.headers.get('x-write-token') ?? '',
          ownerToken: request.headers.get('x-owner-token') ?? '',
          now,
        })
        return json(status, 201)
      }
      if (id && !sub && method === 'GET') return json(await getSignRequest(deps.store, id, now))
      if (id && !sub && method === 'DELETE') {
        await deleteSignRequest(deps.store, id, request.headers.get('x-owner-token') ?? '')
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
      }
      if (id && sub === 'versions' && !index && method === 'POST') {
        if (!(await allow('write', clientKey(request)))) return error('rateLimited', 429)
        const body = await readBody(request)
        if (body instanceof Response) return body
        const status = await addSignRequestVersion(deps.store, id, {
          ciphertext: body,
          writeToken: request.headers.get('x-write-token') ?? '',
          now,
        })
        return json(status, 201)
      }
      if (id && sub === 'versions' && index && method === 'GET') {
        const which = index === 'latest' ? 'latest' : /^\d{1,3}$/.test(index) ? Number(index) : null
        if (which === null) return error('notFound', 404)
        const bytes = await readSignRequestVersion(deps.store, id, which, now)
        return new Response(bytes, {
          headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
        })
      }
      return error('notFound', 404)
    }

    if (parts[0] === 'identity') {
      if (parts[1] === 'verify-email' && method === 'POST') {
        const body = await readJson(request)
        if (body instanceof Response) return body
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
        if (!(await allow('email', clientKey(request))) || !(await allow('email', `to:${email}`))) {
          return error('rateLimited', 429)
        }
        const challenge = await startEmailVerification(deps.store, { email: body.email, send: deps.sendEmail, now })
        return json(challenge, 201)
      }
      if (parts[1] === 'certificate' && method === 'POST') {
        if (!(await allow('write', clientKey(request)))) return error('rateLimited', 429)
        const body = await readJson(request)
        if (body instanceof Response) return body
        const issued = await issueVerifiedCertificate(deps.store, await deps.certificateAuthority(), {
          challengeId: body.challengeId,
          code: body.code,
          name: body.name,
          publicKey: body.publicKey,
          proof: body.proof,
          now,
        })
        return json(
          {
            certificate: toBase64(issued.certificate),
            chain: issued.chain.map((der) => toBase64(der)),
            email: issued.email,
            name: issued.name,
          },
          201,
        )
      }
      if (parts[1] === 'ca.pem' && method === 'GET') {
        const ca = await deps.certificateAuthority()
        if (!ca) return error('unavailable', 503)
        return new Response(derToPem(ca.certificate.der), {
          headers: {
            'Content-Type': 'application/x-pem-file',
            'Content-Disposition': 'attachment; filename="realpdf-ca.pem"',
            'Cache-Control': 'public, max-age=3600',
          },
        })
      }
      return error('notFound', 404)
    }

    return error('notFound', 404)
  } catch (caught) {
    if (caught instanceof SignRequestError || caught instanceof IdentityError) return error(caught.code, caught.status)
    throw caught
  }
}
