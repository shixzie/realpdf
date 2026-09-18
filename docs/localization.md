# Localization

RealPDF ships with a small dependency-free i18n layer. English is the source
dictionary; Spanish, French and German ship as examples. Adding another
language does not require touching any component.

## How it works

| Piece | Where | What it does |
| --- | --- | --- |
| Dictionaries | `src/i18n/locales/*.ts` | One typed file per language |
| Registry | `src/i18n/index.ts` | The only place languages are listed |
| Runtime | `src/i18n/index.ts` | Detection, persistence, `t()`, plurals, React hook |
| Picker | `src/components/LanguagePicker.tsx` | Select in the top bar |

- **Detection**: a stored choice (`localStorage: realpdf-locale`) wins, then
  `navigator.languages` is matched exactly, by base language, then by regional
  variant; English is the fallback.
- **Persistence**: selecting a language stores it and updates `<html lang>`,
  `<html dir>`, the document title and the meta description immediately.
- **Reactivity**: components call `useTranslation()`, which subscribes to the
  locale store, so switching languages re-renders the whole UI. Code outside
  React (stores, controllers, error messages) imports `t` directly.
- **Missing keys** fall back to English and then to the key itself, so a
  partially translated locale never breaks the UI. Dev builds log a warning
  for missing keys.

## Adding a language

1. Copy `src/i18n/locales/en.ts` to `src/i18n/locales/<code>.ts` and translate
   the values. Keep the object shape; `npm run typecheck` fails if a key is
   missing or misspelled.
2. Import it and list it in the `locales` registry in `src/i18n/index.ts`:

   ```ts
   import { ptBR } from './locales/pt-BR'

   export const locales = {
     en: { name: 'English', dir: 'ltr', messages: en },
     es: { name: 'Español', dir: 'ltr', messages: es },
     ptBR: { name: 'Português (Brasil)', dir: 'ltr', messages: ptBR },
   } satisfies Record<string, LocaleDefinition>
   ```

   `name` is shown in the language picker, so use the language's own name.
   Set `dir: 'rtl'` for right-to-left languages (the layout follows
   `<html dir>` automatically).

3. Run `npm run typecheck`. That's it — detection, the picker, formatting and
   persistence pick the new locale up automatically.

The browser language tag `pt-BR` maps to the registry key `ptBR` by
normalizing case and separators (`pt-br` → exact match; `pt` → base match).

## Using strings

Inside a component:

```tsx
import { useTranslation } from '../i18n'

export function Example() {
  const { t } = useTranslation()
  return <button title={t('topbar.toolsTitle')}>{t('topbar.tools')}</button>
}
```

Outside React (stores, controllers, thrown errors):

```ts
import { t } from '../i18n'
useStore.getState().toastMessage('error', t('toasts.addImageFailed'))
```

### Interpolation

Values in `{braces}` are replaced from the second argument:

```ts
t('toasts.loaded', { fileName: 'report.pdf' }) // "Loaded report.pdf"
```

### Plurals

Keys can define `_one` / `_other` variants; pass `count` and the right form is
selected with `Intl.PluralRules` for the active locale:

```ts
t('common.pages', { count: 1 }) // "1 page"
t('common.pages', { count: 3 }) // "3 pages"
```

Resolution order is `key_<category>` → `key_other` → `key`, so a locale can
omit plural variants and fall back to the English form. Languages with more
categories (Russian `_few` / `_many`, Arabic `_zero` / `_two`, …) can add those
keys; the runtime already looks them up. Since `Dictionary` mirrors English,
type such a file with a cast or an intersection if TypeScript rejects the
extra keys.

### Numbers, dates and bytes

Use the helpers instead of `toFixed` / `toLocaleDateString` so decimals,
grouping and dates follow the locale:

```ts
import { formatBytes, formatDate, formatNumber } from '../i18n'
```

## Translating carefully

- Keep placeholders exactly as-is (`{count}`, `{fileName}`, …) — they are
  replaced at runtime.
- Keep the `→` arrows and `·` separators; they are layout, not language.
- Tool names double as keyboard-shortcut tooltips (`Signature (S)`), so keep
  them short.
- Strings that the end-to-end tests assert on (see `scripts/e2e-ui.mjs`) are
  the English ones only; other locales can be phrased freely.
- `index.html` only carries the English fallback `<title>`/description and the
  pre-paint `<html lang>` guess; everything else is set by `initLocale()`.
