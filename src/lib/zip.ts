import { deflateRaw } from 'pako'

export interface ZipEntry {
  name: string
  data: Uint8Array | Blob | string
}

export interface ZipOptions {
  /** DEFLATE entries when that is smaller; STORE otherwise. */
  compress?: boolean
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: day }
}

async function toBytes(data: ZipEntry['data']): Promise<Uint8Array> {
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  return data
}

/**
 * Builds a ZIP archive using STORE by default (PDFs and PNGs/JPEGs are already
 * compressed, so this is fast and dependency-free) or DEFLATE when `compress`
 * is set, which is what Office packages expect.
 */
export async function createZip(entries: ZipEntry[], options: ZipOptions = {}): Promise<Blob> {
  const encoder = new TextEncoder()
  const { time, date } = dosDateTime(new Date())
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const data = await toBytes(entry.data)
    const crc = crc32(data)
    let method = 0
    let payload = data
    if (options.compress && data.length > 0) {
      const compressed = deflateRaw(data)
      if (compressed.length < data.length) {
        method = 8
        payload = compressed
      }
    }

    const local = new Uint8Array(30 + nameBytes.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0x0800, true)
    localView.setUint16(8, method, true)
    localView.setUint16(10, time, true)
    localView.setUint16(12, date, true)
    localView.setUint32(14, crc, true)
    localView.setUint32(18, payload.length, true)
    localView.setUint32(22, data.length, true)
    localView.setUint16(26, nameBytes.length, true)
    localView.setUint16(28, 0, true)
    local.set(nameBytes, 30)

    parts.push(local, payload)

    const directory = new Uint8Array(46 + nameBytes.length)
    const dirView = new DataView(directory.buffer)
    dirView.setUint32(0, 0x02014b50, true)
    dirView.setUint16(4, 20, true)
    dirView.setUint16(6, 20, true)
    dirView.setUint16(8, 0x0800, true)
    dirView.setUint16(10, method, true)
    dirView.setUint16(12, time, true)
    dirView.setUint16(14, date, true)
    dirView.setUint32(16, crc, true)
    dirView.setUint32(20, payload.length, true)
    dirView.setUint32(24, data.length, true)
    dirView.setUint16(28, nameBytes.length, true)
    dirView.setUint16(30, 0, true)
    dirView.setUint16(32, 0, true)
    dirView.setUint16(34, 0, true)
    dirView.setUint16(36, 0, true)
    dirView.setUint32(38, 0, true)
    dirView.setUint32(42, offset, true)
    directory.set(nameBytes, 46)
    central.push(directory)

    offset += local.length + payload.length
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(4, 0, true)
  endView.setUint16(6, 0, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)
  endView.setUint16(20, 0, true)

  const blobParts = [...parts, ...central, end].map((part) => part as unknown as BlobPart)
  return new Blob(blobParts, { type: 'application/zip' })
}
