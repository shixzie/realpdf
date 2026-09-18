import { FabricImage, type Canvas, type FabricObject } from 'fabric'
import { addAsset } from './assets'
import { serializeCanvas } from './serialize'
import { isTextObject } from './tools'
import { useStore } from '../store'

const byCanvas = new Map<Canvas, string>()
const byPage = new Map<string, Canvas>()

export function registerCanvas(pageId: string, canvas: Canvas): void {
  byCanvas.set(canvas, pageId)
  byPage.set(pageId, canvas)
}

export function unregisterCanvas(pageId: string, canvas: Canvas): void {
  if (byCanvas.get(canvas) === pageId) byCanvas.delete(canvas)
  if (byPage.get(pageId) === canvas) byPage.delete(pageId)
}

export function getCanvas(pageId: string | null | undefined): Canvas | undefined {
  if (!pageId) return undefined
  return byPage.get(pageId)
}

export function pageIdOf(canvas: Canvas): string | undefined {
  return byCanvas.get(canvas)
}

export function activeCanvas(): Canvas | undefined {
  for (const canvas of byCanvas.keys()) {
    const active = canvas.getActiveObjects()
    if (active.length) return canvas
  }
  return undefined
}

/**
 * The text object (annotation or PDF-text replacement) currently selected, if
 * any. The page of the last text selection is preferred so that selections on
 * other pages do not shadow it.
 */
export function activeTextSelection(): { canvas: Canvas; object: FabricObject } | undefined {
  const preferred = getCanvas(useStore.getState().textSelectionPage)
  const canvases = preferred ? [preferred, ...byCanvas.keys()] : Array.from(byCanvas.keys())
  for (const canvas of canvases) {
    const object = canvas.getActiveObject()
    if (object && isTextObject(object)) return { canvas, object }
  }
  return undefined
}

/** Serializes a canvas and stores the result as the page's annotations. */
export function commitCanvas(pageId: string): void {
  const canvas = getCanvas(pageId)
  if (!canvas) return
  useStore.getState().commitAnnotations(pageId, serializeCanvas(canvas))
}

export function commitCanvasObject(canvas: Canvas): void {
  const pageId = pageIdOf(canvas)
  if (!pageId) return
  useStore.getState().commitAnnotations(pageId, serializeCanvas(canvas))
}

export async function insertImageObject(
  canvas: Canvas,
  src: string,
  options: { center?: { x: number; y: number }; maxWidth?: number } = {},
): Promise<FabricObject | null> {
  let image: FabricImage
  try {
    image = await FabricImage.fromURL(src)
  } catch {
    return null
  }
  const assetId = addAsset(src)
  const pageWidth = canvas.getWidth() / canvas.getZoom()
  const target = options.center ?? canvas.getCenterPoint()
  const maxWidth = options.maxWidth ?? Math.min(320, pageWidth * 0.6)
  const naturalWidth = image.width || 1
  const scale = Math.min(1, maxWidth / naturalWidth)
  image.set({
    left: target.x,
    top: target.y,
    originX: 'center',
    originY: 'center',
    scaleX: scale,
    scaleY: scale,
    data: { kind: 'image', assetId },
  })
  canvas.add(image)
  canvas.setActiveObject(image)
  canvas.requestRenderAll()
  return image
}

export function deleteSelection(canvas: Canvas): void {
  const objects = canvas.getActiveObjects()
  if (!objects.length) return
  const pageId = pageIdOf(canvas)
  if (pageId) useStore.getState().beginChange()
  for (const obj of objects) canvas.remove(obj)
  canvas.discardActiveObject()
  canvas.requestRenderAll()
  if (pageId) commitCanvas(pageId)
}
