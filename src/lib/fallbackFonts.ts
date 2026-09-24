import type { PDFDocument, PDFFont } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'

/**
 * Fonts used for characters the chosen font cannot draw: Liberation Sans
 * (Latin, Greek, Cyrillic; already served with the pdf.js standard fonts) and
 * Noto Sans SC (CJK), split into small unicode-range chunks that are fetched
 * from our own origin only when a document needs them.
 */
export interface FallbackFonts {
  /** Font that can draw the character, or null when none of the fallbacks can. */
  fontFor: (char: string, bold: boolean, italic: boolean) => Promise<PDFFont | null>
}

type FontProgram = ReturnType<typeof fontkit.create>

interface LoadedFont {
  program: FontProgram
  font: PDFFont
}

// WOFF rather than WOFF2: pdf-lib's subsetter copies glyf tables as stored,
// and only WOFF keeps them untransformed.
const cjkChunkUrls = import.meta.glob<string>(
  '/node_modules/@fontsource/noto-sans-sc/files/noto-sans-sc-*-400-normal.woff',
  { query: '?url', import: 'default', eager: true },
)

interface CjkChunk {
  file: string
  ranges: Array<[number, number]>
}

let cjkChunks: Promise<CjkChunk[]> | null = null

/** Parses the unicode-range of every chunk from the package's stylesheet. */
function loadCjkChunks(): Promise<CjkChunk[]> {
  cjkChunks ??= import('@fontsource/noto-sans-sc/400.css?raw')
    .then(({ default: css }) => parseChunks(css))
    .catch((error) => {
      console.warn('Could not load the CJK fallback font table', error)
      return []
    })
  return cjkChunks
}

function parseChunks(css: string): CjkChunk[] {
  const chunks: CjkChunk[] = []
  for (const block of css.split('@font-face').slice(1)) {
    const file = /url\(\.\/files\/([^)]+-400-normal\.woff)\)/.exec(block)?.[1]
    const range = /unicode-range:\s*([^;}]+)/.exec(block)?.[1]
    if (!file || !range) continue
    const ranges: Array<[number, number]> = []
    for (const part of range.split(',')) {
      const match = /U\+([0-9a-f?]+)(?:-([0-9a-f]+))?/i.exec(part.trim())
      if (!match) continue
      if (match[1].includes('?')) {
        ranges.push([parseInt(match[1].replace(/\?/g, '0'), 16), parseInt(match[1].replace(/\?/g, 'f'), 16)])
      } else {
        const start = parseInt(match[1], 16)
        ranges.push([start, match[2] ? parseInt(match[2], 16) : start])
      }
    }
    chunks.push({ file, ranges })
  }
  return chunks
}

const LIBERATION_VARIANTS = ['Regular', 'Bold', 'Italic', 'BoldItalic'] as const

function liberationUrl(bold: boolean, italic: boolean): string {
  const variant = LIBERATION_VARIANTS[(bold ? 1 : 0) + (italic ? 2 : 0)]
  return new URL(
    `${import.meta.env.BASE_URL}pdfjs-assets/standard_fonts/LiberationSans-${variant}.ttf`,
    window.location.href,
  ).href
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status} ${url}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** Fallback fonts for one output document; fonts are embedded on first use. */
export function createFallbackFonts(doc: PDFDocument): FallbackFonts {
  const loaded = new Map<string, Promise<LoadedFont | null>>()
  const resolved = new Map<string, PDFFont | null>()

  const load = (key: string, url: () => Promise<string | undefined>): Promise<LoadedFont | null> => {
    let hit = loaded.get(key)
    if (!hit) {
      hit = (async () => {
        try {
          const href = await url()
          if (!href) return null
          const bytes = await fetchBytes(href)
          const program = fontkit.create(bytes)
          const font = await doc.embedFont(bytes, { subset: true })
          return { program, font }
        } catch (error) {
          console.warn('Could not load a fallback font', error)
          return null
        }
      })()
      loaded.set(key, hit)
    }
    return hit
  }

  const fontFor = async (char: string, bold: boolean, italic: boolean): Promise<PDFFont | null> => {
    const key = `${bold ? 'b' : ''}${italic ? 'i' : ''}:${char}`
    const hit = resolved.get(key)
    if (hit !== undefined) return hit
    const code = char.codePointAt(0) ?? 0
    let result: PDFFont | null = null
    const latin = await load(`liberation:${bold}:${italic}`, async () => liberationUrl(bold, italic))
    if (latin?.program.hasGlyphForCodePoint(code)) {
      result = latin.font
    } else {
      // Chunk ranges overlap and some cover code points the font has no glyph
      // for (Hangul, Arabic), so check each candidate's cmap.
      const chunks = (await loadCjkChunks()).filter(({ ranges }) =>
        ranges.some(([start, end]) => code >= start && code <= end),
      )
      for (const chunk of chunks) {
        const cjk = await load(`cjk:${chunk.file}`, async () =>
          Object.entries(cjkChunkUrls).find(([path]) => path.endsWith(`/${chunk.file}`))?.[1],
        )
        if (cjk?.program.hasGlyphForCodePoint(code)) {
          result = cjk.font
          break
        }
      }
    }
    resolved.set(key, result)
    return result
  }

  return { fontFor }
}

/** A piece of a line drawn with one font; `font` is null for the primary font. */
export interface TextRun {
  text: string
  font: PDFFont | null
}

/**
 * Resolves a fallback for every character the primary font cannot draw.
 * Characters missing from the result map are drawn with the primary font;
 * a null entry means no font can draw it.
 */
export async function resolveFallbacks(
  text: string,
  canDraw: (char: string) => boolean,
  fallbacks: FallbackFonts,
  bold: boolean,
  italic: boolean,
): Promise<Map<string, PDFFont | null>> {
  const out = new Map<string, PDFFont | null>()
  for (const char of text) {
    if (out.has(char) || char === ' ' || char === '\n' || canDraw(char)) continue
    out.set(char, await fallbacks.fontFor(char, bold, italic))
  }
  return out
}

/** Splits a line into runs that share a font. */
export function splitRuns(line: string, fallbacks: Map<string, PDFFont | null>): TextRun[] {
  const runs: TextRun[] = []
  for (const char of line) {
    const font = fallbacks.get(char) ?? null
    const last = runs[runs.length - 1]
    if (last && last.font === font) last.text += char
    else runs.push({ text: char, font })
  }
  return runs
}
