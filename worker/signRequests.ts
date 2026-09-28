import type { BlobStore } from './store.ts'
import { randomId, sha256Hex, timingSafeEqual } from './encoding.ts'

/**
 * Signing requests: a document someone sends to others to sign. The browser
 * encrypts every version with a key that only travels in the link's #fragment,
 * so this service stores and serves opaque ciphertext. It never sees the key,
 * the PDF, the file name or who is asked to sign.
 *
 * Anyone holding the link may add a version (a signed copy); proving that
 * takes a write token the browser derives from the key, which the service
 * only knows by its hash. The creator also keeps an owner token that can
 * delete the request early. Requests expire after REQUEST_LIFETIME_MS and a
 * daily cron removes them.
 */

export const REQUEST_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_VERSION_BYTES = 40 * 1024 * 1024
export const MAX_VERSIONS = 20

const PREFIX = 'requests/'
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/

interface StoredVersion {
  key: string
  uploadedAt: number
  size: number
}

interface StoredRequest {
  createdAt: number
  expiresAt: number
  writeHash: string
  ownerHash: string
  versions: StoredVersion[]
}

export interface SignRequestStatus {
  id: string
  createdAt: number
  expiresAt: number
  /** Version 0 is the document as sent; each later one is a signed copy. */
  versions: Array<{ index: number; uploadedAt: number; size: number }>
}

export type SignRequestErrorCode =
  | 'invalidId'
  | 'invalidToken'
  | 'notFound'
  | 'expired'
  | 'forbidden'
  | 'empty'
  | 'tooLarge'
  | 'tooManyVersions'
  | 'conflict'

const STATUS: Record<SignRequestErrorCode, number> = {
  invalidId: 400,
  invalidToken: 400,
  notFound: 404,
  expired: 410,
  forbidden: 403,
  empty: 400,
  tooLarge: 413,
  tooManyVersions: 409,
  conflict: 409,
}

export class SignRequestError extends Error {
  readonly code: SignRequestErrorCode
  readonly status: number
  constructor(code: SignRequestErrorCode) {
    super(code)
    this.code = code
    this.status = STATUS[code]
  }
}

const metaKey = (id: string) => `${PREFIX}${id}/meta`

function checkId(id: string) {
  if (!ID_PATTERN.test(id)) throw new SignRequestError('invalidId')
}

function checkToken(token: string | null | undefined): string {
  if (!token || !TOKEN_PATTERN.test(token)) throw new SignRequestError('invalidToken')
  return token
}

function checkBody(ciphertext: Uint8Array) {
  if (ciphertext.length === 0) throw new SignRequestError('empty')
  if (ciphertext.length > MAX_VERSION_BYTES) throw new SignRequestError('tooLarge')
}

const hashToken = (token: string) => sha256Hex(`realpdf-sign-request:${token}`)

function publicStatus(id: string, meta: StoredRequest): SignRequestStatus {
  return {
    id,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
    versions: meta.versions.map((version, index) => ({ index, uploadedAt: version.uploadedAt, size: version.size })),
  }
}

async function readMeta(store: BlobStore, id: string, now: number): Promise<{ meta: StoredRequest; etag: string }> {
  checkId(id)
  const object = await store.get(metaKey(id))
  if (!object) throw new SignRequestError('notFound')
  const meta = JSON.parse(await object.text()) as StoredRequest
  if (meta.expiresAt <= now) throw new SignRequestError('expired')
  return { meta, etag: object.etag }
}

function metaOptions(meta: StoredRequest) {
  return { customMetadata: { expiresAt: String(meta.expiresAt) } }
}

export async function createSignRequest(
  store: BlobStore,
  args: { ciphertext: Uint8Array; writeToken: string; ownerToken: string; now?: number },
): Promise<SignRequestStatus> {
  checkBody(args.ciphertext)
  const writeHash = await hashToken(checkToken(args.writeToken))
  const ownerHash = await hashToken(checkToken(args.ownerToken))
  const now = args.now ?? Date.now()
  const id = randomId(16)
  const blobKey = `${PREFIX}${id}/${randomId(12)}`
  const meta: StoredRequest = {
    createdAt: now,
    expiresAt: now + REQUEST_LIFETIME_MS,
    writeHash,
    ownerHash,
    versions: [{ key: blobKey, uploadedAt: now, size: args.ciphertext.length }],
  }
  await store.put(blobKey, args.ciphertext, metaOptions(meta))
  await store.put(metaKey(id), JSON.stringify(meta), metaOptions(meta))
  return publicStatus(id, meta)
}

export async function getSignRequest(store: BlobStore, id: string, now = Date.now()): Promise<SignRequestStatus> {
  const { meta } = await readMeta(store, id, now)
  return publicStatus(id, meta)
}

/** The encrypted bytes of one version; `latest` picks the newest. */
export async function readSignRequestVersion(
  store: BlobStore,
  id: string,
  index: number | 'latest',
  now = Date.now(),
): Promise<Uint8Array<ArrayBuffer>> {
  const { meta } = await readMeta(store, id, now)
  const version = meta.versions[index === 'latest' ? meta.versions.length - 1 : index]
  if (!version) throw new SignRequestError('notFound')
  const object = await store.get(version.key)
  if (!object) throw new SignRequestError('notFound')
  return new Uint8Array(await object.arrayBuffer())
}

/** Adds a signed copy. Concurrent uploads each land as their own version. */
export async function addSignRequestVersion(
  store: BlobStore,
  id: string,
  args: { ciphertext: Uint8Array; writeToken: string; now?: number },
): Promise<SignRequestStatus> {
  checkBody(args.ciphertext)
  const now = args.now ?? Date.now()
  const tokenHash = await hashToken(checkToken(args.writeToken))
  let { meta, etag } = await readMeta(store, id, now)
  if (!timingSafeEqual(tokenHash, meta.writeHash)) throw new SignRequestError('forbidden')
  if (meta.versions.length >= MAX_VERSIONS) throw new SignRequestError('tooManyVersions')

  const blobKey = `${PREFIX}${id}/${randomId(12)}`
  await store.put(blobKey, args.ciphertext, metaOptions(meta))
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const next: StoredRequest = {
      ...meta,
      versions: [...meta.versions, { key: blobKey, uploadedAt: now, size: args.ciphertext.length }],
    }
    const written = await store.put(metaKey(id), JSON.stringify(next), { ...metaOptions(next), onlyIf: { etagMatches: etag } })
    if (written) return publicStatus(id, next)
    ;({ meta, etag } = await readMeta(store, id, now))
    if (meta.versions.length >= MAX_VERSIONS) break
  }
  await store.delete(blobKey)
  throw new SignRequestError(meta.versions.length >= MAX_VERSIONS ? 'tooManyVersions' : 'conflict')
}

async function deletePrefix(store: BlobStore, prefix: string): Promise<void> {
  let cursor: string | undefined
  do {
    const page = await store.list({ prefix, cursor })
    if (page.objects.length) await store.delete(page.objects.map((object) => object.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
}

export async function deleteSignRequest(store: BlobStore, id: string, ownerToken: string): Promise<void> {
  checkId(id)
  const tokenHash = await hashToken(checkToken(ownerToken))
  const object = await store.get(metaKey(id))
  if (!object) throw new SignRequestError('notFound')
  const meta = JSON.parse(await object.text()) as StoredRequest
  if (!timingSafeEqual(tokenHash, meta.ownerHash)) throw new SignRequestError('forbidden')
  await store.delete(metaKey(id))
  await deletePrefix(store, `${PREFIX}${id}/`)
}

/** Removes every expired request. Run from the Worker's daily cron. */
export async function purgeExpiredSignRequests(store: BlobStore, now = Date.now()): Promise<number> {
  const expired = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await store.list({ prefix: PREFIX, cursor, include: ['customMetadata'] })
    for (const object of page.objects) {
      const expiresAt = Number(object.customMetadata?.expiresAt)
      if (Number.isFinite(expiresAt) && expiresAt <= now) expired.add(object.key.slice(PREFIX.length).split('/')[0])
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  for (const id of expired) await deletePrefix(store, `${PREFIX}${id}/`)
  return expired.size
}
