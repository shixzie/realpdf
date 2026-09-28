import type { CertificateInfo, SigningIdentity } from './identity'

/**
 * Signing identities remembered in this browser. The private key is stored as
 * the WebCrypto CryptoKey itself, which IndexedDB keeps as non-extractable:
 * the browser can sign with it, but no script (ours included) can read the
 * key material back. Nothing here ever leaves the device.
 */

const DB_NAME = 'realpdf-signing'
const DB_VERSION = 1
const STORE = 'identities'

export interface SavedIdentity extends SigningIdentity {
  id: string
  savedAt: number
}

export type SavedIdentityMeta = { id: string; savedAt: number; info: CertificateInfo }

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('This browser does not support local storage (IndexedDB)'))
        return
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => {
        dbPromise = null
        reject(request.error ?? new Error('Could not open local storage'))
      }
    })
  }
  return dbPromise
}

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode)
        const request = run(transaction.objectStore(STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Local storage error'))
      }),
  )
}

/** Hex SHA-256 of the certificate, so saving the same certificate twice replaces it. */
async function fingerprint(certificate: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', certificate))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function rememberIdentity(identity: SigningIdentity): Promise<SavedIdentityMeta> {
  if (identity.key.extractable) throw new Error('Only non-extractable keys can be remembered')
  const entry: SavedIdentity = { ...identity, id: await fingerprint(identity.certificate), savedAt: Date.now() }
  await withStore('readwrite', (store) => store.put(entry))
  return { id: entry.id, savedAt: entry.savedAt, info: entry.info }
}

export async function listSavedIdentities(): Promise<SavedIdentityMeta[]> {
  try {
    const all = await withStore<SavedIdentity[]>('readonly', (store) => store.getAll())
    return all.map(({ id, savedAt, info }) => ({ id, savedAt, info })).sort((a, b) => b.savedAt - a.savedAt)
  } catch {
    return []
  }
}

export async function getSavedIdentity(id: string): Promise<SigningIdentity | null> {
  const entry = await withStore<SavedIdentity | undefined>('readonly', (store) => store.get(id))
  if (!entry) return null
  const { id: _id, savedAt: _savedAt, ...identity } = entry
  return identity
}

export async function forgetIdentity(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id))
}
