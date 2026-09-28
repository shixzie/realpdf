/**
 * The slice of the R2 API the signing services use. Production passes the R2
 * bucket binding; the Vite dev server and tests pass `memoryStore()`.
 */

export interface StoredObject {
  etag: string
  size: number
  customMetadata?: Record<string, string>
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}

export interface PutOptions {
  /** Write only if the current object still has this etag (optimistic locking). */
  onlyIf?: { etagMatches?: string }
  customMetadata?: Record<string, string>
}

export interface ListedObject {
  key: string
  customMetadata?: Record<string, string>
}

export interface BlobStore {
  get(key: string): Promise<StoredObject | null>
  /** Resolves to null when an `onlyIf` precondition failed. */
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: PutOptions): Promise<{ etag: string } | null>
  delete(keys: string | string[]): Promise<void>
  list(options: {
    prefix?: string
    cursor?: string
    include?: 'customMetadata'[]
  }): Promise<{ objects: ListedObject[]; truncated: boolean; cursor?: string }>
}

/** An in-process store with R2's semantics for the calls above. */
export function memoryStore(): BlobStore {
  const objects = new Map<string, { bytes: Uint8Array; etag: string; customMetadata?: Record<string, string> }>()
  let version = 0
  return {
    async get(key) {
      const entry = objects.get(key)
      if (!entry) return null
      const bytes = entry.bytes
      return {
        etag: entry.etag,
        size: bytes.length,
        customMetadata: entry.customMetadata,
        arrayBuffer: async () => bytes.slice().buffer,
        text: async () => new TextDecoder().decode(bytes),
      }
    },
    async put(key, value, options) {
      const current = objects.get(key)
      const expected = options?.onlyIf?.etagMatches
      if (expected !== undefined && current?.etag !== expected) return null
      const bytes =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof Uint8Array
            ? value.slice()
            : new Uint8Array(value.slice(0))
      version += 1
      const etag = `m${version}`
      objects.set(key, { bytes, etag, customMetadata: options?.customMetadata })
      return { etag }
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key)
    },
    async list({ prefix = '', cursor, include }) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort()
      const start = cursor ? Number(cursor) : 0
      const page = keys.slice(start, start + 1000)
      const truncated = start + page.length < keys.length
      return {
        objects: page.map((key) => ({
          key,
          customMetadata: include?.includes('customMetadata') ? objects.get(key)?.customMetadata : undefined,
        })),
        truncated,
        cursor: truncated ? String(start + page.length) : undefined,
      }
    },
  }
}
