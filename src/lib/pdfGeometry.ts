import { PDFDocument, type PDFEmbeddedPage, type PDFPage } from 'pdf-lib'

export interface VisiblePageSize {
  width: number
  height: number
}

export function visiblePageSize(page: PDFPage): VisiblePageSize {
  const crop = page.getCropBox()
  const angle = ((page.getRotation().angle % 360) + 360) % 360
  return angle === 90 || angle === 270
    ? { width: crop.height, height: crop.width }
    : { width: crop.width, height: crop.height }
}

/** Maps a visible top-left point into the page's PDF user space. */
export function visiblePoint(page: PDFPage, x: number, y: number): { x: number; y: number } {
  const crop = page.getCropBox()
  const angle = ((page.getRotation().angle % 360) + 360) % 360
  if (angle === 90) return { x: crop.x + y, y: crop.y + x }
  if (angle === 180) return { x: crop.x + crop.width - x, y: crop.y + y }
  if (angle === 270) return { x: crop.x + crop.width - y, y: crop.y + crop.height - x }
  return { x: crop.x + x, y: crop.y + crop.height - y }
}

/** Embeds the visible CropBox, with page rotation normalized into the Form XObject. */
export async function embedVisiblePage(
  targetDoc: PDFDocument,
  sourcePage: PDFPage,
): Promise<{ page: PDFEmbeddedPage | null; width: number; height: number }> {
  const entries = sourcePage.node.normalizedEntries()
  if (!entries.Contents) return { page: null, ...visiblePageSize(sourcePage) }
  const crop = sourcePage.getCropBox()
  const size = visiblePageSize(sourcePage)
  const angle = ((sourcePage.getRotation().angle % 360) + 360) % 360
  const matrix =
    angle === 90
      ? [0, -1, 1, 0, -crop.y, crop.x + crop.width]
      : angle === 180
        ? [-1, 0, 0, -1, crop.x + crop.width, crop.y + crop.height]
        : angle === 270
          ? [0, 1, -1, 0, crop.y + crop.height, -crop.x]
          : [1, 0, 0, 1, -crop.x, -crop.y]
  const embedded = await targetDoc.embedPage(
    sourcePage,
    { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height },
    matrix as [number, number, number, number, number, number],
  )
  return { page: embedded, ...size }
}
