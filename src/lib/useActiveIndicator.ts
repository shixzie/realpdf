import { useCallback, useLayoutEffect, useRef, type RefCallback } from 'react'

export function useActiveIndicator(activeKey: unknown): RefCallback<HTMLElement> {
  const remeasure = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    remeasure.current?.()
  }, [activeKey])

  return useCallback((container: HTMLElement | null) => {
    const indicator = container?.querySelector<HTMLElement>(':scope > .active-indicator')
    if (!container || !indicator) return
    let frame = 0
    const measure = () => {
      const active = container.querySelector<HTMLElement>(':scope > .is-active')
      if (!active || active.offsetParent !== container) {
        cancelAnimationFrame(frame)
        frame = 0
        delete container.dataset.indicator
        return
      }
      indicator.style.setProperty('--indicator-x', `${active.offsetLeft}px`)
      indicator.style.setProperty('--indicator-y', `${active.offsetTop}px`)
      indicator.style.setProperty('--indicator-w', `${active.offsetWidth}px`)
      indicator.style.setProperty('--indicator-h', `${active.offsetHeight}px`)
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
    const observe = (node: Node) => {
      if (node instanceof Element && node !== indicator) resize.observe(node)
    }
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        record.removedNodes.forEach((node) => node instanceof Element && resize.unobserve(node))
        record.addedNodes.forEach(observe)
      }
      measure()
    })
    resize.observe(container)
    container.childNodes.forEach(observe)
    mutations.observe(container, { childList: true })
    measure()
    remeasure.current = measure
    return () => {
      remeasure.current = null
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
    }
  }, [])
}
