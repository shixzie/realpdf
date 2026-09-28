/**
 * Signing requests, browser side. A request is a PDF someone sends to others
 * to sign. Every version is encrypted here with AES-256-GCM under a random key
 * that only exists in the share link's #fragment, which browsers never send
 * to the server. The server (worker/signRequests.ts) stores ciphertext.
 *
 * Link:      https://realpdf.app/sign/<id>#<key>
 * Version:   iv (12 bytes) || AES-GCM( u32 header length || header JSON || PDF )
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

export interface RequestStatus {
  id: string
  createdAt: number
  expiresAt: number
  versions: Array<{ index: number; uploadedAt: number; size: number }>
}

export interface OpenedRequest {
  id: string
  key: string
  header: RequestHeader
  bytes: Uint8Array<ArrayBuffer>
  status: RequestStatus
}

/** A request created on this device, kept so its sender can find it again. */
export interface MyRequest {
  id: string
  key: string
  ownerToken: string
  fileName: string
  createdAt: number
  expiresAt: number
}

export type RequestErrorCode = 'notFound' | 'expired' | 'badLink' | 'tooLarge' | 'rateLimited' | 'network' | 'unavailable'

export class RequestError extends Error {
  readonly code: RequestErrorCode
  constructor(code: RequestErrorCode) {
    super(code)
    this.code = code
  }
}

const STORAGE_KEY = 'realpdf-sign-requests'
const API = '/api/sign-requests'

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

export function requestLink(id: string, key: string): string {
  return `${window.location.origin}/sign/${id}#${key}`
}

/** Reads `/sign/<id>#<key>` from the current address. */
export function parseRequestLocation(location: Location = window.location): { id: string; key: string } | null {
  const match = /^\/sign\/([A-Za-z0-9_-]{16,64})\/?$/.exec(location.pathname)
  const key = location.hash.replace(/^#/, '')
  if (!match || !/^[A-Za-z0-9_-]{43}$/.test(key)) return null
  return { id: match[1], key }
}

function importKey(key: string): Promise<CryptoKey> {
  const raw = fromBase64Url(key)
  if (raw.length !== 32) throw new RequestError('badLink')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** Proves knowledge of the key to the server without revealing it. */
async function writeToken(key: string): Promise<string> {
  const label = new TextEncoder().encode('realpdf-sign-request-write:')
  const raw = fromBase64Url(key)
  const joined = new Uint8Array(label.length + raw.length)
  joined.set(label)
  joined.set(raw, label.length)
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', joined)))
}

async function seal(key: string, header: RequestHeader, pdf: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
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

async function open(key: string, sealed: Uint8Array<ArrayBuffer>): Promise<{ header: RequestHeader; bytes: Uint8Array<ArrayBuffer> }> {
  let plain: Uint8Array
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12) }, await importKey(key), sealed.subarray(12)),
    )
  } catch {
    throw new RequestError('badLink')
  }
  const length = new DataView(plain.buffer, plain.byteOffset).getUint32(0)
  const header = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + length))) as RequestHeader
  return { header, bytes: plain.slice(4 + length) }
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch {
    throw new RequestError('network')
  }
  if (response.ok) return response
  const code = ((await response.json().catch(() => null)) as { error?: string } | null)?.error
  if (response.status === 404 || code === 'notFound' || code === 'invalidId') throw new RequestError('notFound')
  if (response.status === 410) throw new RequestError('expired')
  if (response.status === 413) throw new RequestError('tooLarge')
  if (response.status === 429) throw new RequestError('rateLimited')
  throw new RequestError(response.status >= 500 ? 'unavailable' : 'network')
}

export function listMyRequests(): MyRequest[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as MyRequest[]
    return parsed.filter((entry) => entry.expiresAt > Date.now()).sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

function saveMyRequests(entries: MyRequest[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Without storage the sender still has the link they copied.
  }
}

export function isMyRequest(id: string): boolean {
  return listMyRequests().some((entry) => entry.id === id)
}

export async function createRequest(args: {
  bytes: Uint8Array
  fileName: string
  from: string
  message: string
}): Promise<MyRequest & { link: string }> {
  const key = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  const ownerToken = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  const header: RequestHeader = { v: 1, fileName: args.fileName, from: args.from, message: args.message, signers: [] }
  const body = await seal(key, header, args.bytes)
  const response = await call(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Write-Token': await writeToken(key), 'X-Owner-Token': ownerToken },
    body,
  })
  const status = (await response.json()) as RequestStatus
  const entry: MyRequest = {
    id: status.id,
    key,
    ownerToken,
    fileName: args.fileName,
    createdAt: status.createdAt,
    expiresAt: status.expiresAt,
  }
  saveMyRequests([entry, ...listMyRequests().filter((other) => other.id !== entry.id)])
  return { ...entry, link: requestLink(entry.id, key) }
}

export async function fetchRequestStatus(id: string): Promise<RequestStatus> {
  return (await (await call(`${API}/${id}`)).json()) as RequestStatus
}

/** Downloads and decrypts the newest version. */
export async function openRequest(id: string, key: string): Promise<OpenedRequest> {
  await importKey(key)
  const [status, sealed] = await Promise.all([
    fetchRequestStatus(id),
    call(`${API}/${id}/versions/latest`).then(async (response) => new Uint8Array(await response.arrayBuffer())),
  ])
  const { header, bytes } = await open(key, sealed)
  return { id, key, header, bytes, status }
}

/** Uploads a signed copy as the newest version. */
export async function addSignedVersion(
  request: { id: string; key: string; header: RequestHeader },
  bytes: Uint8Array,
  signer: string,
): Promise<{ header: RequestHeader; status: RequestStatus }> {
  const header: RequestHeader = { ...request.header, signers: [...request.header.signers, signer] }
  const response = await call(`${API}/${request.id}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Write-Token': await writeToken(request.key) },
    body: await seal(request.key, header, bytes),
  })
  return { header, status: (await response.json()) as RequestStatus }
}

/** Deletes a request this device created, on the server and in the local list. */
export async function deleteMyRequest(id: string): Promise<void> {
  const entry = listMyRequests().find((other) => other.id === id)
  if (entry) {
    try {
      await call(`${API}/${id}`, { method: 'DELETE', headers: { 'X-Owner-Token': entry.ownerToken } })
    } catch (error) {
      if (!(error instanceof RequestError && (error.code === 'notFound' || error.code === 'expired'))) throw error
    }
  }
  saveMyRequests(listMyRequests().filter((other) => other.id !== id))
}
