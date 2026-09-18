import { uid } from './uid'

/**
 * Image payloads are kept out of the annotation JSON that gets snapshotted for
 * undo/redo. Fabric objects reference an entry here by `data.assetId`.
 */
const assets = new Map<string, string>()

export function addAsset(dataUrl: string): string {
  const id = uid()
  assets.set(id, dataUrl)
  return id
}

export function getAsset(id: string): string | undefined {
  return assets.get(id)
}

/** Returns the requested images, e.g. for persisting a project in the library. */
export function collectAssets(ids: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of ids) {
    const src = assets.get(id)
    if (src) out[id] = src
  }
  return out
}

/** Restores previously collected images (library restore). */
export function restoreAssets(record: Record<string, string> | undefined | null): void {
  if (!record) return
  for (const [id, src] of Object.entries(record)) {
    if (!assets.has(id)) assets.set(id, src)
  }
}

export function hasAsset(id: string): boolean {
  return assets.has(id)
}

export function dataUrlBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('Invalid data URL')
  const meta = dataUrl.slice(0, comma)
  const payload = dataUrl.slice(comma + 1)
  if (meta.includes(';base64')) {
    const binary = atob(payload)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
    return out
  }
  return new TextEncoder().encode(decodeURIComponent(payload))
}

export function dataUrlMime(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  const meta = dataUrl.slice(0, comma)
  const match = /^data:([^;,]+)/.exec(meta)
  return match ? match[1].toLowerCase() : ''
}

function bytesFromCanvas(canvas: HTMLCanvasElement, type: string): string {
  return canvas.toDataURL(type)
}

/** Reads an image file and returns a data URL that pdf-lib can embed. */
export async function imageFileToDataUrl(file: File): Promise<{ src: string; width: number; height: number }> {
  const original = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image'))
    reader.readAsDataURL(file)
  })
  const mime = dataUrlMime(original)
  const bitmap = await loadImage(original)
  if (mime === 'image/png' || mime === 'image/jpeg') {
    return { src: original, width: bitmap.naturalWidth, height: bitmap.naturalHeight }
  }
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.naturalWidth
  canvas.height = bitmap.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is not available')
  ctx.drawImage(bitmap, 0, 0)
  return { src: bytesFromCanvas(canvas, 'image/png'), width: bitmap.naturalWidth, height: bitmap.naturalHeight }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not decode image'))
    img.src = src
  })
}

/**
 * Flips an image horizontally/vertically. pdf-lib cannot mirror images, so
 * flipped fabric images are baked into a new bitmap at export time.
 */
export async function flipDataUrl(src: string, flipX: boolean, flipY: boolean): Promise<string> {
  const img = await loadImage(src)
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return src
  ctx.translate(flipX ? canvas.width : 0, flipY ? canvas.height : 0)
  ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1)
  ctx.drawImage(img, 0, 0)
  return canvas.toDataURL('image/png')
}
