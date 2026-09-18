import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useStore } from './store'
import { getCanvas } from './lib/canvasRegistry'
import { serializeCanvas } from './lib/serialize'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')

if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__realpdf = { useStore, getCanvas, serializeCanvas }
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
