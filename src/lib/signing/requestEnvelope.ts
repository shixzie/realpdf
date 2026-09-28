/**
 * The encrypted envelope of a signing request, shared by the browser
 * (src/lib/signRequests.ts) and the Worker's MCP tools. Only WebCrypto is
 * used, so it runs in both. The key never reaches the server: it lives in
 * the link's #fragment, and the server only sees a write token derived from it.
 *
 * Link:      <origin>/sign/<id>#<key>          key = base64url of 32 random bytes
 * Version:   iv (12 bytes) || AES-256-GCM( u32 header length || header JSON || PDF )
 */

export interface RequestHeader {
  v: 1
  fileName: string
  /** Who asked for the signatures, as they typed it. */
  from: string
  message: string
  /** Names of the people who signed, oldest first. */
  signers: string[]
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

export class EnvelopeError extends Error {
  readonly code = 'badLink'
  constructor() {
    super('badLink')
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

/** A new random request key, as it appears in the link fragment. */
export function generateRequestKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

export function isRequestKey(key: string): boolean {
  return KEY_PATTERN.test(key)
}

function importKey(key: string): Promise<CryptoKey> {
  if (!isRequestKey(key)) throw new EnvelopeError()
  return crypto.subtle.importKey('raw', fromBase64Url(key), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** Proves knowledge of the key to the server without revealing it. */
export async function deriveWriteToken(key: string): Promise<string> {
  const label = new TextEncoder().encode('realpdf-sign-request-write:')
  const raw = fromBase64Url(key)
  const joined = new Uint8Array(label.length + raw.length)
  joined.set(label)
  joined.set(raw, label.length)
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', joined)))
}

export async function sealVersion(key: string, header: RequestHeader, pdf: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  const plain = new Uint8Array(4 + headerBytes.length + pdf.length)
  new DataView(plain.buffer).setUint32(0, headerBytes.length)
  plain.set(headerBytes, 4)
  plain.set(pdf, 4 + headerBytes.length)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(key), plain))
  const out = new Uint8Array(iv.length + cipher.length)
  out.set(iv)
  out.set(cipher, iv.length)
  return out
}

export async function openVersion(
  key: string,
  sealed: Uint8Array<ArrayBuffer>,
): Promise<{ header: RequestHeader; bytes: Uint8Array<ArrayBuffer> }> {
  let plain: Uint8Array
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12) }, await importKey(key), sealed.subarray(12)),
    )
  } catch {
    throw new EnvelopeError()
  }
  const length = new DataView(plain.buffer, plain.byteOffset).getUint32(0)
  const header = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + length))) as RequestHeader
  return { header, bytes: plain.slice(4 + length) }
}

export function requestLink(origin: string, id: string, key: string): string {
  return `${origin}/sign/${id}#${key}`
}

/** Reads `/sign/<id>#<key>` from a link or a URL's path and fragment. */
export function parseRequestLink(link: string | { pathname: string; hash: string }): { id: string; key: string } | null {
  let pathname: string
  let hash: string
  if (typeof link === 'string') {
    try {
      ;({ pathname, hash } = new URL(link, 'https://realpdf.app'))
    } catch {
      return null
    }
  } else {
    ;({ pathname, hash } = link)
  }
  const match = /^\/sign\/([A-Za-z0-9_-]+)\/?$/.exec(pathname)
  const key = hash.replace(/^#/, '')
  if (!match || !ID_PATTERN.test(match[1]) || !isRequestKey(key)) return null
  return { id: match[1], key }
}
