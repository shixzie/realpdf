import '@fontsource/dancing-script/400.css'
import '@fontsource/caveat/400.css'
import '@fontsource/homemade-apple/400.css'
import { loadImage } from './assets'

/**
 * Handwritten-looking signatures: drawn, typed in a script font, or uploaded.
 * Every source ends up as a trimmed transparent PNG data URL, which is what
 * the signer embeds in the certified signature's appearance.
 */

/** Script fonts offered for a typed signature, served from our own origin. */
export const SIGNATURE_FONTS = ['Dancing Script', 'Caveat', 'Homemade Apple'] as const
export type SignatureFont = (typeof SIGNATURE_FONTS)[number]

export const SIGNATURE_INK = '#111827'

/** Crops fully transparent borders and returns a PNG data URL. */
export function trimCanvas(source: HTMLCanvasElement): string | null {
  const context = source.getContext('2d')
  if (!context) return null
  const { data } = context.getImageData(0, 0, source.width, source.height)
  let minX = source.width
  let minY = source.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const alpha = data[(y * source.width + x) * 4 + 3]
      if (alpha > 8) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0 || maxY < 0) return null
  const pad = 8
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(source.width - 1, maxX + pad)
  maxY = Math.min(source.height - 1, maxY + pad)
  const out = document.createElement('canvas')
  out.width = maxX - minX + 1
  out.height = maxY - minY + 1
  const outContext = out.getContext('2d')
  if (!outContext) return null
  outContext.drawImage(source, minX, minY, out.width, out.height, 0, 0, out.width, out.height)
  return out.toDataURL('image/png')
}

/** Makes near-white pixels transparent and crops the result. */
export async function prepareUploadedSignature(src: string, removeWhite: boolean): Promise<string | null> {
  const image = await loadImage(src)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, image.naturalWidth)
  canvas.height = Math.max(1, image.naturalHeight)
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(image, 0, 0)
  if (removeWhite) {
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
    const pixels = imageData.data
    for (let i = 0; i < pixels.length; i += 4) {
      const luminance = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]
      const alpha = Math.max(0, Math.min(255, Math.round((238 - luminance) * 2.6)))
      pixels[i + 3] = Math.min(pixels[i + 3], alpha)
    }
    context.putImageData(imageData, 0, 0)
  }
  return trimCanvas(canvas)
}

/** Renders a name in one of the script fonts (the system's cursive font for scripts it lacks). */
export async function renderTypedSignature(name: string, font: SignatureFont): Promise<string | null> {
  const text = name.trim()
  if (!text) return null
  const size = 72
  const family = `"${font}", cursive`
  try {
    await document.fonts.load(`${size}px ${family}`, text)
  } catch {
    // Draw with whatever font is available.
  }
  const canvas = document.createElement('canvas')
  const measure = canvas.getContext('2d')
  if (!measure) return null
  measure.font = `${size}px ${family}`
  canvas.width = Math.min(2400, Math.ceil(measure.measureText(text).width + size))
  canvas.height = Math.ceil(size * 2)
  const context = canvas.getContext('2d')
  if (!context) return null
  context.font = `${size}px ${family}`
  context.fillStyle = SIGNATURE_INK
  context.textBaseline = 'middle'
  context.fillText(text, size / 2, canvas.height / 2)
  return trimCanvas(canvas)
}

/** The PNG bytes of a data URL made by the functions above. */
export function dataUrlBytes(dataUrl: string): Uint8Array {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Adopted signatures, one per signing ID saved on this device. */
const STORAGE_KEY = 'realpdf-signatures'

function readAll(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function savedSignatureImage(identityId: string): string | null {
  const value = readAll()[identityId]
  return typeof value === 'string' && value.startsWith('data:image/png') ? value : null
}

export function saveSignatureImage(identityId: string, dataUrl: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [identityId]: dataUrl }))
  } catch {
    // Storage is full or blocked; the signature still works for this session.
  }
}

export function forgetSignatureImage(identityId: string): void {
  try {
    const all = readAll()
    delete all[identityId]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Nothing to clean up.
  }
}
