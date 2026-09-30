import { useCallback, type RefCallback } from 'react'

/**
 * Glides a container's `.active-indicator` to its `.is-active` child. It writes
 * that child's box as --indicator-x/-y/-w/-h on the container, and CSS draws it.
 *
 * A callback ref, so it also works for containers that mount after their
 * component (a modal body rendered only while open); a new `activeKey`
 * re-attaches it, which re-measures. `data-indicator` goes from absent to
 * 'placed' to 'ready', and transitions exist only once 'ready', so the first
 * placement never slides in from the corner.
 */
export function useActiveIndicator<T extends HTMLElement>(activeKey: unknown): RefCallback<T> {
  return useCallback(
    (container: T | null) => {
      if (!container) return
      let frame = 0
      const measure = () => {
        const active = container.querySelector<HTMLElement>(':scope > .is-active')
        // Hidden with display: none, or not laid out against this container.
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
        // Two frames, so the placed position paints before transitions switch on.
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
      // Items added, removed or reordered move the active one without resizing anything.
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
