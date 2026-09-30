import { useCallback, type RefCallback } from 'react'

export function useActiveIndicator<T extends HTMLElement>(activeKey: unknown): RefCallback<T> {
  return useCallback(
    (container: T | null) => {
      if (!container) return
      let frame = 0
      const measure = () => {
        const active = container.querySelector<HTMLElement>(':scope > .is-active')
        if (!active || active.offsetParent !== container) {
          cancelAnimationFrame(frame)
          frame = 0
          delete container.dataset.indicator
          return
        }
        container.style.setProperty('--indicator-x', `${active.offsetLeft}px`)
        container.style.setProperty('--indicator-y', `${active.offsetTop}px`)
        container.style.setProperty('--indicator-w', `${active.offsetWidth}px`)
        container.style.setProperty('--indicator-h', `${active.offsetHeight}px`)
        if (container.dataset.indicator === 'ready' || frame) return
        container.dataset.indicator = 'placed'
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            frame = 0
            container.dataset.indicator = 'ready'
          })
        })
      }
      const resize = new ResizeObserver(measure)
      const observeBoxes = () => {
        resize.disconnect()
        resize.observe(container)
        for (const child of container.children) resize.observe(child)
      }
      const mutations = new MutationObserver(() => {
        observeBoxes()
        measure()
      })
      measure()
      observeBoxes()
      mutations.observe(container, { childList: true })
      return () => {
        cancelAnimationFrame(frame)
        resize.disconnect()
        mutations.disconnect()
      }
    },
    [activeKey],
  )
}
