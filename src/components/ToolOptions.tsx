import { Trash2, X } from 'lucide-react'
import { useStore } from '../store'
import { activeCanvas, commitCanvas, deleteSelection, getCanvas } from '../lib/canvasRegistry'
import { toHexColor } from '../lib/color'
import type { Tool } from '../types'

const INK_COLORS = ['#111827', '#dc2626', '#ea580c', '#16a34a', '#2563eb', '#7c3aed', '#db2777', '#ffffff']
const HIGHLIGHT_COLORS = ['#facc15', '#4ade80', '#60a5fa', '#f472b6', '#fb923c']

const TOOL_LABEL: Record<Tool, string> = {
  select: 'Select',
  text: 'Text',
  pen: 'Draw',
  highlighter: 'Highlight',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  whiteout: 'Cover',
  image: 'Image',
  signature: 'Signature',
  eraser: 'Erase',
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
      <label className="swatch swatch-custom" title="Custom color">
        <input type="color" value={toHexColor(value)} onChange={(event) => onChange(event.target.value)} />
      </label>
    </div>
  )
}

export function ToolOptions() {
  const tool = useStore((state) => state.tool)
  const settings = useStore((state) => state.settings)
  const updateSettings = useStore((state) => state.updateSettings)

  return (
    <div className="options">
      <span className="options-title">{TOOL_LABEL[tool]}</span>

      {COLOR_TOOLS.includes(tool) && (
        <>
          <span className="options-label">Color</span>
          <Swatches value={settings.color} colors={INK_COLORS} onChange={(color) => updateSettings({ color })} />
        </>
      )}

      {WIDTH_TOOLS.includes(tool) && (
        <>
          <span className="options-label">Width</span>
          <input
            className="slider"
            type="range"
            min={1}
            max={24}
            step={0.5}
            value={settings.strokeWidth}
            onChange={(event) => updateSettings({ strokeWidth: Number(event.target.value) })}
          />
          <span className="options-value">{settings.strokeWidth}pt</span>
        </>
      )}

      {tool === 'text' && (
        <>
          <span className="options-label">Font</span>
          <select
            className="select"
            value={settings.fontFamily}
            onChange={(event) => updateSettings({ fontFamily: event.target.value as typeof settings.fontFamily })}
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
            value={settings.fontSize}
            onChange={(event) => updateSettings({ fontSize: Number(event.target.value) })}
          />
          <span className="options-value">{settings.fontSize}pt</span>
        </>
      )}

      {tool === 'highlighter' && (
        <>
          <span className="options-label">Color</span>
          <Swatches
            value={settings.highlightColor}
            colors={HIGHLIGHT_COLORS}
            onChange={(highlightColor) => updateSettings({ highlightColor })}
          />
          <span className="options-label">Width</span>
          <input
            className="slider"
            type="range"
            min={6}
            max={40}
            step={1}
            value={settings.highlightWidth}
            onChange={(event) => updateSettings({ highlightWidth: Number(event.target.value) })}
          />
          <span className="options-value">{settings.highlightWidth}pt</span>
        </>
      )}

      {tool === 'select' && (
        <>
          <button
            type="button"
            className="button button-ghost"
            onClick={() => {
              const canvas = activeCanvas()
              if (canvas) deleteSelection(canvas)
            }}
          >
            <Trash2 size={15} /> Delete selected
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
            <X size={15} /> Clear page
          </button>
          <span className="options-hint">Click to select · Shift-click for multiple · drag handles to resize</span>
        </>
      )}

      {tool === 'whiteout' && (
        <span className="options-hint">
          Drag over existing content to cover it, then add text on top.
        </span>
      )}

      {tool === 'eraser' && <span className="options-hint">Click any annotation to remove it.</span>}

      {tool === 'image' && <span className="options-hint">Pick an image file to place it on the current page.</span>}

      {tool === 'signature' && <span className="options-hint">Draw your signature in the dialog.</span>}
    </div>
  )
}
