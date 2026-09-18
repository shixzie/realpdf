import { useStore } from '../store'
import type { FormWidget } from '../lib/forms'
import type { PageState } from '../types'

function initialValue(widget: FormWidget, value: unknown): unknown {
  if (value !== undefined) return value
  if (widget.type === 'checkbox') return Boolean(widget.defaultValue)
  if (widget.type === 'list') {
    if (Array.isArray(widget.defaultValue)) return widget.defaultValue
    if (typeof widget.defaultValue === 'string' && widget.defaultValue) return [widget.defaultValue]
    return []
  }
  return typeof widget.defaultValue === 'string' ? widget.defaultValue : ''
}

function Widget({ widget, zoom }: { widget: FormWidget; zoom: number }) {
  const stored = useStore((state) => state.formValues[widget.fieldName])
  const setFormValue = useStore((state) => state.setFormValue)
  const value = initialValue(widget, stored)
  const style = {
    left: widget.rect.x * zoom,
    top: widget.rect.y * zoom,
    width: Math.max(8, widget.rect.width * zoom),
    height: Math.max(8, widget.rect.height * zoom),
    fontSize: Math.max(8, Math.min(16, widget.rect.height * zoom * 0.62)),
  }
  const className = `form-widget ${stored !== undefined ? 'is-filled' : ''}`

  if (widget.type === 'text') {
    if (widget.multiLine) {
      return (
        <textarea
          className={className}
          style={style}
          value={String(value ?? '')}
          maxLength={widget.maxLength}
          disabled={widget.readOnly}
          onChange={(event) => setFormValue(widget.fieldName, event.target.value)}
        />
      )
    }
    return (
      <input
        className={className}
        style={style}
        value={String(value ?? '')}
        maxLength={widget.maxLength}
        disabled={widget.readOnly}
        onChange={(event) => setFormValue(widget.fieldName, event.target.value)}
      />
    )
  }

  if (widget.type === 'checkbox') {
    return (
      <input
        type="checkbox"
        className={`${className} form-widget-check`}
        style={{ ...style, width: style.height, height: style.height }}
        checked={Boolean(value)}
        disabled={widget.readOnly}
        onChange={(event) => setFormValue(widget.fieldName, event.target.checked)}
      />
    )
  }

  if (widget.type === 'radio') {
    return (
      <input
        type="radio"
        className={`${className} form-widget-check`}
        style={{ ...style, width: style.height, height: style.height }}
        name={`radio-${widget.fieldName}`}
        checked={value === widget.exportValue || Boolean(value) === true}
        disabled={widget.readOnly}
        onChange={() => setFormValue(widget.fieldName, widget.exportValue ?? '')}
      />
    )
  }

  if (widget.type === 'dropdown') {
    return (
      <select
        className={className}
        style={style}
        value={String(value ?? '')}
        disabled={widget.readOnly}
        onChange={(event) => setFormValue(widget.fieldName, event.target.value)}
      >
        <option value="">—</option>
        {widget.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    )
  }

  if (widget.type === 'list') {
    const selected = Array.isArray(value) ? (value as string[]) : []
    return (
      <select
        className={className}
        style={style}
        multiple
        value={selected}
        disabled={widget.readOnly}
        onChange={(event) =>
          setFormValue(widget.fieldName, Array.from(event.target.selectedOptions).map((option) => option.value))
        }
      >
        {widget.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    )
  }

  return null
}

export function FormsLayer({ page }: { page: PageState }) {
  const widgets = useStore((state) => state.formWidgets[page.id])
  const zoom = useStore((state) => state.zoom)
  if (!widgets || !widgets.length) return null
  return (
    <div className="forms-layer">
      {widgets.map((widget) => (
        <Widget key={widget.id} widget={widget} zoom={zoom} />
      ))}
    </div>
  )
}
