/**
 * The MCP endpoint (worker/mcp) exercised through its fetch handler, the way
 * an MCP client talks to https://realpdf.app/mcp: JSON-RPC over POST.
 */
import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { handleMcp } from '../../worker/mcp/index.ts'
import { loadSigningIdentity } from '../../src/lib/signing/identity.ts'
import { signPdf } from '../../src/lib/signing/pdfSign.ts'
import { makeRsaPkcs12 } from '../helpers/signing.mjs'
import { memoryStore } from '../../worker/store.ts'

const deps = { store: memoryStore(), certificateAuthority: async () => null }
const ENDPOINT = 'https://realpdf.app/mcp'

async function post(body, headers = {}) {
  const response = await handleMcp(
    new Request(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    deps,
  )
  const text = await response.text()
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null }
}

let nextId = 1
async function call(method, params) {
  const { body } = await post({ jsonrpc: '2.0', id: nextId++, method, params })
  return body
}

async function signedPdf() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([595, 842]).drawText('Contract', { x: 72, y: 760, size: 18, font })
  const p12 = makeRsaPkcs12({ name: 'Ada Lovelace' })
  const identity = await loadSigningIdentity(p12.bytes, p12.password)
  return signPdf(await doc.save(), { identity, placement: { kind: 'invisible' }, reason: 'Approval' })
}

describe('MCP endpoint', () => {
  it('initializes and negotiates the protocol version', async () => {
    const reply = await call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    })
    expect(reply.result.protocolVersion).toBe('2025-06-18')
    expect(reply.result.serverInfo.name).toBe('realpdf')
    expect(reply.result.capabilities.tools).toBeDefined()
    expect(reply.result.instructions).toContain('verify_pdf')

    const unknown = await call('initialize', { protocolVersion: '1999-01-01', capabilities: {} })
    expect(unknown.result.protocolVersion).toBe('2025-11-25')
  })

  it('acknowledges notifications with 202 and no body', async () => {
    const { status, body } = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(status).toBe(202)
    expect(body).toBeNull()
  })

  it('lists the tools with input schemas', async () => {
    const reply = await call('tools/list', {})
    const verify = reply.result.tools.find((tool) => tool.name === 'verify_pdf')
    expect(verify.inputSchema.type).toBe('object')
    expect(Object.keys(verify.inputSchema.properties)).toEqual(['pdf_base64', 'pdf_url'])
    expect(verify.annotations.readOnlyHint).toBe(true)
  })

  it('verifies a signed PDF sent as base64', async () => {
    const pdf = await signedPdf()
    const reply = await call('tools/call', {
      name: 'verify_pdf',
      arguments: { pdf_base64: Buffer.from(pdf).toString('base64') },
    })
    expect(reply.result.isError).toBeUndefined()
    expect(reply.result.structuredContent.valid).toBe(true)
    expect(reply.result.structuredContent.signatures[0]).toMatchObject({ intact: true, reason: 'Approval' })
    expect(reply.result.structuredContent.signatures[0].signer.name).toBe('Ada Lovelace')
    expect(reply.result.content[0].text).toContain('signed by Ada Lovelace <ada@example.com>')
  })

  it('reports bad input as a tool error the agent can read', async () => {
    const missing = await call('tools/call', { name: 'verify_pdf', arguments: {} })
    expect(missing.result.isError).toBe(true)
    expect(missing.result.content[0].text).toContain('pdf_base64 or pdf_url')

    const notPdf = await call('tools/call', {
      name: 'verify_pdf',
      arguments: { pdf_base64: Buffer.from('hello').toString('base64') },
    })
    expect(notPdf.result.isError).toBe(true)
    expect(notPdf.result.content[0].text).toContain('not a PDF')

    const http = await call('tools/call', { name: 'verify_pdf', arguments: { pdf_url: 'http://example.com/a.pdf' } })
    expect(http.result.content[0].text).toContain('https')
  })

  it('returns JSON-RPC errors for unknown methods and tools', async () => {
    expect((await call('resources/list', {})).error.code).toBe(-32601)
    expect((await call('tools/call', { name: 'nope', arguments: {} })).error.code).toBe(-32602)
    const parse = await post('{not json')
    expect(parse.status).toBe(400)
    expect(parse.body.error.code).toBe(-32700)
  })

  it('answers batches and rejects unsupported protocol headers', async () => {
    const batch = await post([
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'b', method: 'ping' },
    ])
    expect(batch.body.map((reply) => reply.id)).toEqual(['a', 'b'])

    const version = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'Mcp-Protocol-Version': '1999-01-01' })
    expect(version.status).toBe(400)
  })

  it('offers no SSE stream and answers CORS preflights', async () => {
    const get = await handleMcp(new Request(ENDPOINT, { method: 'GET' }), deps)
    expect(get.status).toBe(405)
    const options = await handleMcp(new Request(ENDPOINT, { method: 'OPTIONS' }), deps)
    expect(options.status).toBe(204)
    expect(options.headers.get('Access-Control-Allow-Headers')).toContain('Mcp-Protocol-Version')
  })
})
