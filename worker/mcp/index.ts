import type { Caller, McpContext } from './context'
import { dispatch, ErrorCode, PROTOCOL_VERSIONS, RpcError, type ServerInfo, type Tool } from './protocol'
import { verifyPdfTool } from './tools/verify'

export const MCP_PATH = '/mcp'

const SERVER: ServerInfo = {
  name: 'realpdf',
  title: 'RealPDF',
  version: '1.0.0',
  instructions:
    'RealPDF signs PDFs with PAdES digital signatures. Use verify_pdf to check the signatures in any PDF. ' +
    'Signing always happens in the signer\'s own browser with their own key, so an agent cannot sign on ' +
    'someone\'s behalf: it can check documents and see which signature fields still need signing.',
}

const TOOLS: Tool<McpContext>[] = [verifyPdfTool]

/** Largest request body accepted (a 25 MB PDF is ~34 MB as base64). */
const MAX_BODY_BYTES = 40 * 1024 * 1024

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
  'Access-Control-Max-Age': '86400',
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS_HEADERS, ...extra },
  })
}

function rpcError(status: number, code: number, message: string): Response {
  return json({ jsonrpc: '2.0', id: null, error: { code, message } }, status)
}

async function authenticate(request: Request): Promise<Caller | Response> {
  const header = request.headers.get('Authorization')
  if (!header) return { kind: 'anonymous' }
  return rpcError(401, ErrorCode.invalidRequest, 'Agent keys are not enabled on this server yet; call without Authorization.')
}

/** Handles every request to /mcp (Streamable HTTP transport, JSON responses only). */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
  if (request.method === 'GET' || request.method === 'DELETE') {
    // Stateless server: no server-initiated SSE stream and no sessions to end.
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, OPTIONS', ...CORS_HEADERS } })
  }
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } })

  const version = request.headers.get('Mcp-Protocol-Version')
  if (version && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return rpcError(400, ErrorCode.invalidRequest, `Unsupported MCP protocol version: ${version}`)
  }
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY_BYTES) {
    return rpcError(413, ErrorCode.invalidRequest, 'Request body too large')
  }

  let body: unknown
  try {
    body = JSON.parse(await request.text())
  } catch {
    return rpcError(400, ErrorCode.parse, 'Parse error')
  }

  const caller = await authenticate(request)
  if (caller instanceof Response) return caller
  const context: McpContext = { env, caller, origin: new URL(request.url).origin, trustAnchors: [] }

  const messages = Array.isArray(body) ? body : [body]
  if (!messages.length) return rpcError(400, ErrorCode.invalidRequest, 'Empty batch')
  const responses = []
  for (const message of messages) {
    try {
      const reply = await dispatch(message, SERVER, TOOLS, context)
      if (reply) responses.push(reply)
    } catch (error) {
      const id = (message as { id?: string | number | null })?.id ?? null
      const failure = error instanceof RpcError ? error : new RpcError(ErrorCode.internal, 'Internal error')
      responses.push({ jsonrpc: '2.0', id, error: { code: failure.code, message: failure.message } })
    }
  }
  // Only notifications and client responses: acknowledge with no body.
  if (!responses.length) return new Response(null, { status: 202, headers: CORS_HEADERS })
  return json(Array.isArray(body) ? responses : responses[0])
}
