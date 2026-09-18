import { subscribeLocale, t } from '../i18n'

interface KofiWidgetOverlay {
  draw: (user: string, config: Record<string, string>) => void
}

declare global {
  interface Window {
    kofiWidgetOverlay?: KofiWidgetOverlay
  }
}

const KOFI_USER = 'shixzie'

/**
 * The Ko-fi overlay widget lives in an iframe drawn with a static config, so
 * it has to be redrawn when the locale changes. The script tag itself stays in
 * index.html; this only configures it (and no-ops if it did not load).
 */
export function initKofiWidget(): void {
  const draw = () => {
    window.kofiWidgetOverlay?.draw(KOFI_USER, {
      type: 'floating-chat',
      'floating-chat.donateButton.text': t('kofi.text'),
      'floating-chat.donateButton.background-color': '#fcbf47',
      'floating-chat.donateButton.text-color': '#323842',
    })
  }
  draw()
  subscribeLocale(draw)
}
