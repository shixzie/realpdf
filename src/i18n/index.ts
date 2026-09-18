import { useSyncExternalStore } from 'react'
import { en, type Dictionary } from './locales/en'
import { es } from './locales/es'
import { fr } from './locales/fr'
import { de } from './locales/de'

export interface LocaleDefinition {
  /** Name of the language in the language itself, shown in the picker. */
  name: string
  /** Writing direction; add `rtl` locales without touching the app. */
  dir: 'ltr' | 'rtl'
  messages: Dictionary
}

/**
 * The locale registry. Adding a language is: create `locales/<code>.ts`,
 * import it here and list it below. Everything else is automatic.
 */
export const locales = {
  en: { name: 'English', dir: 'ltr', messages: en },
  es: { name: 'Español', dir: 'ltr', messages: es },
  fr: { name: 'Français', dir: 'ltr', messages: fr },
  de: { name: 'Deutsch', dir: 'ltr', messages: de },
} satisfies Record<string, LocaleDefinition>

export type Locale = keyof typeof locales

export const LOCALE_STORAGE_KEY = 'realpdf-locale'
const DEFAULT_LOCALE: Locale = 'en'

type Vars = Record<string, string | number>

function isLocale(value: string): value is Locale {
  return Object.prototype.hasOwnProperty.call(locales, value)
}

function matchLocale(tag: string): Locale | null {
  const normalized = tag.trim().toLowerCase()
  if (!normalized) return null
  const keys = Object.keys(locales) as Locale[]
  const exact = keys.find((key) => key.toLowerCase() === normalized)
  if (exact) return exact
  const base = normalized.split('-')[0]
  return keys.find((key) => key.toLowerCase() === base) ?? keys.find((key) => key.toLowerCase().startsWith(`${base}-`)) ?? null
}

/** Stored choice first, then the browser languages, then English. */
export function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (stored && isLocale(stored)) return stored
  } catch {
    // Storage can be unavailable in private modes; fall through to detection.
  }
  const candidates =
    typeof navigator !== 'undefined' ? [...(navigator.languages ?? []), navigator.language] : []
  for (const tag of candidates) {
    if (!tag) continue
    const match = matchLocale(tag)
    if (match) return match
  }
  return DEFAULT_LOCALE
}

let currentLocale: Locale = typeof window === 'undefined' ? DEFAULT_LOCALE : detectLocale()
const listeners = new Set<() => void>()

function lookup(messages: Dictionary, key: string): string | undefined {
  let node: unknown = messages
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : undefined
}

function pluralCandidates(key: string, count: number | undefined): string[] {
  if (typeof count !== 'number' || !Number.isFinite(count)) return [key]
  try {
    const category = new Intl.PluralRules(currentLocale).select(count)
    return [`${key}_${category}`, `${key}_other`, key]
  } catch {
    return [key]
  }
}

function interpolate(message: string, vars?: Vars): string {
  if (!vars) return message
  return message.replace(/\{(\w+)\}/g, (match, name: string) =>
    vars[name] === undefined ? match : String(vars[name]),
  )
}

/**
 * Translates a dot-path key with optional `{placeholder}` values. When
 * `vars.count` is a number, `key_one` / `key_other` is selected with the
 * locale's plural rules (falling back to `key` itself).
 */
export function t(key: string, vars?: Vars): string {
  const count = typeof vars?.count === 'number' ? vars.count : undefined
  const candidates = pluralCandidates(key, count)
  for (const messages of [locales[currentLocale].messages, locales[DEFAULT_LOCALE].messages]) {
    for (const candidate of candidates) {
      const message = lookup(messages, candidate)
      if (message !== undefined) return interpolate(message, vars)
    }
  }
  if (import.meta.env.DEV) console.warn(`[i18n] Missing translation for "${key}"`)
  return key
}

export function getLocale(): Locale {
  return currentLocale
}

export function getLocaleName(locale: Locale): string {
  return locales[locale].name
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function applyDocumentLocale(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.lang = currentLocale
  root.dir = locales[currentLocale].dir
  document.title = t('meta.title')
  const description = document.querySelector<HTMLMetaElement>('meta[name="description"]')
  if (description) description.content = t('meta.description')
}

export function setLocale(locale: Locale): void {
  if (!isLocale(locale) || locale === currentLocale) return
  currentLocale = locale
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Persisting is best-effort; the locale still applies for this session.
  }
  applyDocumentLocale()
  for (const listener of Array.from(listeners)) listener()
}

/** Applies language, direction and metadata for the detected locale. */
export function initLocale(): void {
  applyDocumentLocale()
}

/** Locale-aware number formatting (decimal separators, grouping, …). */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  try {
    return new Intl.NumberFormat(currentLocale, options).format(value)
  } catch {
    return String(value)
  }
}

export function formatDate(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleDateString(currentLocale)
  } catch {
    return new Date(timestamp).toLocaleDateString()
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${formatNumber(bytes)} B`
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, { maximumFractionDigits: 0 })} KB`
  return `${formatNumber(bytes / (1024 * 1024), { maximumFractionDigits: 1 })} MB`
}

/** Re-renders the calling component whenever the locale changes. */
export function useTranslation() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => DEFAULT_LOCALE)
  return { t, locale, setLocale, locales }
}
