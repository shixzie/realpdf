import { tracing } from 'cloudflare:workers'

// These mirror public/_headers. With assets.run_worker_first enabled the
// assets layer no longer applies _headers to responses, so the Worker does.
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
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

function logEvent(event: string, fields: Record<string, string | number | boolean | undefined>) {
  console.log(JSON.stringify({ event, ...fields }))
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

      try {
        const assetResponse = await env.ASSETS.fetch(request)
        const response = applyAssetHeaders(assetResponse, url.pathname)
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
}
