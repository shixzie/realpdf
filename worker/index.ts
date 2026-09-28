import { tracing } from 'cloudflare:workers'
import { handleApi, type ApiDeps } from './api.ts'
import { loadCertificateAuthority, type CertificateAuthority } from './certificateAuthority.ts'
import { handleMcp, MCP_PATH } from './mcp/index.ts'
import { purgeExpiredSignRequests } from './signRequests.ts'
import { purgeExpiredChallenges } from './signingIdentity.ts'

/** Secrets set with `wrangler secret put`; optional (see wrangler.jsonc). */
type WorkerEnv = Env & { SIGNING_CA_KEY?: string; SIGNING_CA_CERT?: string }

// These mirror public/_headers. With assets.run_worker_first enabled the
// assets layer no longer applies _headers to responses, so the Worker does.
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Strict-Transport-Security': 'max-age=31536000',
  // Scripts only from this origin: signing keys, decrypted documents and request
  // links live in this page. 'wasm-unsafe-eval' is for pdf.js's image decoders,
  // inline styles are for React, and ko-fi.com is framed by the Support dialog.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data: blob:; img-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src https://ko-fi.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
}

function cacheControlFor(pathname: string): string | undefined {
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable'
  if (pathname.startsWith('/pdfjs-assets/')) return 'public, max-age=604800'
  return undefined
}

function applyAssetHeaders(response: Response, pathname: string): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)
  const cacheControl = cacheControlFor(pathname)
  if (cacheControl) headers.set('Cache-Control', cacheControl)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

let caPromise: Promise<CertificateAuthority | null> | null = null

function certificateAuthority(env: WorkerEnv): Promise<CertificateAuthority | null> {
  if (!caPromise) {
    caPromise =
      env.SIGNING_CA_KEY && env.SIGNING_CA_CERT
        ? loadCertificateAuthority(env.SIGNING_CA_KEY, env.SIGNING_CA_CERT).catch((error) => {
            caPromise = null
            logEvent('ca_error', { message: error instanceof Error ? error.message : String(error) })
            return null
          })
        : Promise.resolve(null)
  }
  return caPromise
}

function apiDeps(env: WorkerEnv): ApiDeps {
  return {
    store: env.SIGN_STORE,
    certificateAuthority: () => certificateAuthority(env),
    sendEmail: env.EMAIL
      ? async ({ to, subject, text }) => {
          await env.EMAIL.send({ from: { name: 'RealPDF', email: env.SIGNING_EMAIL_FROM }, to, subject, text })
        }
      : null,
    allow: async (bucket, key) => {
      const limiter = bucket === 'email' ? env.EMAIL_LIMIT : env.WRITE_LIMIT
      if (!limiter) return true
      return (await limiter.limit({ key })).success
    },
  }
}

function logEvent(event: string, fields: Record<string, string | number | boolean | undefined>) {
  console.log(JSON.stringify({ event, ...fields }))
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url)
    const host = (request.headers.get('host') ?? url.hostname).split(':')[0].toLowerCase()
    const startedAt = performance.now()
    const base = {
      method: request.method,
      host,
      path: url.pathname,
      colo: request.cf?.colo as string | undefined,
      country: request.cf?.country as string | undefined,
    }

    return tracing.enterSpan('realpdf:request', async (span) => {
      span.setAttribute('http.request.method', request.method)
      span.setAttribute('server.address', host)
      span.setAttribute('url.path', url.pathname)
      if (base.country) span.setAttribute('client.address.country', base.country)

      // Keep https://realpdf.app as the canonical origin.
      if (host === 'www.realpdf.app') {
        const location = `https://realpdf.app${url.pathname}${url.search}`
        span.setAttribute('http.response.status_code', 301)
        span.setAttribute('url.redirect.target', location)
        logEvent('redirect', { ...base, status: 301, location })
        return new Response(null, { status: 301, headers: { Location: location } })
      }

      if (url.pathname === MCP_PATH) {
        const response = await handleMcp(request, apiDeps(env))
        span.setAttribute('http.response.status_code', response.status)
        logEvent('mcp', { ...base, status: response.status, durationMs: Math.round(performance.now() - startedAt) })
        return response
      }

      try {
        const response = url.pathname.startsWith('/api/')
          ? applyAssetHeaders(await handleApi(request, apiDeps(env)), url.pathname)
          : applyAssetHeaders(await env.ASSETS.fetch(request), url.pathname)
        const durationMs = Math.round(performance.now() - startedAt)
        const contentLength = response.headers.get('content-length')

        span.setAttribute('http.response.status_code', response.status)
        span.setAttribute('http.response.duration_ms', durationMs)
        if (contentLength) span.setAttribute('http.response.body.size', Number(contentLength))

        logEvent('request', {
          ...base,
          status: response.status,
          durationMs,
          bytes: Number(response.headers.get('content-length') ?? 0),
        })
        return response
      } catch (error) {
        const durationMs = Math.round(performance.now() - startedAt)
        span.setAttribute('http.response.status_code', 500)
        logEvent('request_error', {
          ...base,
          durationMs,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
        return new Response('Internal Server Error', {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }
    })
  },

  async scheduled(_controller: ScheduledController, env: WorkerEnv): Promise<void> {
    const requests = await purgeExpiredSignRequests(env.SIGN_STORE)
    const challenges = await purgeExpiredChallenges(env.SIGN_STORE)
    logEvent('purge', { requests, challenges })
  },
}
