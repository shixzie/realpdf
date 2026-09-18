import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const PDFJS_DIRS = ['wasm', 'standard_fonts', 'cmaps', 'iccs'] as const

const MIME: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.icc': 'application/octet-stream',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
}

/**
 * Serves the pdf.js runtime assets (wasm decoders, standard fonts, CMaps, ICC
 * profiles) in dev and copies them into the build output. Everything stays
 * local — nothing is fetched from a CDN at runtime.
 */
function pdfjsAssets(): Plugin {
  const root = path.resolve('node_modules/pdfjs-dist')
  const prefix = '/pdfjs-assets/'
  return {
    name: 'realpdf:pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith(prefix)) return next()
        const rel = decodeURIComponent(req.url.slice(prefix.length).split('?')[0])
        const file = path.resolve(root, rel)
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          return next()
        }
        res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'public, max-age=3600')
        fs.createReadStream(file).pipe(res)
      })
    },
    closeBundle() {
      const outDir = path.resolve('dist/pdfjs-assets')
      fs.mkdirSync(outDir, { recursive: true })
      for (const dir of PDFJS_DIRS) {
        const from = path.join(root, dir)
        if (fs.existsSync(from)) fs.cpSync(from, path.join(outDir, dir), { recursive: true })
      }
    },
  }
}

export default defineConfig({
  // Deployed at the domain root (https://realpdf.app), so assets use absolute paths.
  base: '/',
  plugins: [react(), pdfjsAssets()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
})
