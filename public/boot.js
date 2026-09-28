// Runs before first paint (a classic script in index.html's <head>). It lives
// in its own file because the Content-Security-Policy allows no inline scripts.

// Apply the stored (or system) language and theme before first paint to
// avoid a flash of wrong-language/theme content. Translations live in
// src/i18n and are applied on boot (see initLocale in src/main.tsx).
;(function () {
  try {
    var stored = localStorage.getItem('realpdf-locale')
    document.documentElement.lang = stored || navigator.language || 'en'
  } catch (error) {
    document.documentElement.lang = 'en'
  }
})()

// Apply the stored (or system) theme before first paint to avoid flashes.
;(function () {
  try {
    var stored = localStorage.getItem('realpdf-theme')
    var theme =
      stored === 'light' || stored === 'dark'
        ? stored
        : window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
    document.documentElement.dataset.theme = theme
  } catch (error) {
    document.documentElement.dataset.theme = 'dark'
  }
})()
