import { zipText, type ZipArchive } from './zipRead'

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  ss: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
} as const

export const EMU_PER_POINT = 12700
export const TWIPS_PER_POINT = 20

export function parseXml(text: string): Document {
  const document = new DOMParser().parseFromString(text, 'application/xml')
  if (document.getElementsByTagName('parsererror').length > 0) {
    throw new Error('The Office file contains invalid XML')
  }
  return document
}

export function descendants(root: Element | Document, namespace: string, local: string): Element[] {
  return Array.from(root.getElementsByTagNameNS(namespace, local))
}

export function first(
  root: Element | Document | null | undefined,
  namespace: string,
  local: string,
): Element | null {
  if (!root) return null
  return root.getElementsByTagNameNS(namespace, local)[0] ?? null
}

export function childrenOf(parent: Element, namespace: string, local: string): Element[] {
  return Array.from(parent.children).filter(
    (child) => child.namespaceURI === namespace && child.localName === local,
  )
}

export function attributeNS(node: Element, namespace: string, local: string): string | null {
  return node.getAttributeNS(namespace, local)
}

export function unitToPt(value: string | null | undefined, unitsPerPoint: number): number | null {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number / unitsPerPoint : null
}

export function hexToRgb(hex: string | null | undefined): { r: number; g: number; b: number } | null {
  if (!hex || hex === 'auto') return null
  let value = hex.replace(/^#/, '')
  if (value.length === 8) value = value.slice(2)
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null
  return {
    r: parseInt(value.slice(0, 2), 16) / 255,
    g: parseInt(value.slice(2, 4), 16) / 255,
    b: parseInt(value.slice(4, 6), 16) / 255,
  }
}

export interface Relationship {
  id: string
  type: string
  target: string
}

export function resolvePartPath(basePart: string, target: string): string {
  const clean = target.split('#')[0]
  if (!clean) return basePart
  if (clean.startsWith('/')) return normalizePartPath(clean.slice(1))
  const slash = basePart.lastIndexOf('/')
  const baseDir = slash >= 0 ? basePart.slice(0, slash) : ''
  return normalizePartPath(baseDir ? `${baseDir}/${clean}` : clean)
}

function normalizePartPath(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

export function relsPathFor(part: string): string {
  if (!part) return '_rels/.rels'
  const slash = part.lastIndexOf('/')
  const dir = slash >= 0 ? part.slice(0, slash) : ''
  const name = slash >= 0 ? part.slice(slash + 1) : part
  return dir ? `${dir}/_rels/${name}.rels` : `_rels/${name}.rels`
}

export function readRels(entries: ZipArchive, part: string): Map<string, Relationship> {
  const text = zipText(entries, relsPathFor(part))
  const map = new Map<string, Relationship>()
  if (!text) return map
  const document = parseXml(text)
  for (const node of descendants(document, NS.rel, 'Relationship')) {
    const id = node.getAttribute('Id')
    const type = node.getAttribute('Type')
    const target = node.getAttribute('Target')
    if (!id || !target) continue
    map.set(id, { id, type: type ?? '', target: resolvePartPath(part, target) })
  }
  return map
}

export function relationshipOfType(
  relationships: Map<string, Relationship>,
  suffix: string,
): Relationship | null {
  for (const relationship of relationships.values()) {
    if (relationship.type.endsWith(suffix)) return relationship
  }
  return null
}

const REPLACEMENTS: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': ',',
  '\u201b': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u201e': '"',
  '\u201f': '"',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u2212': '-',
  '\u2026': '...',
  '\u00b7': '-',
  '\u25cf': '-',
  '\u25aa': '-',
  '\u25a0': '-',
  '\u00ad': '-',
  '\u2192': '->',
  '\u2190': '<-',
  '\ufb01': 'fi',
  '\ufb02': 'fl',
  '\u00a0': ' ',
  '\u2007': ' ',
  '\u202f': ' ',
  '\u2002': ' ',
  '\u2003': ' ',
  '\u2004': ' ',
  '\u2005': ' ',
  '\u2006': ' ',
  '\u2008': ' ',
  '\u2009': ' ',
  '\u200a': ' ',
  '\u200b': '',
}

const WINANSI_EXTRA = new Set(Array.from('€‚ƒ„…†‡ˆ‰Š‹ŒŽ•™š›œžŸ'))

const ALLOWED = (() => {
  const set = new Set<string>()
  for (let code = 0x20; code <= 0x7e; code += 1) set.add(String.fromCharCode(code))
  for (let code = 0xa0; code <= 0xff; code += 1) set.add(String.fromCharCode(code))
  for (const char of WINANSI_EXTRA) set.add(char)
  return set
})()

/** Maps text to what pdf-lib's Standard-14 WinAnsi fonts can encode. */
export function pdfSafeText(text: string): string {
  let out = ''
  for (const char of text) {
    if (char === '\n' || char === '\t') {
      out += char
      continue
    }
    const replacement = REPLACEMENTS[char]
    if (replacement !== undefined) {
      out += replacement
      continue
    }
    out += ALLOWED.has(char) ? char : '?'
  }
  return out
}

export function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function xmlAttribute(text: string): string {
  return xmlEscape(text).replace(/"/g, '&quot;')
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value)
  const fixed = value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '')
  return fixed || '0'
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30)

export function excelSerialToDate(serial: number): string {
  const ms = EXCEL_EPOCH + Math.round(serial * 86400000)
  const date = new Date(ms)
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const hh = date.getUTCHours()
  const mi = date.getUTCMinutes()
  return hh || mi ? `${yyyy}-${mm}-${dd} ${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : `${yyyy}-${mm}-${dd}`
}

export function isDateFormat(code: number, format?: string): boolean {
  if ((code >= 14 && code <= 22) || (code >= 45 && code <= 47)) return true
  if (format && !/[[\]]/.test(format) && /[ymd]/i.test(format) && !/[#0]/.test(format)) return true
  return false
}
