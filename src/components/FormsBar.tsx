import { Download, Loader2, X } from 'lucide-react'
import { useStore } from '../store'
import { runExport } from '../lib/exportController'
import { useTranslation } from '../i18n'

export function FormsBar() {
  const { t } = useTranslation()
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
      <span className="options-title">{t('forms.title')}</span>
      {formLoading ? (
        <span className="options-hint">
          <Loader2 size={14} className="spin" /> {t('forms.reading')}
        </span>
      ) : (
        <span className="options-hint">
          {t('forms.fields', { count: widgetCount, edited: filledCount })}
        </span>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={flatten}
          onChange={(event) => setFormFlatten(event.target.checked)}
        />
        {t('forms.flatten')}
      </label>
      <div className="topbar-spacer" />
      <button type="button" className="button button-primary" onClick={() => void runExport()}>
        <Download size={15} /> {t('forms.save')}
      </button>
      <button type="button" className="button" onClick={exitFormMode}>
        <X size={15} /> {t('forms.exit')}
      </button>
    </div>
  )
}
