import type { CertificateAuthority } from '../certificateAuthority.ts'
import type { BlobStore } from '../store.ts'

/**
 * What the MCP tools need from the Worker. It is a subset of the /api/ deps
 * (worker/api.ts), so the Worker passes the same object to both.
 */
export interface McpDeps {
  store: BlobStore
  /** Null when the CA secrets are not configured. */
  certificateAuthority: () => Promise<CertificateAuthority | null>
  /** Resolves false when the caller is over a rate limit. */
  allow?: (bucket: 'write' | 'email', key: string) => Promise<boolean>
  now?: () => number
}

export interface McpContext {
  deps: McpDeps
  /** Origin links are built on, e.g. https://realpdf.app. */
  origin: string
  /** Rate-limit key for the caller (its IP address). */
  clientKey: string
}

/** RealPDF's own CA, which verify_pdf trusts: its certificates carry an email RealPDF verified. */
export async function trustAnchors(context: McpContext): Promise<Uint8Array<ArrayBuffer>[]> {
  const ca = await context.deps.certificateAuthority().catch(() => null)
  return ca ? [ca.certificate.der] : []
}
