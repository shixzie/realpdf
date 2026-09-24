import notoSansUrl from './NotoSans-Regular.ttf?url'

/**
 * Bundled Unicode fallback font (Noto Sans: Latin, Greek, Cyrillic; SIL OFL,
 * see OFL.txt). Served from our own origin and only fetched the first time a
 * document needs a character no other font can draw.
 */

let task: Promise<Uint8Array | null> | null = null

export function loadFallbackFontBytes(): Promise<Uint8Array | null> {
  if (!task) {
    task = (async () => {
      try {
        const response = await fetch(notoSansUrl)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return new Uint8Array(await response.arrayBuffer())
      } catch (error) {
        console.warn('Could not load the fallback font', error)
        task = null
        return null
      }
    })()
  }
  return task
}
