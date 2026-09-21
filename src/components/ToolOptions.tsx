import { useMemo } from 'react'
import { Trash2, X } from 'lucide-react'
import type { FabricObject } from 'fabric'
import { useStore } from '../store'
import {
  activeCanvas,
  activeSelection,
  commitCanvas,
  commitCanvasObject,
  deleteSelection,
  getCanvas,
} from '../lib/canvasRegistry'
import { styleTextObject, textFontFamily, type TextStylePatch } from '../lib/textEdit'
import {
  annotationToolOf,
  readAnnotationStyle,
  styleAnnotationObjects,
  type AnnotationStyle,
  type AnnotationStylePatch,
} from '../lib/annotationStyle'
import { isTextObject } from '../lib/tools'
import { toHexColor } from '../lib/color'
import { useTranslation } from '../i18n'
import type { FontFamily, Settings, Tool } from '../types'

const INK_COLORS = ['#111827', '#dc2626', '#ea580c', '#16a34a', '#2563eb', '#7c3aed', '#db2777', '#ffffff']
const HIGHLIGHT_COLORS = ['#facc15', '#4ade80', '#60a5fa', '#f472b6', '#fb923c']
const WHITEOUT_COLORS = ['#ffffff', '#000000', '#111827', '#dc2626', '#ea580c', '#16a34a', '#2563eb', '#7c3aed', '#db2777']

const TOOL_LABEL_KEY: Record<Tool, string> = {
  select: 'tools.select',
  text: 'tools.text',
  textedit: 'tools.textedit',
  pen: 'tools.pen',
  highlighter: 'tools.highlighter',
  rect: 'tools.rect',
  ellipse: 'tools.ellipse',
  line: 'tools.line',
  arrow: 'tools.arrow',
  whiteout: 'tools.whiteoutShort',
  image: 'tools.image',
  signature: 'tools.signature',
  eraser: 'tools.eraserShort',
}

const COLOR_TOOLS: Tool[] = ['pen', 'text', 'rect', 'ellipse', 'line', 'arrow']
const WIDTH_TOOLS: Tool[] = ['pen', 'rect', 'ellipse', 'line', 'arrow']

function Swatches({
  value,
  colors,
  onChange,
}: {
  value: string
  colors: string[]
  onChange: (color: string) => void
}) {
  const { t } = useTranslation()
  const current = toHexColor(value).toLowerCase()
  return (
    <div className="swatches">
      {colors.map((color) => (
        <button
          key={color}
          type="button"
          className={`swatch ${current === color.toLowerCase() ? 'is-active' : ''}`}
          style={{ background: color }}
          title={color}
          onClick={() => onChange(color)}
        />
      ))}
      <label className="swatch swatch-custom" title={t('options.customColor')}>
        <input type="color" value={toHexColor(value)} onChange={(event) => onChange(event.target.value)} />
      </label>
    </div>
  )
}

export function ToolOptions() {
  const { t } = useTranslation()
  const tool = useStore((state) => state.tool)
  const settings = useStore((state) => state.settings)
  const updateSettings = useStore((state) => state.updateSettings)
  const selectionNonce = useStore((state) => state.selectionNonce)

  // Selecting any result shows the options of the tool that produced it and
  // edits the selection in place — covers, shapes, arrows, drawings and text
  // alike. The select tool stays active so the object keeps its move/resize
  // handles.
  const selection = useMemo(
    () => activeSelection(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, selectionNonce],
  )
  const selectedObjects = selection?.objects ?? []
  const textObjects = useMemo(
    () => selectedObjects.filter(isTextObject),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, selectionNonce],
  )
  const styledText = textObjects.length > 0
  const selectionTool = useMemo<Tool | null>(() => {
    for (const object of selectedObjects) {
      const mapped = annotationToolOf(object)
      if (mapped) return mapped
    }
    return null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, selectionNonce])

  const panelTool: Tool = tool === 'select' ? (styledText ? 'text' : selectionTool ?? 'select') : tool
  const showTextStyle = panelTool === 'text' || panelTool === 'textedit'
  // Restyling the selection only happens with the select tool; with a drawing
  // tool active the same controls edit the defaults for the next result.
  const editingSelection = Boolean(tool === 'select' && selection && !showTextStyle)
  const stylingSelection = editingSelection || (showTextStyle && styledText)
  const style: AnnotationStyle = editingSelection ? readAnnotationStyle(selectedObjects) : {}

  const textObject = styledText ? (textObjects[0] as FabricObject & Record<string, any>) : undefined
  const color = textObject ? toHexColor(String(textObject.fill ?? ''), settings.color) : style.color ?? settings.color
  const fontFamily: FontFamily = textObject ? textFontFamily(textObject) : settings.fontFamily
  const fontSize = textObject ? Math.round(Number(textObject.fontSize) || settings.fontSize) : settings.fontSize
  const highlightColor = style.color ?? settings.highlightColor
  const highlightWidth = style.width ?? settings.highlightWidth
  const whiteoutColor = style.color ?? settings.whiteoutColor

  const applyTextStyle = (patch: TextStylePatch) => {
    if (showTextStyle && textObjects.length) {
      const state = useStore.getState()
      state.beginChange()
      for (const object of textObjects) styleTextObject(object, patch)
      if (selection) commitCanvasObject(selection.canvas)
      state.notifySelectionChange()
    }
    updateSettings(patch)
  }

  const applyAnnotationStyle = (patch: AnnotationStylePatch) => {
    if (editingSelection && selection) {
      const state = useStore.getState()
      state.beginChange()
      styleAnnotationObjects(selection.canvas, selectedObjects, patch)
      commitCanvasObject(selection.canvas)
      state.notifySelectionChange()
    }
    const settingsPatch: Partial<Settings> = {}
    if (panelTool === 'highlighter') {
      if (patch.color !== undefined) settingsPatch.highlightColor = patch.color
      if (patch.width !== undefined) settingsPatch.highlightWidth = patch.width
    } else if (panelTool === 'whiteout') {
      if (patch.color !== undefined) settingsPatch.whiteoutColor = patch.color
    } else {
      if (patch.color !== undefined) settingsPatch.color = patch.color
      if (patch.width !== undefined) settingsPatch.strokeWidth = patch.width
    }
    updateSettings(settingsPatch)
  }

  const applyColor = (value: string) => {
    if (showTextStyle) applyTextStyle({ color: value })
    else applyAnnotationStyle({ color: value })
  }

  return (
    <div className="options">
      <span className="options-title">{t(TOOL_LABEL_KEY[panelTool])}</span>

      {(COLOR_TOOLS.includes(panelTool) || showTextStyle) && (
        <>
          <span className="options-label">{t('options.color')}</span>
          <Swatches value={color} colors={INK_COLORS} onChange={applyColor} />
        </>
      )}

      {WIDTH_TOOLS.includes(panelTool) && (
        <>
          <span className="options-label">{t('options.width')}</span>
          <input
            className="slider"
            type="range"
            min={1}
            max={24}
            step={0.5}
            value={style.width ?? settings.strokeWidth}
            onChange={(event) => applyAnnotationStyle({ width: Number(event.target.value) })}
          />
          <span className="options-value">{style.width ?? settings.strokeWidth}pt</span>
        </>
      )}

      {showTextStyle && (
        <>
          <span className="options-label">{t('options.font')}</span>
          <select
            className="select"
            value={fontFamily}
            onChange={(event) => applyTextStyle({ fontFamily: event.target.value as FontFamily })}
          >
            <option value="Helvetica">Helvetica</option>
            <option value="Times New Roman">Times New Roman</option>
            <option value="Courier New">Courier New</option>
          </select>
          <input
            className="slider slider-size"
            type="range"
            min={8}
            max={72}
            step={1}
            value={fontSize}
            onChange={(event) => applyTextStyle({ fontSize: Number(event.target.value) })}
          />
          <span className="options-value">{fontSize}pt</span>
        </>
      )}

      {panelTool === 'highlighter' && (
        <>
          <span className="options-label">{t('options.color')}</span>
          <Swatches
            value={highlightColor}
            colors={HIGHLIGHT_COLORS}
            onChange={(color) => applyAnnotationStyle({ color })}
          />
          <span className="options-label">{t('options.width')}</span>
          <input
            className="slider"
            type="range"
            min={6}
            max={40}
            step={1}
            value={highlightWidth}
            onChange={(event) => applyAnnotationStyle({ width: Number(event.target.value) })}
          />
          <span className="options-value">{highlightWidth}pt</span>
        </>
      )}

      {panelTool === 'select' && (
        <>
          <button
            type="button"
            className="button button-ghost"
            onClick={() => {
              const canvas = activeCanvas()
              if (canvas) deleteSelection(canvas)
            }}
          >
            <Trash2 size={15} /> {t('options.deleteSelected')}
          </button>
          <button
            type="button"
            className="button button-ghost"
            onClick={() => {
              const state = useStore.getState()
              const canvas = getCanvas(state.currentPageId)
              if (!canvas) return
              state.beginChange()
              canvas.remove(...canvas.getObjects())
              canvas.discardActiveObject()
              canvas.requestRenderAll()
              if (state.currentPageId) commitCanvas(state.currentPageId)
            }}
          >
            <X size={15} /> {t('options.clearPage')}
          </button>
          <span className="options-hint">{t('options.selectHint')}</span>
        </>
      )}

      {stylingSelection && panelTool !== 'select' && (
        <button
          type="button"
          className="button button-ghost"
          onClick={() => {
            if (selection) deleteSelection(selection.canvas)
          }}
        >
          <Trash2 size={15} /> {t('options.deleteSelected')}
        </button>
      )}

      {panelTool === 'whiteout' && (
        <>
          <span className="options-label">{t('options.color')}</span>
          <Swatches
            value={whiteoutColor}
            colors={WHITEOUT_COLORS}
            onChange={(color) => applyAnnotationStyle({ color })}
          />
          <span className="options-hint">
            {editingSelection ? t('options.selectionHint') : t('options.whiteoutHint')}
          </span>
        </>
      )}

      {panelTool === 'textedit' && !showTextStyle && <span className="options-hint">{t('options.texteditHint')}</span>}

      {panelTool === 'eraser' && <span className="options-hint">{t('options.eraserHint')}</span>}

      {panelTool === 'image' && (
        <span className="options-hint">
          {editingSelection ? t('options.selectionHint') : t('options.imageHint')}
        </span>
      )}

      {panelTool === 'signature' && <span className="options-hint">{t('options.signatureHint')}</span>}
    </div>
  )
}
