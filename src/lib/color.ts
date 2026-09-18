import { rgb, type RGB } from 'pdf-lib'

export interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

const cache = new Map<string, RGBA>()
let probe: CanvasRenderingContext2D | null = null

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/
const HEX4 = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])$/
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/
const HEX8 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/
const RGB = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+%?))?\s*\)$/

function parseNormalized(value: string): RGBA | null {
  let m = HEX3.exec(value) ?? HEX6.exec(value)
  if (m) {
    const step = m[1].length
    const hex = (i: number) => parseInt(step === 1 ? m![i].repeat(2) : m![i], 16)
    return { r: hex(1), g: hex(2), b: hex(3), a: 1 }
  }
  m = HEX4.exec(value) ?? HEX8.exec(value)
  if (m) {
    const step = m[1].length
    const hex = (i: number) => parseInt(step === 1 ? m![i].repeat(2) : m![i], 16)
    return { r: hex(1), g: hex(2), b: hex(3), a: hex(4) / 255 }
  }
  m = RGB.exec(value)
  if (m) {
    let a = 1
    if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
    return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10), a }
  }
  return null
}

/** Parses any CSS color into RGBA. Unknown colors resolve to opaque black. */
export function parseColor(input: unknown): RGBA {
  if (typeof input !== 'string') return { r: 0, g: 0, b: 0, a: 1 }
  const key = input.trim().toLowerCase()
  if (!key || key === 'transparent' || key === 'none') return { r: 0, g: 0, b: 0, a: 0 }
  const hit = cache.get(key)
  if (hit) return hit
  let out = parseNormalized(key)
  if (!out) {
    // Last resort: let the browser normalize named colors.
    if (!probe && typeof document !== 'undefined') {
      probe = document.createElement('canvas').getContext('2d')
    }
    if (probe) {
      probe.fillStyle = '#000000'
      probe.fillStyle = key
      out = parseNormalized(String(probe.fillStyle).toLowerCase())
    }
  }
  const rgba = out ?? { r: 0, g: 0, b: 0, a: 1 }
  cache.set(key, rgba)
  return rgba
}

export function toPdfRgb(c: RGBA): RGB {
  return rgb(c.r / 255, c.g / 255, c.b / 255)
}

export function withAlphaSet(c: RGBA, alpha: number): number {
  return c.a * alpha
}

/** Normalizes a CSS color for use in a color input. */
export function toHexColor(input: string | undefined, fallback = '#111827'): string {
  const c = parseColor(input)
  if (c.a === 0) return fallback
  const h = (n: number) => n.toString(16).padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`
}
