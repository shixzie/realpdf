import { Languages } from 'lucide-react'
import { useTranslation, type Locale } from '../i18n'

export function LanguagePicker() {
  const { t, locale, setLocale, locales } = useTranslation()
  return (
    <label className="language-picker" title={t('language.label')}>
      <Languages size={16} />
      <select
        className="select select-language"
        aria-label={t('language.label')}
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        {Object.entries(locales).map(([code, definition]) => (
          <option key={code} value={code}>
            {definition.name}
          </option>
        ))}
      </select>
    </label>
  )
}
