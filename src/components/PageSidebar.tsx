import { useEffect, useRef, useState } from 'react'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import { useStore } from '../store'
import { useTranslation } from '../i18n'
import type { PageState } from '../types'

function Thumbnail({ page }: { page: PageState }) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pdf = useStore((state) => state.pdf)
  const [rendered, setRendered] = useState(false)

  useEffect(() => {
    const element = canvasRef.current
    if (!element) return
    const targetWidth = 132
    const scale = targetWidth / page.width
    element.style.width = `${Math.round(page.width * scale)}px`
    element.style.height = `${Math.round(page.height * scale)}px`
    if (page.sourceIndex == null || !pdf) {
      element.width = 2
      element.height = 2
      return
    }
    let cancelled = false
    let task: { cancel: () => void } | null = null
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        void (async () => {
          try {
            const pdfPage = await pdf.getPage((page.sourceIndex as number) + 1)
            if (cancelled) return
            const viewport = pdfPage.getViewport({ scale })
            element.width = Math.max(1, Math.floor(viewport.width))
            element.height = Math.max(1, Math.floor(viewport.height))
            const renderTask = pdfPage.render({ canvas: element, viewport })
            task = renderTask
            await renderTask.promise
            if (!cancelled) setRendered(true)
          } catch (error) {
            if ((error as Error)?.name !== 'RenderingCancelledException') console.error(error)
          }
        })()
      },
      { rootMargin: '300px' },
    )
    observer.observe(element)
    return () => {
      cancelled = true
      observer.disconnect()
      task?.cancel()
    }
  }, [pdf, page.sourceIndex, page.width, page.height])

  return (
    <div className="thumb-frame">
      <canvas ref={canvasRef} className="thumb-canvas" data-blank={page.sourceIndex == null || !rendered} />
      {page.sourceIndex == null && <span className="thumb-blank">{t('sidebar.blank')}</span>}
    </div>
  )
}

export function PageSidebar() {
  const { t } = useTranslation()
  const pages = useStore((state) => state.pages)
  const currentPageId = useStore((state) => state.currentPageId)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span>{t('sidebar.pages')}</span>
        <button
          type="button"
          className="icon-button"
          title={t('sidebar.addBlank')}
          onClick={() => {
            const state = useStore.getState()
            const index = Math.max(
              0,
              state.pages.findIndex((page) => page.id === state.currentPageId),
            )
            state.addBlankPage(index)
          }}
        >
          <Plus size={16} />
        </button>
      </div>
      <div className="sidebar-list">
        {pages.map((page, index) => {
          const active = page.id === currentPageId
          const count = page.annotations.objects.length
          return (
            <div
              key={page.id}
              className={`thumb ${active ? 'is-active' : ''} ${overIndex === index && dragIndex !== null && dragIndex !== index ? 'is-drop' : ''}`}
              draggable
              onDragStart={(event) => {
                setDragIndex(index)
                event.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(event) => {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setOverIndex(index)
              }}
              onDragEnd={() => {
                setDragIndex(null)
                setOverIndex(null)
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragIndex !== null && dragIndex !== index) useStore.getState().movePage(dragIndex, index)
                setDragIndex(null)
                setOverIndex(null)
              }}
              onClick={() => {
                useStore.getState().setCurrentPage(page.id)
                useStore.getState().requestScrollTo(page.id)
              }}
            >
              <div className="thumb-grip">
                <GripVertical size={14} />
              </div>
              <Thumbnail page={page} />
              <span className="thumb-index">{index + 1}</span>
              {count > 0 && <span className="thumb-badge">{count}</span>}
              <button
                type="button"
                className="thumb-delete"
                title={t('sidebar.deletePage')}
                onClick={(event) => {
                  event.stopPropagation()
                  useStore.getState().deletePage(page.id)
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
