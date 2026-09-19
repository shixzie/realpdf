import { inflateRaw } from 'pako'

export type ZipArchive = Map<string, Uint8Array>

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50

/**
 * Reads a ZIP archive into memory. Office documents are ZIP packages, so this
 * is the entry point for .docx/.xlsx/.pptx parsing. Supports STORE and DEFLATE
 * entries, which is everything those formats use.
 */
export function readZip(bytes: Uint8Array): ZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  const entries: ZipArchive = new Map()

  let end = -1
  const oldest = Math.max(0, bytes.length - 22 - 0xffff)
  for (let offset = bytes.length - 22; offset >= oldest; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      end = offset
      break
    }
  }
  if (end < 0) throw new Error('Not a ZIP archive')

  const count = view.getUint16(end + 10, true)
  let cursor = view.getUint32(end + 16, true)

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) break
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = bytes.subarray(dataStart, dataStart + compressedSize)

    if (!name.endsWith('/')) {
      const data =
        method === 0
          ? raw.slice()
          : method === 8
            ? inflateRaw(raw)
            : (() => {
                throw new Error(`Unsupported ZIP compression method ${method}`)
              })()
      entries.set(name.replace(/^\/+/, ''), data)
    }

    cursor += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

export function zipText(entries: ZipArchive, path: string): string | undefined {
  const data = entries.get(path)
  return data ? new TextDecoder().decode(data) : undefined
}
