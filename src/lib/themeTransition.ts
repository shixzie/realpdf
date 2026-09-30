import { flushSync } from 'react-dom'
import { useStore } from '../store'
import { prefersReducedMotion } from './motion'

export function toggleThemeFrom(origin: HTMLElement): void {
  const toggle = () => useStore.getState().toggleTheme()
  if (typeof document.startViewTransition !== 'function' || prefersReducedMotion()) {
    toggle()
    return
  }
  const box = origin.getBoundingClientRect()
  const x = box.left + box.width / 2
  const y = box.top + box.height / 2
  const root = document.documentElement.style
  root.setProperty('--reveal-x', `${x}px`)
  root.setProperty('--reveal-y', `${y}px`)
  root.setProperty('--reveal-r', `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`)
  document.startViewTransition(() => flushSync(toggle))
}
