/** Who is calling: anyone (no key), or the owner of a verified email via an agent key. */
export type Caller = { kind: 'anonymous' } | { kind: 'user'; email: string; keyId: string }

export interface McpContext {
  env: Env
  caller: Caller
  /** Origin links are built on, e.g. https://realpdf.app. */
  origin: string
  /** Certificates verify_pdf treats as trusted roots (RealPDF's own CA). */
  trustAnchors: Uint8Array<ArrayBuffer>[]
}
