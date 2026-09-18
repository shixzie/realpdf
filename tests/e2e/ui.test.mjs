/**
 * UI suite: light/dark theme, homepage tool cards, signature upload, the Ko-fi
 * button and the language picker.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { check, gotoHome, launchApp, openPdf } from '../helpers/app.mjs'
import { OUT_DIR, SAMPLE_PDF } from '../helpers/fixtures.mjs'

describe('ui', () => {
  let app

  beforeAll(async () => {
    app = await launchApp({ viewport: { width: 1500, height: 1000 } })
  })

  afterAll(async () => {
    await app?.browser.close()
  })

  it('themes, home cards, signature upload, ko-fi and localization', async () => {
    const { page, pageErrors } = app

    await gotoHome(page)

    // ------------------------------------------------------------ theme
    const initialTheme = await page.evaluate(() => document.documentElement.dataset.theme)
    check(initialTheme === 'dark' || initialTheme === 'light', `a theme is applied (${initialTheme})`)
    await page.click('button[aria-label="Toggle color theme"]')
    await page.waitForTimeout(300)
    const toggledTheme = await page.evaluate(() => document.documentElement.dataset.theme)
    check(toggledTheme !== initialTheme, `theme toggle switches (${initialTheme} → ${toggledTheme})`)
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    check(
      toggledTheme === 'light' ? background !== 'rgb(11, 15, 20)' : background === 'rgb(11, 15, 20)',
      `body background follows the theme (${background})`,
    )
    await page.screenshot({ path: path.join(OUT_DIR, 'home-light.png') })
    await page.click('button[aria-label="Toggle color theme"]')
    await page.waitForTimeout(200)

    // ------------------------------------------------- homepage tool cards
    check((await page.locator('.home-tool').count()) === 5, 'homepage shows five tool cards')
    const mergeCard = page.locator('.home-tool:has-text("Merge PDFs")')
    await mergeCard.click()
    await page.waitForSelector('.modal-wide')
    check(
      (await page.locator('.tab.is-active').innerText()).includes('Merge'),
      'Merge card opens the tools modal on the Merge tab',
    )
    await page.click('.modal-head .icon-button')
    await page.waitForTimeout(200)

    const splitCard = page.locator('.home-tool:has-text("Split PDF")')
    await splitCard.click()
    await openPdf(page, SAMPLE_PDF, { settle: 1000, resetZoom: false })
    await page.waitForSelector('.modal-wide', { timeout: 10000 })
    check(
      (await page.locator('.tab.is-active').innerText()).includes('Split'),
      'Split card opens the file picker, then the Split tab',
    )
    await page.click('.modal-head .icon-button')
    await page.waitForTimeout(200)

    // -------------------------------------------------- signature upload
    // A drawn-looking signature on a white background, as a photo would be.
    await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 420
      canvas.height = 160
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fdfdfb'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.strokeStyle = '#1a2740'
      ctx.lineWidth = 5
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(40, 110)
      ctx.bezierCurveTo(90, 30, 140, 150, 190, 70)
      ctx.bezierCurveTo(230, 20, 280, 140, 340, 80)
      ctx.stroke()
      window.__signatureDataUrl = canvas.toDataURL('image/png')
    })
    await page.click('.tool[title^="Signature"]')
    await page.waitForSelector('.signature-pad')
    check(
      (await page.locator('.segmented button:has-text("Upload image")').count()) === 1,
      'signature modal offers image upload',
    )
    await page.click('.segmented button:has-text("Upload image")')
    await page.waitForTimeout(200)
    const uploadBase64 = await page.evaluate(() => window.__signatureDataUrl.split(',')[1])
    const uploadPath = path.join(OUT_DIR, 'signature-upload.png')
    fs.writeFileSync(uploadPath, Buffer.from(uploadBase64, 'base64'))
    await page.setInputFiles('.signature-upload input[type="file"]', uploadPath)
    await page.waitForFunction(() => {
      const img = document.querySelector('.signature-preview')
      return Boolean(img && img.src.startsWith('data:image/png'))
    }, { timeout: 10000 })
    check(true, 'uploaded signature gets processed and previewed')
    await page.click('button:has-text("Add signature")')
    await page.waitForTimeout(900)
    const badge = await page.locator('.thumb-badge').first().innerText().catch(() => null)
    check(badge === '1', `uploaded signature inserted (page 1 annotation badge: ${badge})`)
    await page.click('button[title^="Undo"]')
    await page.waitForTimeout(400)

    // ------------------------------------------------------ kofi button
    const kofi = page.locator('a.button-kofi')
    check((await kofi.count()) === 1, 'Ko-fi support button is present next to Save PDF')
    check(
      (await kofi.getAttribute('href')) === 'https://ko-fi.com/shixzie',
      'Ko-fi button links to the support page',
    )
    const order = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('.topbar .button, .topbar .icon-button'))
      const labels = buttons.map((b) => (b.textContent || '').trim() || b.getAttribute('aria-label') || '')
      return labels
    })
    const kofiIndex = order.findIndex((label) => label.includes('Support'))
    const saveIndex = order.findIndex((label) => label.includes('Save PDF'))
    check(kofiIndex > -1 && saveIndex > -1 && kofiIndex < saveIndex, 'Ko-fi button sits beside (before) Save PDF')

    // -------------------------------------------------------- localization
    const languageSelect = page.locator('select.select-language')
    check((await languageSelect.count()) === 1, 'language picker is available in the top bar')
    await languageSelect.selectOption('es')
    await page.waitForTimeout(250)
    check((await page.locator('html').getAttribute('lang')) === 'es', 'html lang follows the selected locale')
    check(
      (await page.locator('button:has-text("Guardar PDF")').count()) === 1,
      'UI strings switch to Spanish',
    )
    check(
      (await page.locator('.tool[title^="Rectángulo"]').count()) === 1,
      'tool labels and tooltips are translated',
    )
    check((await page.title()).includes('editor de PDF local'), 'document title follows the locale')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.empty-card')
    check((await page.locator('html').getAttribute('lang')) === 'es', 'locale persists across reloads')
    check(
      (await page.locator('button:has-text("Elegir un PDF")').count()) === 1,
      'restored locale applies to the homepage',
    )

    await page.locator('select.select-language').selectOption('en')
    await page.waitForTimeout(250)
    check((await page.locator('html').getAttribute('lang')) === 'en', 'language can be switched back')
    check(
      (await page.locator('button:has-text("Choose a PDF")').count()) === 1,
      'English strings return',
    )

    check(pageErrors.length === 0, `no browser errors (${pageErrors.slice(0, 2).join(' | ')})`)
  })
})
