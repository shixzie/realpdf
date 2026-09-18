import { Download, Loader2, X } from 'lucide-react'
import { useStore } from '../store'
import { runExport } from '../lib/exportController'

export function FormsBar() {
  const formLoading = useStore((state) => state.formLoading)
  const formWidgets = useStore((state) => state.formWidgets)
  const formValues = useStore((state) => state.formValues)
  const flatten = useStore((state) => state.formFlatten)
  const setFormFlatten = useStore((state) => state.setFormFlatten)
  const exitFormMode = useStore((state) => state.exitFormMode)

  const widgetCount = Object.values(formWidgets).reduce((sum, widgets) => sum + widgets.length, 0)
  const filledCount = Object.keys(formValues).length

  return (
    <div className="options forms-bar">
      <span className="options-title">Form filling</span>
      {formLoading ? (
        <span className="options-hint">
          <Loader2 size={14} className="spin" /> Reading fields…
        </span>
      ) : (
        <span className="options-hint">
          {widgetCount} field{widgetCount === 1 ? '' : 's'} · {filledCount} edited
        </span>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={flatten}
          onChange={(event) => setFormFlatten(event.target.checked)}
        />
        Flatten fields into the page when saving
      </label>
      <div className="topbar-spacer" />
      <button type="button" className="button button-primary" onClick={() => void runExport()}>
        <Download size={15} /> Save filled PDF
      </button>
      <button type="button" className="button" onClick={exitFormMode}>
        <X size={15} /> Exit
      </button>
    </div>
  )
}
