import { createServer } from 'vite'
import { buildSamplePdf, ensureOutDir } from './helpers/fixtures.mjs'

/**
 * Generates shared fixtures once per run, then starts a Vite server unless the
 * caller points the suite at an existing one with APP_URL (for example a
 * production preview).
 */
export default async function setup() {
  ensureOutDir()
  await buildSamplePdf()

  if (process.env.APP_URL) return
  const server = await createServer({
    root: process.cwd(),
    logLevel: 'warn',
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const url = server.resolvedUrls?.local?.[0]
  if (!url) throw new Error('Vite did not report a local URL')
  process.env.APP_URL = url
  return async () => {
    await server.close()
  }
}
