import {
  Ellipse,
  Group,
  IText,
  Line,
  PencilBrush,
  Rect,
  Triangle,
  type Canvas,
  type FabricObject,
  type TPointerEvent,
} from 'fabric'
import type { Settings, Tool } from '../types'
import { useStore } from '../store'
import { parseColor } from './color'
import { t } from '../i18n'

const SHAPE_TOOLS: Tool[] = ['rect', 'ellipse', 'line', 'arrow', 'whiteout']

/** Committed highlight strokes render at this opacity so the page shows through. */
export const HIGHLIGHT_OPACITY = 0.35

/** Live brush color: the highlighter previews at the opacity it will render at. */
function highlightBrushColor(color: string): string {
  const { r, g, b, a } = parseColor(color)
  return `rgba(${r}, ${g}, ${b}, ${a * HIGHLIGHT_OPACITY})`
}

export function isShapeTool(tool: Tool): boolean {
  return SHAPE_TOOLS.includes(tool)
}

/** True for text annotations and replacements of existing PDF text. */
export function isTextObject(object: FabricObject | null | undefined): boolean {
  const kind = (object as { data?: { kind?: string } } | null | undefined)?.data?.kind
  return kind === 'text' || kind === 'pdftext'
}

export function applyToolToCanvas(canvas: Canvas, tool: Tool, settings: Settings): void {
  const drawing = tool === 'pen' || tool === 'highlighter'
  canvas.isDrawingMode = drawing
  canvas.selection = tool === 'select'
  canvas.defaultCursor = tool === 'select' ? 'default' : tool === 'textedit' || tool === 'text' ? 'text' : 'crosshair'
  // `textedit` keeps hit-testing on (to re-edit replacements) but nothing is
  // selectable, so clicks are handled by the page itself. The text tool also
  // hit-tests, but only text objects stay interactive.
  canvas.skipTargetFind =
    drawing || (tool !== 'select' && tool !== 'eraser' && tool !== 'textedit' && tool !== 'text')
  if (drawing) {
    const brush = new PencilBrush(canvas)
    if (tool === 'pen') {
      brush.color = settings.color
      brush.width = settings.strokeWidth
    } else {
      // The preview must match the committed annotation, or positioning the
      // stroke precisely is guesswork.
      brush.color = highlightBrushColor(settings.highlightColor)
      brush.width = settings.highlightWidth
    }
    canvas.freeDrawingBrush = brush
  }
  const selectable = tool === 'select'
  const evented = tool === 'select' || tool === 'eraser' || tool === 'textedit'
  canvas.forEachObject((obj) => {
    // `evented` must stay true for the eraser so hit-testing can find objects.
    // The text tool keeps text objects clickable so they can be selected and
    // restyled.
    const text = tool === 'text' && isTextObject(obj)
    obj.set({ selectable: selectable || text, evented: evented || text })
    obj.set({ hoverCursor: tool === 'textedit' || text ? 'text' : undefined })
  })
  canvas.requestRenderAll()
}

export interface Vec {
  x: number
  y: number
}

export function createShape(kind: Tool, a: Vec, b: Vec, settings: Settings): FabricObject {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const width = Math.max(1, Math.abs(b.x - a.x))
  const height = Math.max(1, Math.abs(b.y - a.y))
  const common = { selectable: false, evented: false, originX: 'left' as const, originY: 'top' as const }
  switch (kind) {
    case 'whiteout':
      return new Rect({
        ...common,
        left: x,
        top: y,
        width,
        height,
        fill: settings.whiteoutColor,
        stroke: undefined,
        data: { kind: 'whiteout' },
      })
    case 'ellipse':
      return new Ellipse({
        ...common,
        left: x,
        top: y,
        rx: width / 2,
        ry: height / 2,
        fill: 'transparent',
        stroke: settings.color,
        strokeWidth: settings.strokeWidth,
        strokeUniform: true,
        data: { kind: 'ellipse' },
      })
    case 'line':
    case 'arrow':
      return new Line([a.x, a.y, b.x, b.y], {
        ...common,
        stroke: settings.color,
        strokeWidth: settings.strokeWidth,
        strokeLineCap: 'round',
        data: { kind: kind === 'arrow' ? 'arrow-draft' : 'line' },
      })
    case 'rect':
    default:
      return new Rect({
        ...common,
        left: x,
        top: y,
        width,
        height,
        fill: 'transparent',
        stroke: settings.color,
        strokeWidth: settings.strokeWidth,
        strokeUniform: true,
        data: { kind: 'rect' },
      })
  }
}

export function updateShape(kind: Tool, obj: FabricObject, a: Vec, b: Vec): void {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const width = Math.max(1, Math.abs(b.x - a.x))
  const height = Math.max(1, Math.abs(b.y - a.y))
  if (kind === 'rect' || kind === 'whiteout') {
    obj.set({ left: x, top: y, width, height })
  } else if (kind === 'ellipse') {
    obj.set({ left: x, top: y, rx: width / 2, ry: height / 2 })
  }
  obj.setCoords()
}

export function finalizeArrow(canvas: Canvas, line: Line, settings: Settings): Group {
  const x1 = line.x1
  const y1 = line.y1
  const x2 = line.x2
  const y2 = line.y2
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const size = Math.max(10, settings.strokeWidth * 4)
  const head = new Triangle({
    left: x2,
    top: y2,
    originX: 'center',
    originY: 'center',
    width: size,
    height: size * 1.05,
    angle: (angle * 180) / Math.PI + 90,
    fill: settings.color,
    stroke: undefined,
    selectable: false,
    evented: false,
    data: { kind: 'triangle' },
  })
  line.set({ data: { kind: 'line' }, selectable: false, evented: false })
  canvas.remove(line)
  const group = new Group([line, head], { data: { kind: 'arrow' } } as never)
  return group
}

export function createTextObject(canvas: Canvas, point: Vec, settings: Settings): IText {
  const placeholder = t('canvas.textPlaceholder')
  const text = new IText(placeholder, {
    left: point.x,
    top: point.y,
    originX: 'left',
    originY: 'top',
    fontSize: settings.fontSize,
    fill: settings.color,
    fontFamily: settings.fontFamily,
    data: { kind: 'text', placeholder: true, placeholderText: placeholder },
    selectable: true,
    evented: true,
  })
  canvas.add(text)
  canvas.setActiveObject(text)
  text.enterEditing()
  text.selectAll()
  canvas.requestRenderAll()
  return text
}

export function eraseObjectAt(canvas: Canvas, event: TPointerEvent): boolean {
  const target = canvas.findTarget(event).target
  if (!target) return false
  useStore.getState().beginChange()
  canvas.remove(target)
  canvas.requestRenderAll()
  return true
}
