import type { Canvas } from 'fabric'
import { getAsset } from './assets'
import type { AnnotationsJSON } from '../types'

export function emptyAnnotations(): AnnotationsJSON {
  return { objects: [] }
}

/**
 * Serializes a fabric canvas for storage. Image `src` values are stripped and
 * replaced by an `assetId` reference so that snapshots stay small.
 */
export function serializeCanvas(canvas: Canvas): AnnotationsJSON {
  // `data` is a custom property, so it must be requested explicitly; groups
  // pass the list down to their children.
  const json = canvas.toObject(['data']) as { objects?: unknown[] }
  const objects = (json.objects ?? []) as Record<string, unknown>[]
  stripSources(objects)
  return { objects }
}

function isImageType(type: unknown): boolean {
  return String(type ?? '').toLowerCase() === 'image'
}

function stripSources(objects: unknown[]): void {
  for (const item of objects) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, any>
    const data = obj.data as Record<string, unknown> | undefined
    if (isImageType(obj.type) && data?.assetId) {
      delete obj.src
    }
    if (Array.isArray(obj.objects)) stripSources(obj.objects)
  }
}

/**
 * Deep-clones stored annotation JSON and re-attaches image sources. Objects
 * whose asset is missing are dropped.
 */
export function hydrateAnnotations(json: AnnotationsJSON | null | undefined): AnnotationsJSON {
  const objects = clone(json?.objects ?? [])
  attachSources(objects)
  return { objects }
}

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

function attachSources(objects: unknown[]): void {
  for (let i = objects.length - 1; i >= 0; i -= 1) {
    const item = objects[i]
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, any>
    const data = obj.data as Record<string, unknown> | undefined
    if (isImageType(obj.type) && typeof data?.assetId === 'string') {
      const src = getAsset(data.assetId)
      if (!src) {
        objects.splice(i, 1)
        continue
      }
      obj.src = src
    }
    if (Array.isArray(obj.objects)) attachSources(obj.objects)
  }
}
