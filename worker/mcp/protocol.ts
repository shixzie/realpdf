/**
 * A stateless MCP server over Streamable HTTP (JSON responses, no SSE):
 * clients POST JSON-RPC messages to /mcp and get the result in the response
 * body. No session is kept between requests, so any Worker instance can serve
 * any call. See https://modelcontextprotocol.io/specification.
 */

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const
const LATEST = PROTOCOL_VERSIONS[0]

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: unknown } }

export const ErrorCode = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

export class RpcError extends Error {
  readonly code: number
  readonly data?: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

/** A tool failure the agent should see and can act on (reported with isError, not as a protocol error). */
export class ToolError extends Error {}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } }

export interface ToolResult {
  content: ContentBlock[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface Tool<Context> {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: ToolAnnotations
  run: (args: Record<string, unknown>, context: Context) => Promise<ToolResult>
}

export interface ServerInfo {
  name: string
  title: string
  version: string
  instructions: string
}

function response(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function failure(id: JsonRpcRequest['id'], error: RpcError): JsonRpcResponse {
  const body: { code: number; message: string; data?: unknown } = { code: error.code, message: error.message }
  if (error.data !== undefined) body.data = error.data
  return { jsonrpc: '2.0', id: id ?? null, error: body }
}

function isRequest(message: unknown): message is JsonRpcRequest {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as JsonRpcRequest).jsonrpc === '2.0' &&
    typeof (message as JsonRpcRequest).method === 'string'
  )
}

export function negotiateVersion(requested: unknown): string {
  return typeof requested === 'string' && (PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST
}

/**
 * Dispatches one JSON-RPC message. Returns null for notifications (no id),
 * which get no response.
 */
export async function dispatch<Context>(
  message: unknown,
  server: ServerInfo,
  tools: Tool<Context>[],
  context: Context,
): Promise<JsonRpcResponse | null> {
  if (!isRequest(message)) {
    // Responses from the client (we never send requests) and malformed input.
    const id = (message as { id?: JsonRpcRequest['id'] } | null)?.id
    if (message && typeof message === 'object' && ('result' in message || 'error' in message)) return null
    return failure(id ?? null, new RpcError(ErrorCode.invalidRequest, 'Invalid JSON-RPC request'))
  }
  const { id, method, params = {} } = message
  const notification = id === undefined
  try {
    const result = await handle(method, params, server, tools, context)
    return notification ? null : response(id, result)
  } catch (error) {
    if (notification) return null
    if (error instanceof RpcError) return failure(id, error)
    return failure(id, new RpcError(ErrorCode.internal, 'Internal error'))
  }
}

async function handle<Context>(
  method: string,
  params: Record<string, unknown>,
  server: ServerInfo,
  tools: Tool<Context>[],
  context: Context,
): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: negotiateVersion(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, title: server.title, version: server.version },
        instructions: server.instructions,
      }
    case 'ping':
      return {}
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return {}
    case 'tools/list':
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
      }
    case 'tools/call': {
      const name = params.name
      const tool = tools.find((candidate) => candidate.name === name)
      if (!tool) throw new RpcError(ErrorCode.invalidParams, `Unknown tool: ${String(name)}`)
      const args = params.arguments ?? {}
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new RpcError(ErrorCode.invalidParams, 'Tool arguments must be an object')
      }
      try {
        return await tool.run(args as Record<string, unknown>, context)
      } catch (error) {
        if (error instanceof ToolError) return { content: [{ type: 'text', text: error.message }], isError: true }
        throw error
      }
    }
    default:
      throw new RpcError(ErrorCode.methodNotFound, `Method not found: ${method}`)
  }
}
