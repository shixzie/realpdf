/**
 * Unit coverage for the ZIP reader/writer used by the Office converters:
 * stored and deflated packages must round-trip byte for byte.
 */
import { describe, expect, it } from 'vitest'
import { createZip } from '../../src/lib/zip.ts'
import { readZip, zipText } from '../../src/lib/zipRead.ts'

describe('zip archive', () => {
  it('round-trips stored entries', async () => {
    const blob = await createZip([
      { name: 'a.txt', data: 'hello world' },
      { name: 'nested/b.bin', data: new Uint8Array([1, 2, 3, 4]) },
    ])
    const archive = readZip(new Uint8Array(await blob.arrayBuffer()))
    expect(zipText(archive, 'a.txt')).toBe('hello world')
    expect(Array.from(archive.get('nested/b.bin'))).toEqual([1, 2, 3, 4])
  })

  it('round-trips deflated entries', async () => {
    const text = `<w:document>${'office '.repeat(500)}</w:document>`
    const blob = await createZip([{ name: 'word/document.xml', data: text }], { compress: true })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const archive = readZip(bytes)
    expect(zipText(archive, 'word/document.xml')).toBe(text)
    expect(bytes.length).toBeLessThan(text.length)
  })

  it('rejects data that is not a ZIP archive', () => {
    expect(() => readZip(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow()
  })
})
