/**
 * pdf.js draws on the main thread in ~15 ms slices, one slice per frame for
 * every render in flight, so pages and thumbnails rendering at once stack
 * their slices into one long frame. Renders wait here and run a couple at a
 * time, nearest to the viewport first.
 */
interface RenderJob {
  rank: () => number
  run: () => Promise<void>
}

const MAX_RUNNING = 2
const waiting = new Set<RenderJob>()
let running = 0
let pumpQueued = false

function pump() {
  pumpQueued = false
  while (running < MAX_RUNNING && waiting.size) {
    let next: RenderJob | null = null
    let best = Number.POSITIVE_INFINITY
    for (const job of waiting) {
      const rank = job.rank()
      if (next === null || rank < best) {
        next = job
        best = rank
      }
    }
    if (!next) return
    waiting.delete(next)
    running += 1
    void next
      .run()
      .catch((error) => console.error(error))
      .finally(() => {
        running -= 1
        schedulePump()
      })
  }
}

function schedulePump() {
  if (pumpQueued) return
  pumpQueued = true
  // Pages mounted in the same commit are ranked together.
  queueMicrotask(pump)
}

/** Queues a render; the returned function drops it if it has not started. */
export function queueRender(rank: () => number, run: () => Promise<void>): () => void {
  const job = { rank, run }
  waiting.add(job)
  schedulePump()
  return () => {
    waiting.delete(job)
  }
}

/** How far an element is from the viewport, in CSS pixels (0 when on screen). */
export function viewportDistance(element: Element | null): number {
  if (!element?.isConnected) return Number.POSITIVE_INFINITY
  const rect = element.getBoundingClientRect()
  const bottom = window.innerHeight
  if (rect.bottom >= 0 && rect.top <= bottom) return 0
  return rect.top > bottom ? rect.top - bottom : -rect.bottom
}

/** Thumbnails rank after every page of the document itself. */
export const THUMBNAIL_RANK = 1e6
