const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null

/** Splits text into user-perceived characters (emoji sequences stay whole). */
export function graphemes(text: string): string[] {
  if (!segmenter) return Array.from(text)
  return Array.from(segmenter.segment(text), (part) => part.segment)
}
