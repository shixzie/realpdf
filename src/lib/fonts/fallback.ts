import fontkit from '@pdf-lib/fontkit'
import type { PDFDocument, PDFFont } from 'pdf-lib'

export { graphemes } from './graphemes'

/**
 * Fallback fonts for text the Standard-14 fonts (or a font lifted from the
 * original PDF) cannot draw: Latin/Greek/Cyrillic/Vietnamese extensions, CJK,
 * Hangul and emoji. The Noto families come from @fontsource, which ships them
 * as small WOFF slices keyed by unicode range, so a document only downloads
 * the slices its text touches and only embeds the glyphs it uses. Everything
 * is served from our own origin (Vite emits the slices as hashed assets).
 *
 * WOFF, not WOFF2: fontkit's subsetter copies raw `glyf` bytes, and WOFF2
 * stores that table transformed, so WOFF2 subsets come out corrupt.
 */

export type FallbackWeight = 400 | 700

/** Families in the order they are tried; emoji clusters try `noto-emoji` first. */
const FAMILIES = ['noto-sans', 'noto-sans-sc', 'noto-sans-kr', 'noto-emoji'] as const
type Family = (typeof FAMILIES)[number]
const EMOJI_FAMILY: Family = 'noto-emoji'

const FILE_URLS = import.meta.glob<string>(
  '/node_modules/@fontsource/{noto-sans,noto-sans-sc,noto-sans-kr,noto-emoji}/files/*-{400,700}-normal.woff',
  { query: '?url', import: 'default', eager: true },
)
const UNICODE_TABLES = import.meta.glob<Record<string, string>>(
  '/node_modules/@fontsource/{noto-sans,noto-sans-sc,noto-sans-kr,noto-emoji}/unicode.json',
  { import: 'default' },
)

type Face = ReturnType<typeof fontkit.create>

/** A font slice that can draw a cluster, plus the exact text to encode with it. */
export interface FallbackGlyphs {
  /** Stable id of the slice, e.g. `noto-sans-sc-116-400`. */
  id: string
  /** The WOFF bytes; embed them with `subset: true` so pdf-lib writes a plain TrueType subset. */
  bytes: Uint8Array
  /** The parsed face, for metrics and cmap checks. */
  face: Face
  /** The cluster without invisible code points the face has no glyph for. */
  text: string
}

// Zero-width joiner, variation selectors and tag characters only steer shaping.
const IGNORABLE = /^[\u200d\ufe00-\ufe0f\u{e0020}-\u{e007f}]$/u
const EMOJI = /[\p{Extended_Pictographic}\u{1f1e6}-\u{1f1ff}\ufe0f\u20e3]/u

type Ranges = Array<[start: number, end: number, slice: string]>
const rangeCache = new Map<Family, Promise<Ranges>>()

function loadRanges(family: Family): Promise<Ranges> {
  let hit = rangeCache.get(family)
  if (!hit) {
    const loader = UNICODE_TABLES[`/node_modules/@fontsource/${family}/unicode.json`]
    hit = (loader ? loader() : Promise.resolve<Record<string, string>>({})).then((table) => {
      const ranges: Ranges = []
      for (const [key, value] of Object.entries(table)) {
        const slice = key.replace(/^\[|\]$/g, '')
        for (const part of value.split(',')) {
          const [from, to] = part.trim().replace(/^U\+/i, '').split('-')
          const start = parseInt(from, 16)
          if (Number.isFinite(start)) ranges.push([start, to ? parseInt(to, 16) : start, slice])
        }
      }
      return ranges
    })
    rangeCache.set(family, hit)
  }
  return hit
}

function sliceUrl(family: Family, slice: string, weight: FallbackWeight): string | undefined {
  const dir = `/node_modules/@fontsource/${family}/files/`
  return FILE_URLS[`${dir}${family}-${slice}-${weight}-normal.woff`]
    ?? FILE_URLS[`${dir}${family}-${slice}-400-normal.woff`]
}

interface LoadedFace {
  bytes: Uint8Array
  face: Face
}
const faceCache = new Map<string, Promise<LoadedFace | null>>()

function loadFace(url: string): Promise<LoadedFace | null> {
  let hit = faceCache.get(url)
  if (!hit) {
    hit = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.arrayBuffer()
      })
      .then((buffer) => {
        const bytes = new Uint8Array(buffer)
        return { bytes, face: fontkit.create(bytes) }
      })
      .catch((error) => {
        console.warn('Could not load a fallback font', url, error)
        // Allow a later export to retry, e.g. after the connection comes back.
        faceCache.delete(url)
        return null
      })
    faceCache.set(url, hit)
  }
  return hit
}

/**
 * Finds a fallback slice that draws every visible code point of `cluster`
 * (one grapheme) in a single font, so emoji sequences and combining marks
 * shape together. Returns null when no bundled font covers it.
 */
export async function findFallbackGlyphs(cluster: string, weight: FallbackWeight = 400): Promise<FallbackGlyphs | null> {
  const points = Array.from(cluster).filter((ch) => !IGNORABLE.test(ch)).map((ch) => ch.codePointAt(0) ?? 0)
  if (!points.length) return null
  const order: readonly Family[] = EMOJI.test(cluster)
    ? [EMOJI_FAMILY, ...FAMILIES.filter((family) => family !== EMOJI_FAMILY)]
    : FAMILIES
  for (const family of order) {
    const ranges = await loadRanges(family)
    const first = points[0]
    const slices = new Set<string>()
    for (const [start, end, slice] of ranges) if (first >= start && first <= end) slices.add(slice)
    for (const slice of slices) {
      const url = sliceUrl(family, slice, weight)
      if (!url) continue
      const loaded = await loadFace(url)
      if (!loaded || !points.every((point) => loaded.face.hasGlyphForCodePoint(point))) continue
      let text = ''
      for (const ch of cluster) {
        if (!IGNORABLE.test(ch) || loaded.face.hasGlyphForCodePoint(ch.codePointAt(0) ?? 0)) text += ch
      }
      return { id: `${family}-${slice}-${weight}`, bytes: loaded.bytes, face: loaded.face, text }
    }
  }
  return null
}

export interface FallbackFonts {
  /** The embedded font and text to draw `cluster` with, or null if uncovered. */
  resolve(cluster: string, bold: boolean): Promise<{ font: PDFFont; text: string } | null>
}

/** Embeds fallback slices into `doc` on demand, each as a glyph subset. */
export function createFallbackFonts(doc: PDFDocument): FallbackFonts {
  const embedded = new Map<string, Promise<PDFFont | null>>()
  return {
    async resolve(cluster, bold) {
      const glyphs = await findFallbackGlyphs(cluster, bold ? 700 : 400)
      if (!glyphs) return null
      let font = embedded.get(glyphs.id)
      if (!font) {
        font = doc.embedFont(glyphs.bytes, { subset: true }).catch((error) => {
          console.warn('Could not embed a fallback font', glyphs.id, error)
          return null
        })
        embedded.set(glyphs.id, font)
      }
      const ready = await font
      return ready ? { font: ready, text: glyphs.text } : null
    },
  }
}
