import type { Canvas, FabricObject } from 'fabric'
import type { Tool } from '../types'
import { toHexColor } from './color'

/**
 * Styling of already-drawn annotations.
 *
 * Every tool result (cover, rectangle, ellipse, line, arrow, pen stroke,
 * highlight, text, image) can be selected with the select tool. The options bar
 * then shows the options of the tool that produced it and edits the selection
 * in place, exactly like the text tool does for selected text. This module maps
 * a selected object to its tool and applies colour/width patches to the right
 * fabric properties (a cover's fill, an arrow's line and head, a path's stroke).
 */

type AnyObject = FabricObject & Record<string, any>

export type AnnotationKind =
  | 'text'
  | 'pdftext'
  | 'whiteout'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'draw'
  | 'highlight'
  | 'image'
  | 'unknown'

const KIND_TOOL: Partial<Record<AnnotationKind, Tool>> = {
  text: 'text',
  pdftext: 'text',
  whiteout: 'whiteout',
  rect: 'rect',
  ellipse: 'ellipse',
  line: 'line',
  arrow: 'arrow',
  draw: 'pen',
  highlight: 'highlighter',
  image: 'image',
}

/** Kind of a drawn annotation, falling back to the fabric type. */
export function annotationKindOf(object: FabricObject | null | undefined): AnnotationKind {
  const target = object as AnyObject | null | undefined
  const kind = String(target?.data?.kind ?? '')
  switch (kind) {
    case 'text':
    case 'pdftext':
    case 'whiteout':
    case 'rect':
    case 'ellipse':
    case 'line':
    case 'arrow':
    case 'draw':
    case 'highlight':
    case 'image':
      return kind
    case 'arrow-draft':
      return 'arrow'
  }
  const type = String(target?.type ?? '').toLowerCase()
  if (type === 'i-text' || type === 'textbox' || type === 'text') return 'text'
  if (type === 'path') return 'draw'
  if (type === 'line') return 'line'
  if (type === 'ellipse' || type === 'circle') return 'ellipse'
  if (type === 'rect') return 'rect'
  if (type === 'image') return 'image'
  return 'unknown'
}

/** The tool whose options a selected object belongs to, if any. */
export function annotationToolOf(object: FabricObject | null | undefined): Tool | null {
  return KIND_TOOL[annotationKindOf(object)] ?? null
}

export interface AnnotationStyle {
  /** Stroke colour for shapes/paths, fill colour for covers. */
  color?: string
  /** Stroke width in points (ignored by covers and images). */
  width?: number
}

export interface AnnotationStylePatch {
  color?: string
  width?: number
}

const STROKE_KINDS: AnnotationKind[] = ['rect', 'ellipse', 'line', 'arrow', 'draw', 'highlight']

function isStrokeKind(kind: AnnotationKind): boolean {
  return STROKE_KINDS.includes(kind)
}

/**
 * The child that carries the stroke of a compound annotation. Arrows are a
 * group of a line and a filled head, so their colour lives on the line.
 */
function strokeTarget(object: AnyObject, kind: AnnotationKind): AnyObject | null {
  if (kind !== 'arrow') return object
  const children = (object.getObjects?.() ?? []) as AnyObject[]
  return children.find((child) => annotationKindOf(child) === 'line') ?? children.find((child) => child.stroke) ?? null
}

/** Current colour/width of the first stylable object in a selection. */
export function readAnnotationStyle(objects: FabricObject[]): AnnotationStyle {
  for (const object of objects) {
    const target = object as AnyObject
    const kind = annotationKindOf(object)
    if (kind === 'whiteout') {
      const color = typeof target.fill === 'string' ? toHexColor(target.fill, '') : ''
      if (color) return { color }
      continue
    }
    if (kind === 'image' || !isStrokeKind(kind)) continue
    const stroke = strokeTarget(target, kind)
    if (!stroke) continue
    const style: AnnotationStyle = {}
    if (typeof stroke.stroke === 'string') style.color = toHexColor(stroke.stroke, '') || undefined
    if (typeof stroke.strokeWidth === 'number') style.width = stroke.strokeWidth
    return style
  }
  return {}
}

/** Applies a colour/width patch to every compatible object in a selection. */
export function styleAnnotationObjects(
  canvas: Canvas,
  objects: FabricObject[],
  patch: AnnotationStylePatch,
): void {
  for (const object of objects) {
    const target = object as AnyObject
    const kind = annotationKindOf(object)
    if (kind === 'whiteout') {
      if (patch.color !== undefined) target.set({ fill: patch.color })
      target.dirty = true
      continue
    }
    if (!isStrokeKind(kind)) continue
    const stroke = strokeTarget(target, kind)
    if (stroke) {
      const next: Record<string, unknown> = {}
      if (patch.color !== undefined) next.stroke = patch.color
      if (patch.width !== undefined) next.strokeWidth = Math.max(0.25, patch.width)
      stroke.set(next)
      stroke.dirty = true
      stroke.setCoords()
    }
    if (kind === 'arrow') {
      const head = ((target.getObjects?.() ?? []) as AnyObject[]).find(
        (child) => String(child.type ?? '').toLowerCase() === 'triangle',
      )
      if (head && patch.color !== undefined) {
        head.set({ fill: patch.color })
        head.dirty = true
      }
    }
    target.dirty = true
    target.setCoords()
  }
  canvas.requestRenderAll()
}
